const test = require('node:test')
const assert = require('node:assert/strict')
const { processLibraryItem } = require('../server/utils/metricsProcessor')

// Episode titles are looked up online; these tests stay offline.
global.fetch = async () => { throw new Error('offline in tests') }

// Stremio's watch time comes from state.timeWatched, the time played in the
// current video: on the Stremio app measured 2026-11-02 overallTimeWatched
// stayed at 0 through a whole first episode and only took in that episode's
// time when the title moved on to the next.

// An in-memory database holding just what processLibraryItem reads and writes.
function makeDb() {
  const snapshots = []
  const activity = []
  const sameDay = (a, b) => new Date(a).getTime() === new Date(b).getTime()
  const models = {
    appAccount: { findFirst: async () => ({ sync: { accountTimezone: 'UTC' } }), findUnique: async () => null },
    watchSnapshot: {
      findFirst: async ({ where }) => {
        const rows = snapshots.filter((s) => s.userId === where.userId && s.itemId === where.itemId)
        if (where.date && typeof where.date === 'object' && 'lte' in where.date) {
          return rows.filter((s) => new Date(s.date) <= where.date).sort((a, b) => b.date - a.date)[0] || null
        }
        return rows.find((s) => sameDay(s.date, where.date)) || null
      },
      findMany: async ({ where }) => snapshots.filter((s) => s.userId === where.userId && s.itemId === where.itemId && s.videoId === where.videoId),
      upsert: (args) => () => {
        const key = args.where.accountId_userId_itemId_date
        const row = snapshots.find((s) => s.userId === key.userId && s.itemId === key.itemId && sameDay(s.date, key.date))
        if (row) Object.assign(row, args.update)
        else snapshots.push({ ...args.create })
      },
    },
    watchActivity: {
      findFirst: async ({ where }) => activity.filter((a) => a.userId === where.userId && a.itemId === where.itemId).slice(-1)[0] || null,
      // Older than the 30-second duplicate guard, as a real minute between passes would be.
      create: (args) => () => activity.push({ ...args.data, createdAt: new Date(Date.now() - 60000) }),
    },
    $transaction: async (ops) => { for (const op of ops) op() },
  }
  const prisma = new Proxy(models, {
    get: (target, name) => target[name] || new Proxy({}, { get: () => async () => null }),
  })
  return { prisma, snapshots, activity, seconds: () => activity.reduce((n, a) => n + a.watchTimeSeconds, 0) }
}

const EP1 = 'tt0096697:1:1'
const EP2 = 'tt0096697:1:2'

function item({ timeWatched, overall = 0, videoId = EP1, offset = 1000, lastWatched }) {
  return {
    _id: 'tt0096697',
    type: 'series',
    name: 'The Simpsons',
    _mtime: new Date().toISOString(),
    state: {
      lastWatched: (lastWatched || new Date()).toISOString(),
      timeWatched,
      overallTimeWatched: overall,
      timeOffset: offset,
      duration: 1400000,
      video_id: videoId,
    },
  }
}

const pass = (db, it) => processLibraryItem(db.prisma, 'acct', 'u1', it, new Date())

test('Stremio watch time is counted from the time played in the video, through an episode change', async () => {
  const db = makeDb()
  const opened = new Date(Date.now() - 3 * 24 * 3600 * 1000) // opened long ago: the first sighting adds nothing
  await pass(db, item({ timeWatched: 100000, lastWatched: opened }))
  assert.equal(db.seconds(), 0, 'first sighting is only a baseline')

  await pass(db, item({ timeWatched: 190000, lastWatched: opened }))
  assert.equal(db.seconds(), 90)

  // The real end of episode 1 (2026-11-02 22:56): lifetime figure still 0.
  await pass(db, item({ timeWatched: 1394894, lastWatched: opened }))
  assert.equal(db.seconds(), 90 + 1204)

  // Moving on: the lifetime figure takes in episode 1's time, the counter starts again.
  await pass(db, item({ timeWatched: 5000, overall: 1394894, videoId: EP2, lastWatched: opened }))
  assert.equal(db.seconds(), 1294, 'an episode change adds nothing by itself')

  // The real end of episode 2 (00:24): lifetime figure unmoved.
  await pass(db, item({ timeWatched: 1220918, overall: 1394894, videoId: EP2, lastWatched: opened }))
  assert.equal(db.seconds(), 1294 + 1215)
  assert.ok(db.activity.every((a) => a.videoId), 'each entry names its episode')
})

test('an app whose lifetime figure grows while playing is counted once, not twice', async () => {
  const db = makeDb()
  const opened = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  await pass(db, item({ timeWatched: 100000, overall: 5000000, lastWatched: opened }))
  await pass(db, item({ timeWatched: 220000, overall: 5120000, lastWatched: opened }))
  assert.equal(db.seconds(), 120)
})

test('a stale copy written back by another device, and a replay, add only what goes past the most seen', async () => {
  const db = makeDb()
  const opened = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  await pass(db, item({ timeWatched: 600000, lastWatched: opened }))
  await pass(db, item({ timeWatched: 300000, lastWatched: opened }))
  assert.equal(db.seconds(), 0, 'going backwards adds nothing')
  assert.equal(db.snapshots[0].timeWatched, '600000', 'the most seen is kept')
  await pass(db, item({ timeWatched: 600000, lastWatched: opened }))
  assert.equal(db.seconds(), 0, 'climbing back to it adds nothing')
  await pass(db, item({ timeWatched: 690000, lastWatched: opened }))
  assert.equal(db.seconds(), 90)
})

test('a new title played today counts what was played in its first video, up to where it stands', async () => {
  const db = makeDb()
  await pass(db, item({ timeWatched: 700000, offset: 650000 }))
  assert.equal(db.seconds(), 650, 'bounded by the position, as the first-sighting rule always was')
})

test('two advances under a minute are held and counted together while still playing', async () => {
  const db = makeDb()
  const opened = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  await pass(db, item({ timeWatched: 100000, lastWatched: opened }))
  const playing = new Date()
  await pass(db, item({ timeWatched: 140000, lastWatched: playing }))
  assert.equal(db.seconds(), 0)
  await pass(db, item({ timeWatched: 180000, lastWatched: playing }))
  assert.equal(db.seconds(), 80)
})
