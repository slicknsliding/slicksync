// Daily screen-time limits (server/utils/screenTime.js): counted like Watch
// Time, on the account's own day, one alert per person per day.
const test = require('node:test')
const assert = require('node:assert/strict')
const st = require('../server/utils/screenTime')
const { getAccountDateString } = require('../server/utils/dateUtils')

const TZ = 'America/Los_Angeles'
// 2026-10-05 is a Monday. 06:00 UTC is still Sunday evening in Los Angeles.
const MON_NOON_LA = new Date('2026-10-05T19:00:00Z')
const SUN_EVENING_LA = new Date('2026-10-05T06:00:00Z')

function world({ limits, activity, now }) {
  const notes = []
  let sync = { accountTimezone: TZ, screenTime: limits }
  const prisma = {
    appAccount: {
      findMany: async () => [{ id: 'acc', sync: JSON.stringify(sync) }],
      findUnique: async () => ({ sync: JSON.stringify(sync) }),
      findFirst: async () => ({ sync: JSON.stringify(sync) }),
      update: async ({ data }) => { sync = JSON.parse(data.sync) },
    },
    user: {
      findMany: async ({ where }) => [{ id: 'mia', username: 'Mia' }, { id: 'leo', username: 'Leo' }].filter((u) => where.id.in.includes(u.id)),
      findFirst: async ({ where }) => ({ id: where.id }),
    },
    watchActivity: {
      groupBy: async ({ where }) => {
        const sums = new Map()
        for (const a of activity) {
          if (!where.userId.in.includes(a.userId) || a.date < where.date.gte) continue
          sums.set(a.userId, (sums.get(a.userId) || 0) + a.watchTimeSeconds)
        }
        return [...sums].map(([userId, s]) => ({ userId, _sum: { watchTimeSeconds: s } }))
      },
    },
    notification: {
      findUnique: async ({ where }) => notes.find((n) => n.dedupeKey === where.accountId_dedupeKey.dedupeKey) || null,
      upsert: async ({ create }) => (notes.push(create), create),
      create: async ({ data }) => (notes.push(data), data),
    },
  }
  return { prisma, notes, get sync() { return sync } }
}

// A row keyed the way metricsProcessor writes WatchActivity.date.
const row = (userId, minutes, when, tz = TZ) => ({ userId, watchTimeSeconds: minutes * 60, date: new Date(getAccountDateString(when, tz)) })

test('reaching the limit: one alert and one trigger for the day, however many checks', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [] } }, activity: [row('mia', 60, MON_NOON_LA), row('mia', 35, MON_NOON_LA)] })
  const fired = []
  const emit = async (_p, accountId, type, payload) => { fired.push({ type, payload }) }
  assert.equal(await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit }), 1)
  assert.equal(await st.checkScreenTime(w.prisma, { now: new Date(MON_NOON_LA.getTime() + 5 * 60000), emit }), 0)
  assert.equal(w.notes.length, 1)
  assert.match(w.notes[0].title, /Mia reached today's 90-minute limit/)
  assert.deepEqual(fired, [{ type: 'watch.budget_exceeded', payload: { username: 'Mia', userId: 'mia', minutesWatched: 95, limitMinutes: 90 } }])
})

test('under the limit, or on a day it doesn\'t apply: nothing', async () => {
  const emit = async () => {}
  const under = world({ limits: { mia: { minutes: 90, days: [] } }, activity: [row('mia', 89, MON_NOON_LA)] })
  assert.equal(await st.checkScreenTime(under.prisma, { now: MON_NOON_LA, emit }), 0)
  // School days only, and it is still Sunday in the account's timezone.
  const sunday = world({ limits: { mia: { minutes: 30, days: [1, 2, 3, 4, 5] } }, activity: [row('mia', 200, SUN_EVENING_LA)] })
  assert.equal(await st.checkScreenTime(sunday.prisma, { now: SUN_EVENING_LA, emit }), 0, 'the account\'s Sunday, though UTC says Monday')
})

test('today is the account\'s day, not the server\'s', async () => {
  // Yesterday evening (LA) counts for yesterday, not for today.
  const w = world({ limits: { mia: { minutes: 60, days: [] } }, activity: [row('mia', 120, SUN_EVENING_LA)] })
  assert.equal(await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: async () => {} }), 0)
  assert.equal(st.accountToday(TZ, SUN_EVENING_LA).weekday, 0)
  assert.equal(st.accountToday(TZ, MON_NOON_LA).weekday, 1)
})

test('limits are cleaned on the way in, and can be removed', async () => {
  assert.deepEqual(st.cleanLimit({ minutes: '90', days: [5, 1, 1, 9, 'x'] }), { minutes: 90, days: [1, 5] })
  assert.equal(st.cleanLimit({ minutes: 0 }), null)
  assert.equal(st.cleanLimit({ minutes: 5000 }), null)
  const w = world({ limits: {}, activity: [] })
  const set = await st.setLimit(w.prisma, 'acc', 'mia', { minutes: 45, days: [0, 6] })
  assert.deepEqual(set.limit, { minutes: 45, days: [0, 6] })
  await assert.rejects(st.setLimit(w.prisma, 'acc', 'mia', { minutes: 0 }), /between 1 and 1440/)
  const cleared = await st.setLimit(w.prisma, 'acc', 'mia', null)
  assert.equal(cleared.limit, null)
  assert.deepEqual(w.sync.screenTime, {})
})
