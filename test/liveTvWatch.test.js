// Live TV watch: one failed look is not an alarm, two in a row are; coming
// back is said once; a login about to run out is said once per end date; a
// source is not looked at more often than it should be; alerts never carry an
// address or a login; a source taken out of the setup is forgotten.
const test = require('node:test')
const assert = require('node:assert/strict')
const { watchLiveTv, nextState, describe, sourceKey, isDue, CHECK_EVERY_MS, RECHECK_FAILING_MS } = require('../server/utils/liveTvWatch')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-27T12:00:00Z')

function fakePrisma(sync = {}) {
  const store = { sync }
  return {
    store,
    appAccount: {
      findUnique: async () => ({ sync: store.sync }),
      update: async ({ data }) => { store.sync = data.sync; return {} },
    },
  }
}
const person = { id: 'u1', username: 'Sam', accountId: 'acc' }
const m3u = { type: 'm3u', options: { name: 'Home TV', playlist: 'http://tv.example.com/get.php?username=viewer&password=secret-pass' } }
const xtream = { type: 'xtream', options: { name: 'Sports', server: 'http://iptv.example.com', username: 'viewer', password: 'secret-pass' } }

test('one failure says nothing; the second in a row raises the alarm once', async () => {
  const prisma = fakePrisma()
  const fail = async () => ({ ok: false, message: 'The playlist server returned 502' })
  const a = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0, check: fail })
  assert.equal(a.alerts.length, 0)
  const b = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + RECHECK_FAILING_MS, check: fail })
  assert.equal(b.alerts.length, 1)
  assert.match(b.alerts[0].title, /^Sam’s Live TV playlist “Home TV” stopped working$/)
  assert.match(b.alerts[0].body, /returned 502/)
  const c = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 2 * RECHECK_FAILING_MS, check: fail })
  assert.equal(c.alerts.length, 0)
})

test('coming back is said once, and the count starts over', async () => {
  const prisma = fakePrisma()
  const fail = async () => ({ ok: false, message: 'Timed out' })
  const ok = async () => ({ ok: true, message: 'Playlist loads' })
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0, check: fail })
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + RECHECK_FAILING_MS, check: fail })
  const back = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 2 * RECHECK_FAILING_MS, check: ok })
  assert.equal(back.alerts.length, 1)
  assert.match(back.alerts[0].title, /is working again$/)
  const quiet = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 2 * RECHECK_FAILING_MS + CHECK_EVERY_MS, check: ok })
  assert.equal(quiet.alerts.length, 0)
  const once = await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 2 * RECHECK_FAILING_MS + 2 * CHECK_EVERY_MS, check: fail })
  assert.equal(once.alerts.length, 0)
})

test('a working source is not looked at again for six hours; a failing one sooner', async () => {
  const prisma = fakePrisma()
  let looks = 0
  const ok = async () => { looks++; return { ok: true } }
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0, check: ok })
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 30 * 60 * 1000, check: ok })
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + 5 * HOUR, check: ok })
  assert.equal(looks, 1)
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0 + CHECK_EVERY_MS, check: ok })
  assert.equal(looks, 2)
  assert.equal(isDue({ checkedAt: new Date(T0).toISOString(), fails: 1 }, T0 + RECHECK_FAILING_MS), true)
  assert.equal(isDue({ checkedAt: new Date(T0).toISOString(), fails: 0 }, T0 + RECHECK_FAILING_MS), false)
})

test('a login about to run out is said once per end date', async () => {
  const prisma = fakePrisma()
  const ends = new Date(T0 + 3 * DAY)
  const ok = async () => ({ ok: true, expiresAt: ends })
  const a = await watchLiveTv(prisma, person, { presets: [xtream] }, { now: T0, check: ok })
  assert.equal(a.alerts.length, 1)
  assert.match(a.alerts[0].title, /^Sam’s IPTV login “Sports” runs out in 3 days$/)
  const b = await watchLiveTv(prisma, person, { presets: [xtream] }, { now: T0 + CHECK_EVERY_MS, check: ok })
  assert.equal(b.alerts.length, 0)
  // renewed for a month: quiet; then the new date comes close and it is said again
  const renewed = new Date(T0 + 30 * DAY)
  const c = await watchLiveTv(prisma, person, { presets: [xtream] }, { now: T0 + 2 * CHECK_EVERY_MS, check: async () => ({ ok: true, expiresAt: renewed }) })
  assert.equal(c.alerts.length, 0)
  const d = await watchLiveTv(prisma, person, { presets: [xtream] }, { now: T0 + 29 * DAY + HOUR, check: async () => ({ ok: true, expiresAt: renewed }) })
  assert.equal(d.alerts.length, 1)
  assert.match(d.alerts[0].title, /runs out tomorrow$/)
})

test('alerts and what is kept never carry an address, a username or a password', async () => {
  const prisma = fakePrisma()
  // the network layer's wording can name the server and even echo the address
  const fail = async (src) => ({ ok: false, message: src.kind === 'm3u' ? 'getaddrinfo ENOTFOUND tv.example.com (http://tv.example.com/get.php?username=viewer&password=secret-pass)' : 'connect ECONNREFUSED iptv.example.com:80' })
  await watchLiveTv(prisma, person, { presets: [m3u, xtream] }, { now: T0, check: fail })
  const r = await watchLiveTv(prisma, person, { presets: [m3u, xtream] }, { now: T0 + RECHECK_FAILING_MS, check: fail })
  assert.equal(r.alerts.length, 2)
  const everything = JSON.stringify(r.alerts) + JSON.stringify(prisma.store.sync)
  for (const secret of ['secret-pass', 'tv.example.com', 'iptv.example.com', 'viewer', 'get.php']) assert.equal(everything.includes(secret), false, secret)
  for (const a of r.alerts) { assert.equal(a.url, '/users/u1'); assert.match(a.dedupeKey, /^livetv:u1:[0-9a-f]{12}:down:/) }
})

test('a source taken out of the setup is forgotten, and other settings are left alone', async () => {
  const prisma = fakePrisma({ aioRotateKeys: { u1: true } })
  const fail = async () => ({ ok: false, message: 'x' })
  await watchLiveTv(prisma, person, { presets: [m3u, xtream] }, { now: T0, check: fail })
  assert.equal(Object.keys(prisma.store.sync.liveTv.u1).length, 2)
  await watchLiveTv(prisma, person, { presets: [xtream] }, { now: T0 + 60 * 1000, check: fail })
  assert.deepEqual(Object.keys(prisma.store.sync.liveTv.u1), [sourceKey({ kind: 'xtream', server: 'http://iptv.example.com', username: 'viewer' })])
  await watchLiveTv(prisma, person, { presets: [] }, { now: T0 + 2 * 60 * 1000, check: fail })
  assert.equal(prisma.store.sync.liveTv, undefined)
  assert.deepEqual(prisma.store.sync.aioRotateKeys, { u1: true })
})

test('settings kept as text stay text', async () => {
  const prisma = fakePrisma(JSON.stringify({ a: 1 }))
  await watchLiveTv(prisma, person, { presets: [m3u] }, { now: T0, check: async () => ({ ok: true }) })
  assert.equal(typeof prisma.store.sync, 'string')
  assert.equal(JSON.parse(prisma.store.sync).a, 1)
})

test('nextState and describe on their own', () => {
  const first = nextState(null, { ok: false, message: 'Timed out' }, T0)
  assert.equal(first.events.length, 0)
  assert.equal(first.state.fails, 1)
  const second = nextState(first.state, { ok: false, message: 'Timed out' }, T0 + 1)
  assert.deepEqual(second.events.map((e) => e.type), ['down'])
  const text = describe({ type: 'expiring', days: 5, expiresAt: new Date('2026-12-02T00:00:00Z') }, person, { kind: 'm3u', name: 'Home TV' })
  assert.equal(text.title, 'Sam’s Live TV playlist “Home TV” runs out in 5 days')
  assert.match(text.body, /It ends Dec 2\./)
})
