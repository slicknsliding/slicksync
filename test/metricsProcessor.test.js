const test = require('node:test')
const assert = require('node:assert/strict')
const { processLibraryItem } = require('../server/utils/metricsProcessor')

// Builds a fake prisma client that records what gets bundled into
// $transaction() vs called directly, without needing a real DB.
function makeMockPrisma({ latestSnapshotForToday = null, previousSnapshot = null, mostRecentActivity = null } = {}) {
  const calls = { transactions: [], accountFindFirst: 0 }
  return {
    calls,
    appAccount: {
      findFirst: async () => { calls.accountFindFirst++; return { sync: { accountTimezone: 'America/Los_Angeles' } } },
    },
    watchSnapshot: {
      findFirst: async (args) => {
        // getPreviousSnapshot() queries with date: { lte: ... }; the
        // "latest snapshot for today" lookup in processLibraryItem uses a
        // plain date value - distinguish by shape.
        if (args.where.date && typeof args.where.date === 'object' && 'lte' in args.where.date) {
          return previousSnapshot
        }
        return latestSnapshotForToday
      },
      upsert: (args) => ({ __op: 'watchSnapshot.upsert', args }),
    },
    watchActivity: {
      findFirst: async () => mostRecentActivity,
      create: (args) => ({ __op: 'watchActivity.create', args }),
    },
    $transaction: async (ops) => {
      calls.transactions.push(ops)
      return ops
    },
  }
}

function makeItem({ overallTimeWatchedMs, type = 'movie', lastWatched = new Date() } = {}) {
  return {
    _id: 'tt1234567',
    type,
    name: 'Test Item',
    state: {
      overallTimeWatched: overallTimeWatchedMs != null ? String(overallTimeWatchedMs) : undefined,
      timeOffset: undefined,
      lastWatched: lastWatched.toISOString(),
    },
  }
}

test('processLibraryItem: records the activity delta and advances the snapshot baseline in a single transaction', async () => {
  // Regression test for the duplicate-delta bug: these two writes used to
  // be two separate, independently-awaited prisma calls - if the process
  // was interrupted between them (a container restart mid-cycle), the
  // delta got recorded without the baseline advancing, so the next boot's
  // immediate poll recorded the exact same delta again. Confirmed with
  // real production data: the same item's delta appearing 2-3 times
  // identically. Both writes must now be bundled into one
  // prisma.$transaction() call so they can't land independently.
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: null } // 1,000,000ms baseline
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: priorSnapshot, mostRecentActivity: null })

  // Baseline was 1,000,000ms; current is 1,000,000ms + 120s (well over the
  // 60s recording threshold).
  const item = makeItem({ overallTimeWatchedMs: 1000000 + 120 * 1000 })

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(prisma.calls.transactions.length, 1, 'both writes should go through exactly one $transaction call')
  const ops = prisma.calls.transactions[0]
  const opTypes = ops.map((o) => o.__op).sort()
  assert.deepEqual(opTypes, ['watchActivity.create', 'watchSnapshot.upsert'], 'transaction should bundle both the activity delta and the snapshot baseline update')
  assert.equal(result.activityCreated, true)
  assert.equal(result.snapshotCreated, true)
})

test('processLibraryItem: a first-ever snapshot establishes the baseline with zero delta (no activity recorded)', async () => {
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: null, mostRecentActivity: null })
  const item = makeItem({ overallTimeWatchedMs: 5 * 60 * 60 * 1000 }) // 5 hours - would be a huge false delta if treated as incremental

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false, 'first-time items must not record their whole cumulative watch time as a single delta')
  assert.equal(result.snapshotCreated, true, 'the baseline should still be established')
  assert.equal(prisma.calls.transactions.length, 1)
  const ops = prisma.calls.transactions[0]
  assert.equal(ops.length, 1)
  assert.equal(ops[0].__op, 'watchSnapshot.upsert')
})

test('processLibraryItem: no delta when overallTimeWatched matches the existing baseline for today', async () => {
  // This is the exact "next poll cycle" scenario that must NOT re-record
  // anything once the baseline has already been advanced.
  const todaySnapshot = { overallTimeWatched: '1500000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: todaySnapshot, previousSnapshot: null, mostRecentActivity: null })
  const item = makeItem({ overallTimeWatchedMs: 1500000 }) // unchanged from the stored baseline

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false)
  assert.equal(result.snapshotCreated, false)
  assert.equal(prisma.calls.transactions.length, 0, 'nothing changed, so no writes at all should happen')
})

test('processLibraryItem: a short advance on a title that has gone quiet moves the baseline and records nothing', async () => {
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: priorSnapshot, mostRecentActivity: null })
  // 30s of new progress, last played an hour ago - nothing more is coming.
  const item = makeItem({ overallTimeWatchedMs: 1000000 + 30 * 1000, lastWatched: new Date(Date.now() - 60 * 60 * 1000) })

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false)
  assert.equal(result.snapshotCreated, true, 'the short tail is let go so the title is not re-examined on every pass')
  const ops = prisma.calls.transactions[0]
  assert.equal(ops.length, 1)
  assert.equal(ops[0].__op, 'watchSnapshot.upsert')
})

test('processLibraryItem: a short advance on a title still being played is carried to the next pass, not lost', async () => {
  // Progress that arrives in steps just under a minute used to move the
  // baseline each time and record nothing, so that viewing vanished.
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: priorSnapshot, mostRecentActivity: null })

  const first = await processLibraryItem(prisma, 'acct-1', 'user-1', makeItem({ overallTimeWatchedMs: 1000000 + 40 * 1000 }), new Date())
  assert.equal(first.activityCreated, false)
  assert.equal(first.snapshotCreated, false, 'the baseline stays where it was')
  assert.equal(prisma.calls.transactions.length, 0, 'nothing is written for an advance that is only being carried')

  // The next pass, another 40s on - measured from the same baseline.
  const second = await processLibraryItem(prisma, 'acct-1', 'user-1', makeItem({ overallTimeWatchedMs: 1000000 + 80 * 1000 }), new Date())
  assert.equal(second.activityCreated, true)
  assert.equal(second.snapshotCreated, true)
  const ops = prisma.calls.transactions[0]
  const activity = ops.find((o) => o.__op === 'watchActivity.create')
  assert.equal(activity.args.data.watchTimeSeconds, 80, 'both advances, in one entry')
  const snapshot = ops.find((o) => o.__op === 'watchSnapshot.upsert')
  assert.equal(snapshot.args.update.overallTimeWatched, String(1000000 + 80 * 1000))
})

test('processLibraryItem: a value that dropped and came back is not carried or recorded', async () => {
  // The stored high-water mark is above what the provider reports right now
  // (a profile fetch that failed and recovered). No progress, nothing held.
  const todaySnapshot = { overallTimeWatched: '2000000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: todaySnapshot, previousSnapshot: null, mostRecentActivity: null })
  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', makeItem({ overallTimeWatchedMs: 1500000 }), new Date())
  assert.equal(result.activityCreated, false)
  assert.equal(prisma.calls.transactions[0].some((o) => o.__op === 'watchActivity.create'), false)
})

// A Jellyfin server reports where playback IS - a seek or a "mark played"
// jumps it without anyone watching - so its items carry wallClockCapped and
// a jump adds no more than the real time between observations (+120s).
function makeJellyfinItem({ overallTimeWatchedMs, lastWatched }) {
  return {
    _id: 'tt7654321',
    type: 'movie',
    name: 'Jellyfin Item',
    state: { overallTimeWatched: String(overallTimeWatchedMs), timeOffset: String(overallTimeWatchedMs), lastWatched, wallClockCapped: true },
  }
}

test('processLibraryItem: a Jellyfin seek adds only the real time that passed, not the jump', async () => {
  const now = Date.now()
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: '1000000', lastWatched: new Date(now - 60 * 1000) }
  const prisma = makeMockPrisma({ latestSnapshotForToday: priorSnapshot, previousSnapshot: null, mostRecentActivity: null })
  // An hour further along a minute later.
  const item = makeJellyfinItem({ overallTimeWatchedMs: 1000000 + 60 * 60 * 1000, lastWatched: new Date(now).toISOString() })

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date(now))

  assert.equal(result.activityCreated, true)
  const activity = prisma.calls.transactions[0].find((o) => o.__op === 'watchActivity.create')
  assert.equal(activity.args.data.watchTimeSeconds, 60 + 120, 'capped at the minute that passed plus the pass allowance')
})

test('processLibraryItem: Jellyfin progress just under a minute is still recorded', async () => {
  const now = Date.now()
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: '1000000', lastWatched: new Date(now - 60 * 1000) }
  const prisma = makeMockPrisma({ latestSnapshotForToday: priorSnapshot, previousSnapshot: null, mostRecentActivity: null })
  const item = makeJellyfinItem({ overallTimeWatchedMs: 1000000 + 58 * 1000, lastWatched: new Date(now).toISOString() })

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date(now))

  assert.equal(result.activityCreated, true, 'a pass a few seconds short of 60 must not lose its viewing')
  const activity = prisma.calls.transactions[0].find((o) => o.__op === 'watchActivity.create')
  assert.equal(activity.args.data.watchTimeSeconds, 58)
})

// --- a title seen for the first time ---------------------------------------

function firstSeen(state) {
  return { _id: 'tt7654300', type: 'movie', name: 'New Film', state }
}
const HOUR = 60 * 60 * 1000

test('processLibraryItem: a new title played today counts where playback stands, up to its runtime', async () => {
  const prisma = makeMockPrisma()
  // First sighting, 26 minutes in, of a 98-minute film played a few minutes ago.
  const item = firstSeen({ overallTimeWatched: String(26 * 60000), timeOffset: String(26 * 60000), duration: String(98 * 60000), lastWatched: new Date(Date.now() - 5 * 60000).toISOString() })
  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())
  assert.equal(result.activityCreated, true)
  const activity = prisma.calls.transactions[0].find((o) => o.__op === 'watchActivity.create')
  assert.equal(activity.args.data.watchTimeSeconds, 26 * 60)
})

test('processLibraryItem: a new title never counts a lifetime figure, an old entry, or an unknown runtime', async () => {
  const cases = {
    // Hours of lifetime watching behind a series: only the position in this video counts.
    lifetime: [{ overallTimeWatched: String(16 * HOUR), timeOffset: String(10 * 60000), duration: String(45 * 60000), lastWatched: new Date().toISOString() }, 10 * 60],
    // A position past the runtime is held to the runtime.
    overRuntime: [{ overallTimeWatched: String(5 * HOUR), timeOffset: String(5 * HOUR), duration: String(90 * 60000), lastWatched: new Date().toISOString() }, 90 * 60],
    // Watched last week: nothing.
    old: [{ overallTimeWatched: String(60 * 60000), timeOffset: String(60 * 60000), duration: String(98 * 60000), lastWatched: new Date(Date.now() - 7 * 24 * HOUR).toISOString() }, null],
    // No runtime to bound it by: nothing.
    noRuntime: [{ overallTimeWatched: String(60 * 60000), timeOffset: String(60 * 60000), lastWatched: new Date().toISOString() }, null],
    // A server whose position can jump without anyone watching: nothing.
    jumpy: [{ overallTimeWatched: String(60 * 60000), timeOffset: String(60 * 60000), duration: String(98 * 60000), lastWatched: new Date().toISOString(), wallClockCapped: true }, null],
  }
  for (const [name, [state, want]] of Object.entries(cases)) {
    const prisma = makeMockPrisma()
    await processLibraryItem(prisma, 'acct-1', 'user-1', firstSeen(state), new Date())
    const activity = prisma.calls.transactions[0].find((o) => o.__op === 'watchActivity.create')
    assert.equal(activity ? activity.args.data.watchTimeSeconds : null, want, name)
    assert.ok(prisma.calls.transactions[0].some((o) => o.__op === 'watchSnapshot.upsert'), `${name}: the baseline is still set`)
  }
})

// --- progress carried over from somewhere else -------------------------------

// The Nov 15 2026 case: Nuvio's Main Profile sat at 7m22s for The Odyssey
// since September; two minutes after the AIOStreams sign-in reached 1h59m51s,
// Nuvio showed 1h59m13s, and the 1h52m jump was booked a second time.
const ODYSSEY = 'tt33764258'
const RUNTIME_MS = 10355744

function nuvioItem(positionMs, { videoId = ODYSSEY, lastWatched = new Date() } = {}) {
  return { _id: ODYSSEY, type: 'movie', name: 'The Odyssey', state: { overallTimeWatched: String(positionMs), timeOffset: String(positionMs), timeWatched: 0, duration: String(RUNTIME_MS), video_id: videoId, lastWatched: lastWatched.toISOString(), nuvioProfile: 'Main Profile' } }
}

// The mock's snapshot table: this sign-in's own high-water mark for
// getMaxSeen, and other sign-ins' rows for the carried-over lookup.
function withSnapshots(prisma, { own = [], others = [], fail = false } = {}) {
  prisma.calls.othersLookups = 0
  prisma.watchSnapshot.findMany = async (args) => {
    if (typeof args.where.userId === 'string') return own
    prisma.calls.othersLookups++
    if (fail) throw new Error('database unavailable')
    return others.filter((r) => r.userId !== args.where.userId.not)
  }
  return prisma
}

function booked(prisma) {
  const activity = prisma.calls.transactions[0]?.find((o) => o.__op === 'watchActivity.create')
  return activity ? activity.args.data.watchTimeSeconds : null
}

function nuvioJump(others, { from = 442280, to = 7153280, item, fail } = {}) {
  const prior = { overallTimeWatched: String(from), timeOffset: String(from), videoId: ODYSSEY, lastWatched: new Date('2026-09-06T02:31:58Z') }
  const prisma = withSnapshots(makeMockPrisma({ previousSnapshot: prior }), { own: [prior], others, fail })
  return { prisma, run: () => processLibraryItem(prisma, 'acct-1', 'nuvio-user', item || nuvioItem(to), new Date()) }
}

test('processLibraryItem: a jump onto the spot another sign-in just reached is not counted again', async () => {
  const aio = { userId: 'aio-user', videoId: ODYSSEY, timeOffset: '7191758', overallTimeWatched: '7191758', timeWatched: null }
  const { prisma, run } = nuvioJump([aio])
  await run()
  assert.equal(booked(prisma), null, 'the carried-over 1h52m books nothing')
  assert.ok(prisma.calls.transactions[0].some((o) => o.__op === 'watchSnapshot.upsert'), 'the baseline moves to the carried spot')
})

test('processLibraryItem: what is played after a carried-over resume point still counts', async () => {
  // Next pass: Nuvio went on from 1h59m13s to 2h29m21s; the other sign-in stayed put.
  const aio = { userId: 'aio-user', videoId: ODYSSEY, timeOffset: '7191758', overallTimeWatched: '7191758', timeWatched: null }
  const { prisma, run } = nuvioJump([aio], { from: 7153280, to: 8961384 })
  await run()
  assert.equal(booked(prisma), 1808)
})

test('processLibraryItem: a jump is counted when no other sign-in is at that spot', async () => {
  const cases = {
    nobody: [],
    // Another sign-in somewhere else in the film.
    elsewhere: [{ userId: 'aio-user', videoId: ODYSSEY, timeOffset: String(7153280 - 5 * 60000), overallTimeWatched: String(7153280 - 5 * 60000) }],
    // The same spot in another episode.
    otherVideo: [{ userId: 'aio-user', videoId: 'tt0000001:1:2', timeOffset: '7153280', overallTimeWatched: '7153280' }],
    // A Stremio lifetime figure that happens to be close is not a position.
    lifetime: [{ userId: 'stremio-user', videoId: ODYSSEY, timeOffset: '60000', overallTimeWatched: '7153000', timeWatched: '60000' }],
    // The sign-in's own older row is not someone else's.
    own: [{ userId: 'nuvio-user', videoId: ODYSSEY, timeOffset: '7153280', overallTimeWatched: '7153280' }],
  }
  for (const [name, others] of Object.entries(cases)) {
    const { prisma, run } = nuvioJump(others)
    await run()
    assert.equal(booked(prisma), 6711, name)
  }
})

test('processLibraryItem: finishing, short advances and failures are never treated as carried over', async () => {
  // Two people finishing the same film both end at the runtime.
  const atEnd = { userId: 'aio-user', videoId: ODYSSEY, timeOffset: String(RUNTIME_MS), overallTimeWatched: String(RUNTIME_MS) }
  let t = nuvioJump([atEnd], { from: 8966494, to: RUNTIME_MS })
  await t.run()
  assert.equal(booked(t.prisma), 1389, 'finishing counts')

  // Under ten minutes: not even looked up.
  const near = { userId: 'aio-user', videoId: ODYSSEY, timeOffset: String(442280 + 5 * 60000), overallTimeWatched: String(442280 + 5 * 60000) }
  t = nuvioJump([near], { to: 442280 + 5 * 60000 })
  await t.run()
  assert.equal(booked(t.prisma), 300)
  assert.equal(t.prisma.calls.othersLookups, 0)

  // No runtime to tell the end from the middle: counted.
  const noRuntime = nuvioItem(7153280)
  delete noRuntime.state.duration
  t = nuvioJump([{ userId: 'aio-user', videoId: ODYSSEY, timeOffset: '7191758' }], { item: noRuntime })
  await t.run()
  assert.equal(booked(t.prisma), 6711)

  // The lookup failing reads as "not carried".
  t = nuvioJump([], { fail: true })
  await t.run()
  assert.equal(booked(t.prisma), 6711)
})

test('processLibraryItem: a first sighting on another sign-in\'s spot is not counted', async () => {
  const prisma = withSnapshots(makeMockPrisma(), { others: [{ userId: 'aio-user', videoId: null, timeOffset: '3600000', overallTimeWatched: '3600000' }] })
  const item = nuvioItem(3600000 + 20000)
  await processLibraryItem(prisma, 'acct-1', 'nuvio-user', item, new Date())
  assert.equal(booked(prisma), null)
  assert.ok(prisma.calls.transactions[0].some((o) => o.__op === 'watchSnapshot.upsert'))
})

test('processLibraryItem: a resume point SlickSync wrote itself is not counted', async () => {
  const ownWrites = require('../server/utils/ownWrites')
  const lastWatched = new Date()
  ownWrites.note('nuvio-user', [{ id: ODYSSEY, lastWatched: lastWatched.toISOString(), position: 7153280 }])
  try {
    const { prisma, run } = nuvioJump([], { item: nuvioItem(7153280, { lastWatched }) })
    await run()
    assert.equal(booked(prisma), null)
    // Once it is played, the item no longer looks as written and counts again.
    const later = nuvioJump([], { from: 7153280, to: 8961384, item: nuvioItem(8961384, { lastWatched: new Date(lastWatched.getTime() + 1800000) }) })
    await later.run()
    assert.equal(booked(later.prisma), 1808)
  } finally {
    ownWrites.forget()
  }
})

test('processLibraryItem: a copy into a merged person\'s absorbed login is not counted either', async () => {
  // AIOSync notes the write under the person; the absorbed login keeps its own baselines.
  const ownWrites = require('../server/utils/ownWrites')
  const lastWatched = new Date()
  ownWrites.note('person-1', [{ id: ODYSSEY, lastWatched: lastWatched.toISOString(), position: 7153280 }])
  try {
    const prior = { overallTimeWatched: '442280', timeOffset: '442280', videoId: ODYSSEY }
    const prisma = withSnapshots(makeMockPrisma({ previousSnapshot: prior }), { own: [prior] })
    await processLibraryItem(prisma, 'acct-1', 'absorbed-cred-1', nuvioItem(7153280, { lastWatched }), new Date(), [], { recordUserId: 'person-1' })
    assert.equal(booked(prisma), null)
  } finally {
    ownWrites.forget()
  }
})
