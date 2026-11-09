// A removed, buried or wiped title comes back only when someone really starts
// playing it after the removal - never from old progress alone.
const test = require('node:test')
const assert = require('node:assert/strict')
const { releaseRewatched } = require('../server/utils/continueWatching')

const DAY = 24 * 60 * 60 * 1000
const T = new Date('2026-11-09T05:00:00Z').getTime()
function fakePrisma(sessions) {
  const deleted = []
  return {
    deleted,
    watchSession: { findMany: async ({ where }) => sessions.filter((s) => where.userId.in.includes(s.userId) && where.itemId.in.includes(s.itemId)) },
    dismissedContinueWatching: { deleteMany: async ({ where }) => { deleted.push(...where.id.in) } },
  }
}
const row = (o) => ({ id: o.showId, userId: 'u1', createdAt: new Date(T - 60 * DAY), wipedAt: null, ...o })

test('a wiped show played again after the wipe comes back', async () => {
  const db = fakePrisma([{ userId: 'u1', itemId: 'tt0096697', startTime: new Date(T) }])
  const left = await releaseRewatched(db, 'default', [row({ showId: 'tt0096697', wipedAt: new Date(T - 50 * DAY) })])
  assert.deepEqual(left, [])
  assert.deepEqual(db.deleted, ['tt0096697'])
})

test('a viewing that began before the removal does not bring it back', async () => {
  const db = fakePrisma([{ userId: 'u1', itemId: 'tt1', startTime: new Date(T - 61 * DAY) }])
  const left = await releaseRewatched(db, 'default', [row({ showId: 'tt1' })])
  assert.equal(left.length, 1)
  assert.deepEqual(db.deleted, [])
})

test('a wipe after the removal is the time that counts', async () => {
  const db = fakePrisma([{ userId: 'u1', itemId: 'tt2', startTime: new Date(T - 55 * DAY) }])
  const left = await releaseRewatched(db, 'default', [row({ showId: 'tt2', wipedAt: new Date(T - 50 * DAY) })])
  assert.equal(left.length, 1)
})

test('no viewing at all keeps it removed; someone else playing it does not count', async () => {
  const db = fakePrisma([{ userId: 'u2', itemId: 'tt3', startTime: new Date(T) }])
  const left = await releaseRewatched(db, 'default', [row({ showId: 'tt3' }), row({ showId: 'tt4' })])
  assert.equal(left.length, 2)
})
