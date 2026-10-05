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

// ---------------------------------------------------------------------------
// Pausing streaming at the limit

const quiet = async () => {}

test('a limit set to pause: paused at the limit with the alert, back just after midnight', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  const synced = []
  const deps = { syncPerson: async (_p, _a, id) => { synced.push(await st.isStreamingPaused(w.prisma, 'acc', id, MON_NOON_LA.getTime())) } }
  assert.equal(await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps }), 1)
  assert.deepEqual(synced, [true], 'one sync, with the pause already in place for it to read')
  assert.match(w.notes[0].body, /Streaming is paused until midnight/)
  assert.equal(w.sync.screenTimePauses.mia.until, '2026-10-06T07:00:00.000Z', 'midnight in Los Angeles')

  await st.checkScreenTime(w.prisma, { now: new Date(MON_NOON_LA.getTime() + 5 * 60000), emit: quiet, deps })
  assert.equal(synced.length, 1, 'not paused twice')

  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T07:05:00Z'), emit: quiet, deps })
  assert.deepEqual(synced, [true, false], 'synced again after midnight, with the pause gone')
  assert.deepEqual(w.sync.screenTimePauses, {})
})

test('"Resume now" holds for the rest of the day, and is forgotten the next', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  let syncs = 0
  const deps = { syncPerson: async () => { syncs++ } }
  await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
  const view = await st.resume(w.prisma, 'acc', 'mia', deps, { now: new Date(MON_NOON_LA.getTime() + 60000) })
  assert.equal(view.paused, null)
  assert.equal(syncs, 2)
  await st.checkScreenTime(w.prisma, { now: new Date(MON_NOON_LA.getTime() + 10 * 60000), emit: quiet, deps })
  assert.equal(syncs, 2, 'still over the limit, but not paused again today')
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T19:00:00Z'), emit: quiet, deps })
  assert.deepEqual(w.sync.screenTimePauses, {}, 'the note is dropped the next day')
  assert.equal(syncs, 2)
})

test('setting the limit back to alerting (or removing it) ends a pause at once', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  let syncs = 0
  const deps = { syncPerson: async () => { syncs++ } }
  await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
  assert.ok(w.sync.screenTimePauses.mia)
  await st.setLimit(w.prisma, 'acc', 'mia', { minutes: 90, days: [] }, deps)
  assert.equal(w.sync.screenTimePauses.mia, undefined)
  assert.equal(syncs, 2)
  assert.deepEqual(st.cleanLimit({ minutes: 90, days: [], onReach: 'pause' }), { minutes: 90, days: [], onReach: 'pause' })
  assert.deepEqual(st.cleanLimit({ minutes: 90, days: [], onReach: 'anything' }), { minutes: 90, days: [] })
})

test('Jellyfin: blocked by their access schedule, and it is put back - unless the block was not ours', async () => {
  for (const alreadyBlocked of [false, true]) {
    const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
    const mia = { id: 'mia', username: 'Mia', providerType: 'jellyfin', jellyfinServerKind: 'jellyfin' }
    w.prisma.user.findMany = async () => [mia]
    w.prisma.user.findFirst = async () => mia
    const theirs = [{ DayOfWeek: 'Weekday', StartHour: 7, EndHour: 21 }]
    const calls = []
    const deps = {
      setJellyfinBlocked: async (_p, _a, _id, blocked, opts) => { calls.push([blocked, opts.restore]); return blocked && !alreadyBlocked ? theirs : null },
      syncPerson: async () => { throw new Error('a Jellyfin person has no addons to sync') },
    }
    await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
    assert.equal(await st.isStreamingPaused(w.prisma, 'acc', 'mia', MON_NOON_LA.getTime()), true)
    await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T07:05:00Z'), emit: quiet, deps })
    assert.deepEqual(calls, alreadyBlocked ? [[true, undefined]] : [[true, undefined], [false, theirs]], alreadyBlocked ? 'a block that was already there is left alone' : 'blocked, then their own schedule put back')
  }
})

test('AIOStreams can only alert: no pause is recorded', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  w.prisma.user.findMany = async () => [{ id: 'mia', username: 'Mia', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' }]
  assert.equal(await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps: {} }), 1)
  assert.equal(w.sync.screenTimePauses, undefined)
  assert.doesNotMatch(w.notes[0].body, /paused/)
})

test('which addons play streams, and when midnight is across a clock change', () => {
  assert.equal(st.servesStreams({ manifest: { resources: ['catalog', 'meta'] } }), false)
  assert.equal(st.servesStreams({ manifest: { resources: [{ name: 'stream', types: ['movie'] }] } }), true)
  assert.equal(st.servesStreams({ manifest: JSON.stringify({ resources: ['stream'] }) }), true)
  assert.equal(st.servesStreams({}), false)
  // US clocks go back on 2026-11-01: that midnight is still daylight time, the next isn't.
  assert.equal(st.nextAccountMidnight(TZ, new Date('2026-10-31T19:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z')
  assert.equal(st.nextAccountMidnight(TZ, new Date('2026-11-01T20:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z')
})

test('a paused person\'s addon list drops the group\'s stream addons - and only while paused', async () => {
  const helpers = require('../server/utils/helpers')
  const { getDesiredAddons } = require('../server/utils/sync')
  const original = helpers.getGroupAddons
  helpers.getGroupAddons = async () => [
    { id: 'a1', transportUrl: 'https://catalogs.example.com/manifest.json', transportName: 'Catalogs', manifest: { name: 'Catalogs', resources: ['catalog', 'meta'] } },
    { id: 'a2', transportUrl: 'https://streams.example.com/manifest.json', transportName: 'Streams', manifest: { name: 'Streams', resources: [{ name: 'stream', types: ['movie'] }] } },
    { id: 'a3', transportUrl: 'https://both.example.com/manifest.json', transportName: 'Both', manifest: { name: 'Both', resources: ['catalog', 'stream'] } },
  ]
  try {
    let cfg = { screenTimePauses: { mia: { until: '2999-01-01T00:00:00.000Z' } } }
    const deps = {
      prisma: { group: { findMany: async () => [{ id: 'g1' }] }, appAccount: { findUnique: async () => ({ sync: JSON.stringify(cfg) }) } },
      getAccountId: () => 'acc', decrypt: (x) => x, parseAddonIds: () => [], parseProtectedAddons: () => [], canonicalizeManifestUrl: (u) => u,
      _prefetchedUserAddons: [],
    }
    const user = { id: 'mia', excludedAddons: null, protectedAddons: null }
    const names = (r) => r.addons.map((a) => a.transportName)
    assert.deepEqual(names(await getDesiredAddons(user, {}, deps)), ['Catalogs'])
    cfg = {}
    assert.deepEqual(names(await getDesiredAddons(user, {}, deps)), ['Catalogs', 'Streams', 'Both'])
  } finally {
    helpers.getGroupAddons = original
  }
})

test('"Back on at" 7 AM: paused until the next 7 AM, not midnight', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause', resumeAt: '07:00' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  let syncs = 0
  const deps = { syncPerson: async () => { syncs++ } }
  await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
  assert.equal(w.sync.screenTimePauses.mia.until, '2026-10-06T14:00:00.000Z', '7 AM Tuesday in Los Angeles')
  assert.match(w.notes[0].body, /paused until 7:00 AM/)
  // Midnight comes and goes: still paused.
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T07:05:00Z'), emit: quiet, deps })
  assert.equal(syncs, 1)
  assert.ok(w.sync.screenTimePauses.mia.until)
  // Just after 7 AM: back on, nothing left behind (it ended on a new day).
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T14:05:00Z'), emit: quiet, deps })
  assert.equal(syncs, 2)
  assert.deepEqual(w.sync.screenTimePauses, {})
})

test('a pause that ends the same day (back on at 9 PM) doesn\'t start again that day', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause', resumeAt: '21:00' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  let syncs = 0
  const deps = { syncPerson: async () => { syncs++ } }
  await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
  assert.equal(w.sync.screenTimePauses.mia.until, '2026-10-06T04:00:00.000Z', '9 PM Monday in Los Angeles')
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T04:05:00Z'), emit: quiet, deps })
  assert.equal(syncs, 2, 'back on at 9 PM')
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T04:10:00Z'), emit: quiet, deps })
  assert.equal(syncs, 2, 'still over today\'s limit, but not paused again')
  assert.equal(w.sync.screenTimePauses.mia.resumedOn !== undefined, true)
})

test('back-on times are cleaned, and land on the right clock across a clock change', () => {
  assert.deepEqual(st.cleanLimit({ minutes: 60, days: [], onReach: 'pause', resumeAt: '7:30' }), { minutes: 60, days: [], onReach: 'pause', resumeAt: '07:30' })
  assert.deepEqual(st.cleanLimit({ minutes: 60, days: [], onReach: 'pause', resumeAt: '00:00' }), { minutes: 60, days: [], onReach: 'pause' })
  assert.deepEqual(st.cleanLimit({ minutes: 60, days: [], onReach: 'pause', resumeAt: '25:00' }), { minutes: 60, days: [], onReach: 'pause' })
  assert.deepEqual(st.cleanLimit({ minutes: 60, days: [], resumeAt: '07:00' }), { minutes: 60, days: [] }, 'only a pause has one')
  // 1 AM on the morning the clocks go back: 7 AM is seven hours of real time away.
  assert.equal(st.nextAccountTime(TZ, new Date('2026-11-01T08:00:00Z'), '07:00').toISOString(), '2026-11-01T15:00:00.000Z')
})

test('a pause stays in force until the check lifts it, not just until its time passes', async () => {
  const w = world({ limits: { mia: { minutes: 90, days: [], onReach: 'pause' } }, activity: [row('mia', 95, MON_NOON_LA)] })
  const deps = { syncPerson: async () => {} }
  await st.checkScreenTime(w.prisma, { now: MON_NOON_LA, emit: quiet, deps })
  // Past midnight on the clock, but no check has run yet.
  assert.equal(await st.isStreamingPaused(w.prisma, 'acc', 'mia'), true, 'the refusals are still expected')
  await st.checkScreenTime(w.prisma, { now: new Date('2026-10-06T07:01:00Z'), emit: quiet, deps })
  assert.equal(await st.isStreamingPaused(w.prisma, 'acc', 'mia'), false)
})
