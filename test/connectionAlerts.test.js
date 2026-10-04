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
