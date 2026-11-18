// A sign-in check that the provider turns away for being busy (rate limit,
// outage) says nothing about the password: the Vault keeps its last real
// answer and raises no "check failed" alert. A real refusal still fails.
// Made-up addresses and passwords only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { runCheck } = require('../server/utils/vaultCheckers')
const { runVaultChecks } = require('../server/utils/vaultMonitor')

const realFetch = globalThis.fetch

// Nuvio's sign-in server answering with a fixed status and body.
function nuvioAnswers(t, status, body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  t.after(() => { globalThis.fetch = realFetch })
}

const busy = { message: 'API rate limit exceeded', request_id: '0123456789abcdef' }

test('Nuvio check: a rate limit is not a failed password, and reads plainly', async (t) => {
  nuvioAnswers(t, 429, busy)
  const r = await runCheck('nuvio_auth', 'some-password', { identifier: 'viewer@example.com' })
  assert.equal(r.ok, null)
  assert.equal(r.transient, true)
  assert.doesNotMatch(r.message, /[{}"]/, 'no raw server reply in the message')
  assert.doesNotMatch(r.message, /viewer@example\.com/)
})

test('Nuvio check: the server being down is not a failed password either', async (t) => {
  nuvioAnswers(t, 503, { message: 'upstream unavailable' })
  const r = await runCheck('nuvio_auth', 'some-password', { identifier: 'viewer@example.com' })
  assert.equal(r.ok, null)
  assert.equal(r.transient, true)
})

test('Nuvio check: a wrong password still fails', async (t) => {
  nuvioAnswers(t, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
  const r = await runCheck('nuvio_auth', 'wrong-password', { identifier: 'viewer@example.com' })
  assert.equal(r.ok, false)
  assert.match(r.message, /Invalid login credentials/)
})

test('the scheduled check keeps the last answer and raises nothing when Nuvio is busy', async (t) => {
  nuvioAnswers(t, 429, busy)
  const touched = []
  const entry = {
    id: 'v1', name: 'Main sign-in', category: 'nuvio', provider: 'viewer@example.com', testType: 'nuvio_auth',
    encryptedSecret: 'x', testConfig: null, lastCheckStatus: 'ok', lastCheckMessage: 'Nuvio login succeeded', expiresAt: null,
  }
  const prisma = {
    appAccount: { findMany: async () => [{ id: 'acc-1', sync: JSON.stringify({ notifications: { enabled: true } }) }] },
    vaultEntry: {
      findMany: async () => [entry],
      update: async (q) => { touched.push(['update', q.data]); return entry },
      findFirst: async () => null,
    },
    automationRule: { findMany: async ({ where }) => { touched.push(['event', where.triggerType]); return [] } },
    notification: { create: async () => { touched.push(['bell']); return {} } },
  }
  await runVaultChecks({ prisma, decrypt: () => 'some-password', getAccountId: () => 'acc-1' })
  assert.deepEqual(touched, [], 'no status change, no alert, no automation event')
})

test('the scheduled check still alerts when the password is really refused', async (t) => {
  nuvioAnswers(t, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
  const touched = []
  const entry = {
    id: 'v1', name: 'Main sign-in', category: 'nuvio', provider: 'viewer@example.com', testType: 'nuvio_auth',
    encryptedSecret: 'x', testConfig: null, lastCheckStatus: 'ok', lastCheckMessage: 'Nuvio login succeeded', expiresAt: null,
  }
  const prisma = {
    appAccount: { findMany: async () => [{ id: 'acc-1', sync: '{}' }] },
    vaultEntry: {
      findMany: async () => [entry],
      update: async (q) => { touched.push(['update', q.data.lastCheckStatus]); return entry },
      findFirst: async () => null,
    },
    automationRule: { findMany: async ({ where }) => { touched.push(['event', where.triggerType]); return [] } },
  }
  await runVaultChecks({ prisma, decrypt: () => 'wrong-password', getAccountId: () => 'acc-1' })
  assert.deepEqual(touched, [['update', 'error'], ['event', 'vault.check_failed']])
})
