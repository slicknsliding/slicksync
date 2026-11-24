const test = require('node:test')
const assert = require('node:assert/strict')
const { limitToStreamStart, firstOpenedAfter } = require('../server/utils/streamStart')

const MIN = 60 * 1000
const NOW = Date.parse('2026-11-23T20:00:00Z')
const users = [{ id: 'u1', username: 'sam', email: null }, { id: 'u2', username: 'alex', email: null }]

// The proxy rows SlickSync holds, with the one call the lookup makes.
const prismaWith = (rows) => ({
  proxyStreamSession: {
    findMany: async ({ where }) => rows.filter((r) => r.accountId === where.accountId && r.lastSeenAt >= where.lastSeenAt.gte),
  },
})
const row = (startedAgoMin, lastSeenAgoMin, over = {}) => ({
  accountId: 'a1', aiostreamsUser: 'sam', url: 'usenet:abc:0:', displayName: 'Other Mommy (2026)', filename: null, metadataName: null,
  startTime: new Date(NOW - startedAgoMin * MIN), lastSeenAt: new Date(NOW - lastSeenAgoMin * MIN), ...over,
})
const opening = (startedAgoMin, lastSeenAgoMin, over = {}) => ({
  aiostreamsUser: 'sam', targetKey: 'usenet:abc:0:', startedAt: NOW - startedAgoMin * MIN, lastSeenAt: NOW - lastSeenAgoMin * MIN, ...over,
})
const historyOf = (entries, total = entries.length) => ({ fetchHistory: async () => ({ entries, total }) })
const ask = { accountId: 'a1', userIds: ['u1'], title: 'Other Mommy', series: false, users, nowMs: NOW }

test('a skip ahead right after opening counts only the time the stream has been open', async () => {
  // Left at 59:00 yesterday; opened a minute ago, skipped 21 minutes, paused.
  const prisma = prismaWith([row(1, 0)])
  const seconds = await limitToStreamStart(prisma, 21 * 60, { ...ask, afterMs: NOW - 24 * 60 * MIN }, historyOf([]))
  assert.equal(seconds, 60 + 60)
})

test('twenty minutes really watched are all kept', async () => {
  const prisma = prismaWith([row(20, 0)])
  const seconds = await limitToStreamStart(prisma, 20 * 60, { ...ask, afterMs: NOW - 24 * 60 * MIN }, historyOf([]))
  assert.equal(seconds, 20 * 60)
})

test('a player that reads in bursts is measured from its first stream, not its latest', async () => {
  // An hour of viewing seen by AIOStreams as short streams five minutes apart.
  const bursts = Array.from({ length: 12 }, (_, i) => opening(60 - i * 5, 60 - i * 5 - 0.2))
  const prisma = prismaWith([row(5, 4.8)])
  const seconds = await limitToStreamStart(prisma, 58 * 60, { ...ask, afterMs: NOW - 24 * 60 * MIN }, historyOf(bursts))
  assert.equal(seconds, 58 * 60)
})

test('the tail of the sitting that made the last save is not a new opening', async () => {
  const lastSave = NOW - 3 * 60 * MIN
  // Yesterday's stream was read for a few seconds after that save; today's opened a minute ago.
  const prisma = prismaWith([row(1, 0)])
  const old = opening(4 * 60, 3 * 60 - 0.5)
  const seconds = await limitToStreamStart(prisma, 30 * 60, { ...ask, afterMs: lastSave }, historyOf([old]))
  assert.equal(seconds, 60 + 60)
})

test('a stream open across the last save sets no limit of its own', async () => {
  // Paused (saved) ten minutes ago, carried on in the same stream.
  const lastSave = NOW - 10 * MIN
  const prisma = prismaWith([row(40, 0)])
  assert.equal(await firstOpenedAfter(prisma, { ...ask, afterMs: lastSave }, historyOf([])), lastSave)
})

test('a new title is looked for over the last day', async () => {
  const prisma = prismaWith([row(2, 0)])
  const seconds = await limitToStreamStart(prisma, 45 * 60, { ...ask, afterMs: null }, historyOf([]))
  assert.equal(seconds, 2 * 60 + 60)
})

test('left as it was when nothing is known', async () => {
  const after = NOW - 24 * 60 * MIN
  // No stream for this title.
  assert.equal(await limitToStreamStart(prismaWith([row(1, 0, { displayName: 'Police Story (1985)' })]), 1260, { ...ask, afterMs: after }, historyOf([])), 1260)
  // Someone else's stream of it.
  assert.equal(await limitToStreamStart(prismaWith([row(1, 0, { aiostreamsUser: 'alex' })]), 1260, { ...ask, afterMs: after }, historyOf([])), 1260)
  // No history to be had.
  assert.equal(await limitToStreamStart(prismaWith([row(1, 0)]), 1260, { ...ask, afterMs: after }, { fetchHistory: async () => null }), 1260)
  // A history that does not reach back to the last save.
  assert.equal(await limitToStreamStart(prismaWith([row(1, 0)]), 1260, { ...ask, afterMs: after }, historyOf([opening(30, 29, { targetKey: 'other' })], 500)), 1260)
  // A position whose save time is not known.
  assert.equal(await limitToStreamStart(prismaWith([row(1, 0)]), 1260, { ...ask, afterMs: NaN }, historyOf([])), 1260)
  // A lookup that fails.
  assert.equal(await limitToStreamStart({ proxyStreamSession: { findMany: async () => { throw new Error('down') } } }, 1260, { ...ask, afterMs: after }, historyOf([])), 1260)
})

test('small amounts are never looked up', async () => {
  let asked = false
  const prisma = { proxyStreamSession: { findMany: async () => { asked = true; return [] } } }
  assert.equal(await limitToStreamStart(prisma, 170, { ...ask, afterMs: NOW - MIN }, historyOf([])), 170)
  assert.equal(asked, false)
})

test('a merged person: the stream is found under either of their ids', async () => {
  const prisma = prismaWith([row(1, 0)])
  const seconds = await limitToStreamStart(prisma, 1260, { ...ask, userIds: ['absorbed-9', 'u1'], afterMs: NOW - 24 * 60 * MIN }, historyOf([]))
  assert.equal(seconds, 120)
})
