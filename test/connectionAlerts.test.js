const test = require('node:test')
const assert = require('node:assert/strict')
const { onConnectionFailed, onConnectionRecovered, SETTLE_MS } = require('../server/utils/connectionAlerts')

// Just enough of Prisma for the alert path: account settings + the
// notification table with its (accountId, dedupeKey) unique key.
function fakePrisma(sync = {}) {
  const rows = []
  const find = (accountId, dedupeKey) => rows.find((r) => r.accountId === accountId && r.dedupeKey === dedupeKey)
  return {
    rows,
    appAccount: { findUnique: async () => ({ sync: JSON.stringify(sync) }) },
    notificationDigestEntry: { create: async () => ({}) },
    notification: {
      findUnique: async ({ where }) => find(where.accountId_dedupeKey.accountId, where.accountId_dedupeKey.dedupeKey) || null,
      upsert: async ({ where, create }) => {
        const k = where.accountId_dedupeKey
        return find(k.accountId, k.dedupeKey) || (rows.push(create), create)
      },
      create: async ({ data }) => (rows.push(data), data),
    },
  }
}

const NOW = Date.parse('2026-10-03T12:00:00Z')
const person = (extra = {}) => ({ id: 'u1', username: 'Sam', providerType: 'stremio', ...extra })

test('a first, short failure stays quiet', async () => {
  const p = fakePrisma()
  const sent = await onConnectionFailed(p, 'acc', person(), 'Connection issue: timeout', new Date(NOW), NOW)
  assert.equal(sent, false)
  assert.equal(p.rows.length, 0)
})

test('a rejected sign-in is announced straight away, once', async () => {
  const p = fakePrisma()
  const since = new Date(NOW)
  assert.equal(await onConnectionFailed(p, 'acc', person(), 'Reconnect needed: Session does not exist', since, NOW), true)
  assert.equal(await onConnectionFailed(p, 'acc', person({ providerConnectionError: 'x', providerConnectionErrorAt: since }), 'Reconnect needed: Session does not exist', since, NOW + 5 * 60000), false)
  assert.equal(p.rows.length, 1)
  assert.match(p.rows[0].title, /Sam needs to reconnect Stremio/)
  assert.equal(p.rows[0].url, '/users')
})

test('an outage is announced once it has lasted the settle time', async () => {
  const p = fakePrisma()
  const since = new Date(NOW)
  const failing = person({ providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', providerConnectionError: 'Connection issue: timeout', providerConnectionErrorAt: since })
  assert.equal(await onConnectionFailed(p, 'acc', failing, 'Connection issue: timeout', since, NOW + SETTLE_MS - 1), false)
  assert.equal(await onConnectionFailed(p, 'acc', failing, 'Connection issue: timeout', since, NOW + SETTLE_MS), true)
  assert.equal(await onConnectionFailed(p, 'acc', failing, 'Connection issue: timeout', since, NOW + 2 * SETTLE_MS), false)
  assert.equal(p.rows.length, 1)
  assert.match(p.rows[0].title, /Can't reach Sam's AIOStreams/)
})

test('recovery is announced only after an announced outage', async () => {
  const since = new Date(NOW)
  const was = person({ providerConnectionError: 'Connection issue: timeout', providerConnectionErrorAt: since })

  const quiet = fakePrisma()
  assert.equal(await onConnectionRecovered(quiet, 'acc', was), false)
  assert.equal(quiet.rows.length, 0)

  const p = fakePrisma()
  await onConnectionFailed(p, 'acc', was, 'Connection issue: timeout', since, NOW + SETTLE_MS)
  assert.equal(await onConnectionRecovered(p, 'acc', was), true)
  assert.equal(await onConnectionRecovered(p, 'acc', was), false)
  assert.equal(p.rows.length, 2)
  assert.match(p.rows[1].title, /Sam's Stremio is connected again/)
})

test('the setting turns it off', async () => {
  const p = fakePrisma({ notifyOnConnectionHealth: false })
  assert.equal(await onConnectionFailed(p, 'acc', person(), 'Reconnect needed: 401', new Date(NOW), NOW), false)
  assert.equal(p.rows.length, 0)
})

test('a merged person\'s second login does not alert on its own', async () => {
  const p = fakePrisma()
  assert.equal(await onConnectionFailed(p, 'acc', person({ __recordAs: 'u0' }), 'Reconnect needed: 401', new Date(NOW), NOW), false)
})

// A Jellyfin-compatible server down for everyone on it is one outage.
function serverPrisma(people, sync = {}) {
  const p = fakePrisma(sync)
  p.user = { findMany: async () => people }
  p.notification.findFirst = async ({ where }) => {
    const prefix = where.dedupeKey.startsWith
    const hits = p.rows.filter((r) => r.accountId === where.accountId && r.dedupeKey.startsWith(prefix))
    return hits.at(-1) || null
  }
  return p
}
const onServer = (id, username, extra = {}) => ({
  id, username, providerType: 'jellyfin', jellyfinServerKind: 'jellyfin',
  jellyfinServerUrl: 'https://jellyfin.example.com', jellyfinServerId: 'srv1', ...extra,
})

test('four people on one dead server: one alert, then one "back up"', async () => {
  const since = new Date(NOW)
  const down = (id, name) => onServer(id, name, { providerConnectionError: 'Connection issue: Could not reach the server', providerConnectionErrorAt: since })
  const people = [down('a', 'Ann'), down('b', 'Bo'), down('c', 'Cy'), down('d', 'Dee')]
  const p = serverPrisma(people)
  const probed = []
  const probe = async (url) => { probed.push(url); return false }

  // Every person on the server hits the alert path in the same pass.
  let sent = 0
  for (const u of people) sent += await onConnectionFailed(p, 'acc', u, 'Connection issue: Could not reach the server', since, NOW + SETTLE_MS, { probe }) ? 1 : 0
  assert.equal(sent, 1)
  assert.equal(p.rows.length, 1)
  assert.match(p.rows[0].title, /Can't reach the Jellyfin server/)
  assert.match(p.rows[0].body, /Ann, Bo and 2 others/)
  assert.equal(probed.length, 1, 'confirmed with the public info route before calling it an outage')

  // Later passes stay quiet while it is still down.
  for (const u of people) assert.equal(await onConnectionFailed(p, 'acc', u, 'Connection issue: Could not reach the server', since, NOW + 3 * SETTLE_MS, { probe }), false)
  assert.equal(p.rows.length, 1)

  // It comes back: the first person back says so, the rest stay quiet.
  let back = 0
  for (const u of people) back += await onConnectionRecovered(p, 'acc', u) ? 1 : 0
  assert.equal(back, 1)
  assert.equal(p.rows.length, 2)
  assert.match(p.rows[1].title, /The Jellyfin server .* is back/)
})

test('one person failing on a server others still reach is told about on their own', async () => {
  const since = new Date(NOW)
  const people = [
    onServer('a', 'Ann', { providerConnectionError: 'Connection issue: timeout', providerConnectionErrorAt: since }),
    onServer('b', 'Bo'),
  ]
  const p = serverPrisma(people)
  assert.equal(await onConnectionFailed(p, 'acc', people[0], 'Connection issue: timeout', since, NOW + SETTLE_MS, { probe: async () => false }), true)
  assert.equal(p.rows.length, 1)
  assert.match(p.rows[0].title, /Can't reach Ann's Jellyfin/)
})

test('everyone failing but the server answers: not an outage, each person as before', async () => {
  const since = new Date(NOW)
  const people = [
    onServer('a', 'Ann', { providerConnectionError: 'Connection issue: HTTP 500', providerConnectionErrorAt: since }),
    onServer('b', 'Bo', { providerConnectionError: 'Connection issue: HTTP 500', providerConnectionErrorAt: since }),
  ]
  const p = serverPrisma(people)
  for (const u of people) assert.equal(await onConnectionFailed(p, 'acc', u, 'Connection issue: HTTP 500', since, NOW + SETTLE_MS, { probe: async () => true }), true)
  assert.equal(p.rows.length, 2)
  assert.ok(p.rows.every((r) => /^Can't reach (Ann|Bo)'s Jellyfin/.test(r.title)))
})

test('a one-person server that is down still gets its server alert', async () => {
  const since = new Date(NOW)
  const solo = onServer('a', 'Ann', { jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio.example.com', jellyfinServerId: 'aio1', providerConnectionError: 'Connection issue: timeout', providerConnectionErrorAt: since })
  const p = serverPrisma([solo])
  assert.equal(await onConnectionFailed(p, 'acc', solo, 'Connection issue: timeout', since, NOW + SETTLE_MS, { probe: async () => false }), true)
  assert.match(p.rows[0].title, /Can't reach the AIOStreams server/)
  assert.match(p.rows[0].body, /for Ann until/)
})

test('a rejected sign-in stays per person even when the whole server is failing', async () => {
  const since = new Date(NOW)
  const people = [onServer('a', 'Ann', { providerConnectionError: 'Reconnect needed: 401', providerConnectionErrorAt: since })]
  const p = serverPrisma(people)
  let probed = false
  assert.equal(await onConnectionFailed(p, 'acc', people[0], 'Reconnect needed: 401', since, NOW, { probe: async () => { probed = true; return false } }), true)
  assert.equal(probed, false)
  assert.match(p.rows[0].title, /Ann needs to reconnect Jellyfin/)
})

test('the "is it up?" check: an error answer is up, no answer or a 5xx is down', async () => {
  const { serverAnswers } = require('../server/utils/connectionAlerts')
  const original = global.fetch
  const answer = (status, body) => async () => ({ ok: status < 400, status, text: async () => body })
  try {
    global.fetch = answer(200, '{"ServerName":"x"}')
    assert.equal(await serverAnswers('https://jf.example.com'), true)
    // What a real AIOStreams says at a configuration address it doesn't know.
    global.fetch = answer(401, '{"message":"Unauthorized"}')
    assert.equal(await serverAnswers('https://aio.example.com/jellyfin/u/family'), true)
    global.fetch = answer(404, 'Unknown configuration')
    assert.equal(await serverAnswers('https://aio.example.com/jellyfin/u/family'), true)
    global.fetch = answer(502, 'Bad Gateway')
    assert.equal(await serverAnswers('https://jf.example.com'), false)
    global.fetch = async () => { throw new TypeError('fetch failed') }
    assert.equal(await serverAnswers('https://jf.example.com'), false)
  } finally {
    global.fetch = original
  }
})
