// A bedtime written into a real Jellyfin server's own access schedule: the
// hours someone may watch, day by day, on the SERVER's clock (Jellyfin reads
// schedules in its local time). The server's offset comes from its log
// lines; without one nothing is written. A schedule an administrator set is
// theirs and stays; SlickSync's own goes again when bedtime is switched off.
const test = require('node:test')
const assert = require('node:assert/strict')
const { scheduleFor, offsetFromLog, tzOffsetMinutes, syncBedtimeSchedule, forgetForTests } = require('../server/utils/jellyfinBedtime')

const day = (list, name) => list.filter((s) => s.DayOfWeek === name).map((s) => [s.StartHour, s.EndHour])

test('every night 9 PM to 7 AM, same clock: 7 to 21 every day', () => {
  const s = scheduleFor({ from: '21:00', to: '07:00', days: [] })
  for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) assert.deepEqual(day(s, d), [[7, 21]], d)
})

test('school nights (Sunday to Thursday): Friday morning closed, Saturday open, Sunday evening closed', () => {
  const s = scheduleFor({ from: '21:00', to: '07:00', days: [0, 1, 2, 3, 4] })
  assert.deepEqual(day(s, 'Friday'), [[7, 24]])
  assert.deepEqual(day(s, 'Saturday'), [[0, 24]])
  assert.deepEqual(day(s, 'Sunday'), [[0, 21]])
  assert.deepEqual(day(s, 'Monday'), [[7, 21]])
})

test('a server on UTC for a household on Pacific time: moved seven hours on', () => {
  // 9 PM to 7 AM Pacific (UTC-7) is 4 AM to 2 PM on a UTC server.
  const s = scheduleFor({ from: '21:00', to: '07:00', days: [] }, { accountOffset: -420, serverOffset: 0 })
  assert.deepEqual(day(s, 'Tuesday'), [[0, 4], [14, 24]])
  // Saturday night ends on Sunday's server morning - wrapping round the week.
  assert.deepEqual(day(s, 'Sunday'), [[0, 4], [14, 24]])
})

test('half hours and a bedtime that ends the same evening', () => {
  const s = scheduleFor({ from: '20:30', to: '22:00', days: [3] })
  assert.deepEqual(day(s, 'Wednesday'), [[0, 20.5], [22, 24]])
  assert.deepEqual(day(s, 'Thursday'), [[0, 24]])
})

test('Resume now leaves that one night open', () => {
  // 2026-10-07 is a Wednesday.
  const s = scheduleFor({ from: '21:00', to: '07:00', days: [] }, { skipNight: '2026-10-07' })
  assert.deepEqual(day(s, 'Wednesday'), [[7, 24]])
  assert.deepEqual(day(s, 'Thursday'), [[0, 21]])
  assert.deepEqual(day(s, 'Tuesday'), [[7, 21]])
})

test('the server offset is the one on its newest log line', () => {
  const log = '[2026-10-06 08:00:00.000 +00:00] [INF] start\n[2026-10-06 21:00:01.123 -07:00] [INF] later\n'
  assert.equal(offsetFromLog(log), -420)
  assert.equal(offsetFromLog('[09:00:00.000] [INF] no date'), null)
  assert.equal(tzOffsetMinutes('America/Los_Angeles', new Date('2026-10-06T12:00:00Z')), -420)
  assert.equal(tzOffsetMinutes('UTC', new Date('2026-10-06T12:00:00Z')), 0)
})

// A small stand-in for the database, the admin sign-in and the server.
function setup({ schedule = [], log = '[2026-10-06 12:00:00.000 +00:00] [INF] up' } = {}) {
  forgetForTests()
  let sync = {}
  const prisma = {
    appAccount: {
      findUnique: async () => ({ sync: JSON.parse(JSON.stringify(sync)) }),
      update: async ({ data }) => { sync = JSON.parse(JSON.stringify(data.sync)) },
    },
  }
  const server = { schedule: JSON.parse(JSON.stringify(schedule)), writes: 0 }
  const call = async (_session, path, opts = {}) => {
    if (path === '/System/Logs') return [{ Name: 'log_20261006.log', DateModified: '2026-10-06T12:00:00Z' }]
    if (path.startsWith('/System/Logs/Log')) return log
    if (path === '/Users/u1' && !opts.method) return { Policy: { IsAdministrator: false, AccessSchedules: server.schedule } }
    if (path === '/Users/u1/Policy' && opts.method === 'POST') { server.schedule = opts.body.AccessSchedules; server.writes++; return '' }
    throw new Error(`unexpected ${path}`)
  }
  const deps = {
    adminContext: async () => ({ available: true, session: { serverUrl: 'http://jf' }, person: { jellyfinUserId: 'u1' } }),
    call,
    decrypt: (v) => v,
  }
  return { prisma, server, deps, state: () => sync }
}
const person = { id: 'p1', providerType: 'jellyfin', jellyfinServerKind: 'jellyfin', isActive: true }
const bedtime = { bedtime: { from: '21:00', to: '07:00', days: [] } }
const opts = { timezone: 'UTC', now: new Date('2026-10-06T12:00:00Z') }

test('an empty schedule gets the bedtime; switching bedtime off takes it away again', async () => {
  const { prisma, server, deps, state } = setup()
  assert.equal(await syncBedtimeSchedule(prisma, 'acc', person, bedtime, opts, deps), 'written')
  assert.deepEqual(day(server.schedule, 'Monday'), [[7, 21]])
  assert.ok(state().jellyfinBedtime.p1)
  forgetForTests()
  assert.equal(await syncBedtimeSchedule(prisma, 'acc', person, null, opts, deps), 'cleared')
  assert.deepEqual(server.schedule, [])
  assert.equal(state().jellyfinBedtime.p1, undefined)
})

test('an administrator\'s own schedule on the server is left alone', async () => {
  const theirs = [{ DayOfWeek: 'Everyday', StartHour: 8, EndHour: 20 }]
  const { prisma, server, deps } = setup({ schedule: theirs })
  assert.equal(await syncBedtimeSchedule(prisma, 'acc', person, bedtime, opts, deps), 'theirs')
  assert.deepEqual(server.schedule, theirs)
  assert.equal(server.writes, 0)
})

test('no clock offset in the log: nothing is written', async () => {
  const { prisma, server, deps } = setup({ log: '[12:00:00.000] [INF] console only' })
  await syncBedtimeSchedule(prisma, 'acc', person, bedtime, opts, deps)
  assert.deepEqual(server.schedule, [])
  assert.equal(server.writes, 0)
})

test('while a SlickSync pause holds their schedule, it is left to the pause', async () => {
  const { prisma, server, deps } = setup()
  assert.equal(await syncBedtimeSchedule(prisma, 'acc', person, bedtime, { ...opts, entry: { until: '2026-10-07T07:00:00Z' } }, deps), 'paused')
  assert.equal(server.writes, 0)
})
