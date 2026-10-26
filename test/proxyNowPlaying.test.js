const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')

function makeProxyRow(overrides = {}) {
  return {
    id: 'proxy-1',
    aiostreamsUser: 'alice',
    filename: 'The.Rock.1996.mkv',
    displayName: 'The Rock (1996)',
    posterUrl: null,
    url: 'https://example.com/stream',
    startTime: new Date('2026-07-15T20:00:00Z'),
    lastSeenAt: new Date('2026-07-15T20:05:00Z'),
    // The freeze basis for elapsedSeconds - the last poll cycle that
    // reconfirmed this connection with AIOStreams, which is updatedAt rather
    // than lastSeenAt (see the long comment in proxyNowPlaying.js). Omitting
    // it made every fixture blow up on `undefined.getTime()`, because the
    // code has required it since it started freezing elapsed time on poll
    // confirmation instead of request cadence.
    updatedAt: new Date('2026-07-15T20:05:00Z'),
    ...overrides,
  }
}

test('mergeProxyNowPlaying: a stale/unrelated active proxy row does not suppress a different-title native entry for the same user (usenet regression)', async () => {
  // This is the exact bug reported: a user streaming a usenet-sourced show
  // (never routed through AIOStreams' proxy) had their legitimate native
  // Now Playing entry silently dropped whenever ANY active proxy row -
  // even a stale/unrelated debrid one - was attributed to them.
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const nativeChernobylEntry = {
    user: { id: 'user-1', username: 'alice' },
    item: { id: 'tt123', name: 'Chernobyl', type: 'series' },
    videoId: 'tt123:1:1',
  }
  const fakePrisma = {
    proxyStreamSession: {
      findMany: async () => [makeProxyRow()], // active proxy row for an unrelated title
    },
  }

  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', users, [nativeChernobylEntry])

  const titles = result.map((r) => r.item.name)
  assert.ok(titles.includes('The Rock (1996)'), 'proxy-derived entry should be present')
  assert.ok(titles.includes('Chernobyl'), 'unrelated native entry must survive - this is the usenet fix')
})

test('mergeProxyNowPlaying: a matching-title proxy row supersedes the native entry, borrowing its richer metadata', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const nativeEntry = {
    user: { id: 'user-1', username: 'alice' },
    item: { id: 'tt999', name: 'The Rock', type: 'movie', poster: 'https://posters/rock.jpg' },
    videoId: null,
  }
  const fakePrisma = {
    proxyStreamSession: {
      findMany: async () => [makeProxyRow()], // displayName "The Rock (1996)" title-matches "The Rock"
    },
  }

  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', users, [nativeEntry])

  assert.equal(result.length, 1, 'should be a single merged entry, not a duplicate')
  assert.equal(result[0].source, 'aiostreams-proxy')
  assert.equal(result[0].item.id, 'tt999', 'should borrow the richer native item metadata, not the bare proxy one')
})

test('mergeProxyNowPlaying: returns the native list unchanged when there are no proxy sessions at all', async () => {
  const nativeEntry = { user: { id: 'user-1', username: 'alice' }, item: { name: 'Anything' } }
  const fakePrisma = { proxyStreamSession: { findMany: async () => [] } }
  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', [{ id: 'user-1', username: 'alice' }], [nativeEntry])
  assert.deepEqual(result, [nativeEntry])
})

test('mergeProxyNowPlaying: falls back to the native list if the proxy session query fails', async () => {
  const nativeEntry = { user: { id: 'user-1', username: 'alice' }, item: { name: 'Anything' } }
  const fakePrisma = { proxyStreamSession: { findMany: async () => { throw new Error('db down') } } }
  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', [{ id: 'user-1', username: 'alice' }], [nativeEntry])
  assert.deepEqual(result, [nativeEntry])
})

// The proxy is authoritative for content it carries; native is the only truth
// for content it doesn't (e.g. usenet via newznab, which bypasses the proxy).

// findMany is called twice: first for active sessions, then for recently-closed.
function makeSplitPrisma(active, recentlyClosed) {
  let call = 0
  return {
    proxyStreamSession: {
      findMany: async () => (call++ === 0 ? active : recentlyClosed),
    },
  }
}

test('mergeProxyNowPlaying: suppresses the stale native echo of a stream the proxy just finished (no post-exit lingering)', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  // Native still thinks this is playing - its freshness window holds a session
  // "active" ~15min after the provider's stop checkpoint.
  const staleNative = { user: { id: 'user-1', username: 'alice' }, item: { id: 'tt1', name: 'The Rock' } }
  const closedProxyRow = { ...makeProxyRow(), isActive: false, endTime: new Date() }
  const prisma = makeSplitPrisma([], [closedProxyRow])

  const result = await mergeProxyNowPlaying(prisma, 'acct-1', users, [staleNative])

  assert.equal(result.length, 0, 'the proxy knows this stream ended, so the native echo must be dropped')
})

test('mergeProxyNowPlaying: keeps a native entry the proxy never carried (usenet via newznab)', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  // Usenet bypasses the proxy entirely - native is the only signal for it.
  const usenetNative = { user: { id: 'user-1', username: 'alice' }, item: { id: 'tt9', name: 'Eastbound & Down' } }
  // An unrelated debrid stream the proxy recently finished must not blank it out.
  const closedProxyRow = { ...makeProxyRow(), isActive: false, endTime: new Date() }
  const prisma = makeSplitPrisma([], [closedProxyRow])

  const result = await mergeProxyNowPlaying(prisma, 'acct-1', users, [usenetNative])

  assert.equal(result.length, 1)
  assert.equal(result[0].item.name, 'Eastbound & Down')
})

// --- a live row is only shown while the monitor is still confirming it ------

test('mergeProxyNowPlaying: a live row the monitor has stopped confirming is not shown as playing (the day-old card)', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  // What the database still says days after polling broke: one row, active.
  const stuck = makeProxyRow({ filename: 'Hercules.1997.mkv', displayName: 'Hercules (1997)', isActive: true })
  const native = { user: { id: 'user-1', username: 'alice' }, item: { id: 'tt15325794', name: 'Fall 2', type: 'movie' } }

  const shown = await mergeProxyNowPlaying(makeSplitPrisma([stuck], []), 'acct-1', users, [native], { isConfirming: () => true })
  assert.deepEqual(shown.map((r) => r.item.name).sort(), ['Fall 2', 'Hercules (1997)'])

  const hidden = await mergeProxyNowPlaying(makeSplitPrisma([stuck], []), 'acct-1', users, [native], { isConfirming: () => false })
  assert.deepEqual(hidden.map((r) => r.item.name), ['Fall 2'], 'only what is really playing is left')
})

test('mergeProxyNowPlaying: a stream the proxy saw end still clears its native echo while the monitor is not confirming', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const staleNative = { user: { id: 'user-1', username: 'alice' }, item: { id: 'tt1', name: 'The Rock' } }
  const closedProxyRow = { ...makeProxyRow(), isActive: false, endTime: new Date() }
  const result = await mergeProxyNowPlaying(makeSplitPrisma([], [closedProxyRow]), 'acct-1', users, [staleNative], { isConfirming: () => false })
  assert.equal(result.length, 0)
})

// --- a sequel is not its original -------------------------------------------

test('mergeProxyNowPlaying: a sequel being streamed does not take the name and poster of the original still open in the library', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const sequel = makeProxyRow({ filename: 'Fall.2.2025.mkv', displayName: 'Fall 2 (2025)' })
  const original = {
    user: { id: 'user-1', username: 'alice' },
    item: { id: 'tt15325794', name: 'Fall', type: 'movie', poster: 'https://posters/fall.jpg' },
    videoId: null,
  }
  const result = await mergeProxyNowPlaying(makeSplitPrisma([sequel], []), 'acct-1', users, [original], { isConfirming: () => true })
  const proxyCard = result.find((r) => r.source === 'aiostreams-proxy')
  assert.ok(proxyCard, 'the stream has its own card')
  assert.equal(proxyCard.item.name, 'Fall 2 (2025)')
  assert.notEqual(proxyCard.item.poster, 'https://posters/fall.jpg')
  assert.ok(result.some((r) => r.item.name === 'Fall'), 'the original is not hidden by it')
})

test('mergeProxyNowPlaying: ids decide over names - a matched stream never borrows a different title that shares its name', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const remake = makeProxyRow({ filename: 'It.2017.mkv', displayName: 'It (2017)', metadataItemId: 'tt1396484', metadataName: 'It' })
  const older = { user: { id: 'user-1', username: 'alice' }, item: { id: 'tt0099864', name: 'It', type: 'series' }, videoId: null }
  const result = await mergeProxyNowPlaying(makeSplitPrisma([remake], []), 'acct-1', users, [older], { isConfirming: () => true })
  assert.equal(result.length, 2)
  assert.notEqual(result.find((r) => r.source === 'aiostreams-proxy').item.id, 'tt0099864')
})

// --- when a live row was last reconfirmed (the cards' freshness line) --------

test('mergeProxyNowPlaying: a proxy row says when the poll last reconfirmed it, apart from request cadence', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const reconfirmed = new Date('2026-07-15T20:09:30Z')
  // lastSeenAt froze minutes before (a fast debrid stream); the poll kept confirming.
  const row = makeProxyRow({ isActive: true, updatedAt: reconfirmed, lastSeenAt: new Date('2026-07-15T20:01:00Z') })
  const result = await mergeProxyNowPlaying(makeSplitPrisma([row], []), 'acct-1', users, [], { isConfirming: () => true })
  const card = result.find((r) => r.source === 'aiostreams-proxy')
  assert.equal(card.reportedAtTimestamp, reconfirmed.getTime())
})

test('jellyfinLive: a viewing carries the pass that saw it and whether the player said paused', () => {
  const live = require('../server/utils/jellyfinLive')
  const before = Date.now()
  live.recordLive('fresh-user', [{ itemId: 'tt1', itemType: 'movie', videoId: 'tt1', itemName: 'X', positionMs: 1000, durationMs: 9000, paused: true }])
  const [v] = live.liveViewings(['fresh-user'])
  assert.ok(v.observedAt >= before && v.observedAt <= Date.now())
  assert.equal(v.paused, true)
  live.forgetUser('fresh-user')
})
