// utils/watchState.js liveViewings(): what AIOStreams' apps are playing or
// have paused, for Now Playing.
const test = require('node:test')
const assert = require('node:assert/strict')
const { liveViewings, PAUSED_KEEP_MS } = require('../server/utils/watchState')

const MIN = 60 * 1000
const fakePrisma = (rows) => ({ watchStateCursor: { findMany: async () => rows } })
const cursor = (over = {}) => ({
  userId: 'u1', itemId: 'tt1', itemType: 'movie', videoId: 'tt1', itemName: 'Heat', poster: null,
  season: null, episode: null, durationMs: 120 * MIN, startPositionMs: 0,
  startAt: new Date(Date.now() - 5 * MIN), createdAt: new Date(Date.now() - 30 * MIN), updatedAt: new Date(),
  ...over,
})

test('a start with no pause since is playing until the runtime plus a margin', async () => {
  const [v] = await liveViewings(fakePrisma([cursor()]), 'a')
  assert.equal(v.paused, undefined)
  assert.ok(Math.abs(v.playingUntil - (v.observedAt + 122 * MIN)) < 1000)
})

test('playing from a resumed position counts only the rest of the runtime', async () => {
  const [v] = await liveViewings(fakePrisma([cursor({ startPositionMs: 100 * MIN })]), 'a')
  assert.ok(Math.abs(v.playingUntil - (v.observedAt + 22 * MIN)) < 1000)
})

test('with no runtime reported "playing" is capped at 3 hours', async () => {
  const [v] = await liveViewings(fakePrisma([cursor({ durationMs: null })]), 'a')
  assert.ok(Math.abs(v.playingUntil - (v.observedAt + 3 * 60 * MIN)) < 1000)
})

test('a paused viewing stays for 20 minutes, flagged paused, with no position', async () => {
  const paused = cursor({ startAt: null, startPositionMs: null, updatedAt: new Date(Date.now() - 19 * MIN) })
  const [v] = await liveViewings(fakePrisma([paused]), 'a')
  assert.equal(v.paused, true)
  assert.equal(v.positionMs, null)
  assert.equal(v.playingUntil, undefined)
  assert.equal(v.observedAt, paused.updatedAt.getTime())
})

test('a pause older than the window is dropped', async () => {
  assert.equal(PAUSED_KEEP_MS, 20 * MIN)
  const old = cursor({ startAt: null, updatedAt: new Date(Date.now() - 21 * MIN) })
  assert.deepEqual(await liveViewings(fakePrisma([old]), 'a'), [])
})

test('a start after a pause is playing again; a stop leaves no cursor and so no row', async () => {
  const resumed = cursor({ startAt: new Date(Date.now() - 1 * MIN), updatedAt: new Date() })
  const [v] = await liveViewings(fakePrisma([resumed]), 'a')
  assert.equal(v.paused, undefined)
  assert.equal(typeof v.playingUntil, 'number')
  assert.deepEqual(await liveViewings(fakePrisma([]), 'a'), [])
})

test('each person and title stays its own row, scoped by the query', async () => {
  let seen
  const prisma = { watchStateCursor: { findMany: async (q) => { seen = q; return [cursor(), cursor({ userId: 'u2', videoId: 'tt2', itemId: 'tt2' })] } } }
  const out = await liveViewings(prisma, 'acct', ['u1', 'u2'])
  assert.equal(out.length, 2)
  assert.equal(seen.where.accountId, 'acct')
  assert.deepEqual(seen.where.userId, { in: ['u1', 'u2'] })
})
