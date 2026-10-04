const test = require('node:test')
const assert = require('node:assert/strict')
const { processUserSessions, hasReachedEnd } = require('../server/utils/sessionTracker')

// A WatchSession table in memory, with just the calls processUserSessions
// makes. One row per account/user/item, as the schema's @@unique has it.
function fakePrisma(rows = []) {
  let nextId = rows.length + 1
  const keyOf = (r) => `${r.accountId}:${r.userId}:${r.itemId}`
  const table = new Map(rows.map((r) => [keyOf(r), { ...r }]))
  return {
    rows: () => [...table.values()],
    user: {
      findUnique: async () => ({ id: 'u1', username: 'TEST USER', email: null, colorIndex: 0, discordWebhookUrl: null }),
    },
    watchSession: {
      findMany: async ({ where }) => [...table.values()].filter((r) =>
        r.accountId === where.accountId && r.userId === where.userId && r.isActive === where.isActive),
      findUnique: async ({ where }) => {
        const k = where.accountId_userId_itemId
        return table.get(`${k.accountId}:${k.userId}:${k.itemId}`) || null
      },
      update: async ({ where, data }) => {
        const row = [...table.values()].find((r) => r.id === where.id)
        Object.assign(row, data)
        return row
      },
      upsert: async ({ where, create, update }) => {
        const k = where.accountId_userId_itemId
        const key = `${k.accountId}:${k.userId}:${k.itemId}`
        const existing = table.get(key)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { id: `s${nextId++}`, ...create }
        table.set(key, row)
        return row
      },
    },
  }
}

const MIN = 60 * 1000
const DURATION = 26 * MIN + 12 * 1000 // 26:12, the episode from the report

function episode(now, { position, lastWatchedAgo }) {
  return {
    _id: 'tt1844624',
    type: 'series',
    name: 'American Horror Story',
    poster: 'https://example.com/poster.jpg',
    state: {
      video_id: 'tt1844624:13:5',
      timeOffset: position,
      duration: DURATION,
      lastWatched: new Date(now - lastWatchedAgo).toISOString(),
    },
  }
}

test('hasReachedEnd: the last 2% of the runtime counts as the end, anything earlier does not', () => {
  assert.equal(hasReachedEnd(DURATION, DURATION), true)
  assert.equal(hasReachedEnd(DURATION - 20 * 1000, DURATION), true)
  assert.equal(hasReachedEnd(DURATION * 0.9, DURATION), false)
  assert.equal(hasReachedEnd(0, DURATION), false)
  assert.equal(hasReachedEnd(DURATION, 0), false)
  assert.equal(hasReachedEnd(null, DURATION), false)
  assert.equal(hasReachedEnd(DURATION, undefined), false)
})

test('a checkpoint at the end of the runtime closes the open session on that poll, not 18 minutes later', async () => {
  const now = Date.now()
  const startedAt = new Date(now - 30 * MIN)
  const prisma = fakePrisma([{
    id: 's1', accountId: 'default', userId: 'u1', itemId: 'tt1844624', videoId: 'tt1844624:13:5',
    itemName: 'American Horror Story', itemType: 'series', season: 13, episode: 5, poster: null,
    startTime: startedAt, endTime: null, startPosition: 0, lastPosition: 20 * MIN, totalDuration: DURATION,
    isActive: true, paused: false, durationSeconds: 20 * 60,
  }])

  // The episode ran out a minute ago: Nuvio's final checkpoint is at 26:12
  // of 26:12. Before this the session stayed in Now Playing for the whole
  // freshness window after.
  const finishedAgo = 1 * MIN
  const r = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: DURATION, lastWatchedAgo: finishedAgo })], new Date(now))
  assert.equal(r.sessionsUpdated, 1)
  assert.equal(r.sessionsClosed, 1)
  const [row] = prisma.rows()
  assert.equal(row.isActive, false)
  assert.equal(row.endTime.getTime(), now - finishedAgo, 'ends at the checkpoint, not at the poll')
  // The last stretch (20:00 -> 26:12) is still credited.
  assert.equal(row.durationSeconds, 20 * 60 + 6 * 60 + 12)
  assert.equal(row.lastPosition, DURATION)

  // The next polls still see the same final checkpoint for the rest of the
  // window. They must not reopen the session.
  for (let i = 1; i <= 3; i++) {
    const again = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: DURATION, lastWatchedAgo: finishedAgo })], new Date(now + i * MIN))
    assert.equal(again.sessionsCreated, 0, `poll ${i} reopened the finished session`)
    assert.equal(prisma.rows()[0].isActive, false)
  }
})

test('a rewatch after a finish starts a session again', async () => {
  const now = Date.now()
  const prisma = fakePrisma([{
    id: 's1', accountId: 'default', userId: 'u1', itemId: 'tt1844624', videoId: 'tt1844624:13:5',
    itemName: 'American Horror Story', itemType: 'series', season: 13, episode: 5, poster: null,
    startTime: new Date(now - 2 * 60 * MIN), endTime: new Date(now - 90 * MIN), startPosition: 0, lastPosition: DURATION, totalDuration: DURATION,
    isActive: false, paused: false, durationSeconds: 26 * 60,
  }])
  const r = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: 2 * MIN, lastWatchedAgo: 30 * 1000 })], new Date(now))
  assert.equal(r.sessionsCreated, 1)
  assert.equal(prisma.rows()[0].isActive, true)
})

test('a watch first seen at its end is recorded, then closed on the following poll', async () => {
  const now = Date.now()
  const prisma = fakePrisma()
  // Nuvio only checkpoints at pause/stop, so a straight-through watch's
  // first checkpoint can be its last. It still has to produce a session,
  // credited with the runtime, as before.
  const first = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: DURATION, lastWatchedAgo: 30 * 1000 })], new Date(now))
  assert.equal(first.sessionsCreated, 1)
  let [row] = prisma.rows()
  assert.equal(row.durationSeconds, 26 * 60 + 12)

  const second = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: DURATION, lastWatchedAgo: 30 * 1000 })], new Date(now + MIN))
  assert.equal(second.sessionsClosed, 1)
  ;[row] = prisma.rows()
  assert.equal(row.isActive, false)
  assert.equal(row.durationSeconds, 26 * 60 + 12, 'closing adds nothing: the position did not move')

  const third = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: DURATION, lastWatchedAgo: 30 * 1000 })], new Date(now + 2 * MIN))
  assert.equal(third.sessionsCreated, 0)
  assert.equal(prisma.rows()[0].isActive, false)
})

test('a checkpoint short of the end keeps the session open, as before', async () => {
  const now = Date.now()
  const prisma = fakePrisma([{
    id: 's1', accountId: 'default', userId: 'u1', itemId: 'tt1844624', videoId: 'tt1844624:13:5',
    itemName: 'American Horror Story', itemType: 'series', season: 13, episode: 5, poster: null,
    startTime: new Date(now - 30 * MIN), endTime: null, startPosition: 0, lastPosition: 10 * MIN, totalDuration: DURATION,
    isActive: true, paused: false, durationSeconds: 10 * 60,
  }])
  const r = await processUserSessions(prisma, 'default', 'u1', [episode(now, { position: 20 * MIN, lastWatchedAgo: 5 * MIN })], new Date(now))
  assert.equal(r.sessionsClosed, 0)
  assert.equal(prisma.rows()[0].isActive, true)
})
