'use strict'
// Vault billing: what a save keeps, how a renewal date moves, which check an
// entry is really run with, and that a restored entry keeps "renews itself".
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { billingRulePatch, normalizeCostCycle } = require('../server/utils/vaultFields')
const { nextRenewal, renewedFrom, addMonths } = require('../server/utils/vaultRenewal')
const { effectiveTestType, storableExpiry, END_DATE_FROM_SERVICE, CHECKERS } = require('../server/utils/vaultCheckers')

const d = (s) => new Date(s)

test('a cost cycle is one of monthly, yearly, once, free - anything else is monthly', () => {
  for (const c of ['monthly', 'yearly', 'once', 'free']) assert.equal(normalizeCostCycle(c), c)
  assert.equal(normalizeCostCycle('weekly'), 'monthly')
  assert.equal(normalizeCostCycle(undefined), 'monthly')
  assert.equal(normalizeCostCycle(null), 'monthly')
})

test('once and free entries carry no end date and no renewal; free also no cost', () => {
  assert.deepEqual(billingRulePatch({ category: 'debrid', costCycle: 'once', autoRenew: true, expiresAt: d('2027-01-01') }), { expiresAt: null, autoRenew: false })
  assert.deepEqual(billingRulePatch({ category: 'debrid', costCycle: 'free', autoRenew: false, cost: 5 }), { expiresAt: null, autoRenew: false, cost: null })
})

test('monthly and yearly entries are left as they are', () => {
  assert.deepEqual(billingRulePatch({ category: 'debrid', costCycle: 'monthly', autoRenew: true, expiresAt: d('2027-01-01'), cost: 4 }), {})
  assert.deepEqual(billingRulePatch({ category: 'vpn', costCycle: 'yearly', autoRenew: false }), {})
})

test('a note is forced to be plain text to keep', () => {
  const patch = billingRulePatch({ category: 'note', costCycle: 'yearly', autoRenew: true, cost: 9, expiresAt: d('2027-01-01') })
  assert.deepEqual(patch, {
    testType: 'manual', testConfig: null, cost: null, costCycle: 'monthly',
    expiresAt: null, autoRenew: false, backupEntryId: null, dashboardUrl: null,
  })
})

test('the rules judge the values after the save: switching an auto-renewing entry to once turns renewal off', () => {
  const existing = { category: 'vpn', costCycle: 'monthly', autoRenew: true, expiresAt: d('2027-01-01') }
  const after = { ...existing, costCycle: normalizeCostCycle('once') }
  assert.equal(billingRulePatch(after).autoRenew, false)
  assert.equal(billingRulePatch(after).expiresAt, null)
})

test('nextRenewal: a future date stays, a passed one moves by whole months', () => {
  const now = d('2026-11-28T12:00:00Z')
  assert.equal(nextRenewal(d('2026-12-05T00:00:00Z'), 'monthly', now).toISOString(), '2026-12-05T00:00:00.000Z')
  assert.equal(nextRenewal(d('2026-11-20T09:30:00Z'), 'monthly', now).toISOString(), '2026-12-20T09:30:00.000Z')
  assert.equal(nextRenewal(d('2026-11-28T12:00:00Z'), 'monthly', now).toISOString(), '2026-12-28T12:00:00.000Z', 'exactly now is not the future')
})

test('nextRenewal: month ends are clamped, and the day comes back in longer months', () => {
  assert.equal(addMonths(d('2026-01-31T00:00:00Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z')
  assert.equal(addMonths(d('2026-01-31T00:00:00Z'), 2).toISOString(), '2026-03-31T00:00:00.000Z')
  assert.equal(nextRenewal(d('2026-01-31T00:00:00Z'), 'monthly', d('2026-02-10T00:00:00Z')).toISOString(), '2026-02-28T00:00:00.000Z')
  assert.equal(nextRenewal(d('2026-01-31T00:00:00Z'), 'monthly', d('2026-03-01T00:00:00Z')).toISOString(), '2026-03-31T00:00:00.000Z')
  assert.equal(nextRenewal(d('2026-01-31T00:00:00Z'), 'monthly', d('2026-04-15T00:00:00Z')).toISOString(), '2026-04-30T00:00:00.000Z')
})

test('nextRenewal: a leap day goes to Feb 28 and returns on the next leap year', () => {
  const start = d('2024-02-29T00:00:00Z')
  assert.equal(nextRenewal(start, 'yearly', d('2024-06-01T00:00:00Z')).toISOString(), '2025-02-28T00:00:00.000Z')
  assert.equal(nextRenewal(start, 'yearly', d('2027-06-01T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z')
})

test('nextRenewal: several periods behind lands on the first date in the future', () => {
  const now = d('2026-11-28T12:00:00Z')
  assert.equal(nextRenewal(d('2024-03-15T00:00:00Z'), 'monthly', now).toISOString(), '2026-12-15T00:00:00.000Z')
  assert.equal(nextRenewal(d('2019-05-10T00:00:00Z'), 'yearly', now).toISOString(), '2027-05-10T00:00:00.000Z')
  assert.equal(nextRenewal(d('2000-01-01T00:00:00Z'), 'monthly', now).toISOString(), '2026-12-01T00:00:00.000Z')
  assert.throws(() => nextRenewal(d('2026-01-01'), 'once', now))
})

test('renewedFrom: one period after the later of the date and today', () => {
  const now = d('2026-11-28T00:00:00Z')
  assert.equal(renewedFrom(d('2026-12-10T00:00:00Z'), 'monthly', now).toISOString(), '2027-01-10T00:00:00.000Z')
  assert.equal(renewedFrom(d('2026-10-01T00:00:00Z'), 'monthly', now).toISOString(), '2026-12-28T00:00:00.000Z')
  assert.equal(renewedFrom(d('2026-12-10T00:00:00Z'), 'yearly', now).toISOString(), '2027-12-10T00:00:00.000Z')
})

test('the check an entry runs: old AI entries and Usenet providers get the real one', () => {
  assert.equal(effectiveTestType({ category: 'ai', testType: 'manual' }), 'openai_compatible')
  assert.equal(effectiveTestType({ category: 'usenet_provider', testType: 'tcp_reachability' }), 'nntp_auth')
  assert.equal(effectiveTestType({ category: 'usenet_provider', testType: 'manual' }), 'manual')
  assert.equal(effectiveTestType({ category: 'debrid', testType: 'real_debrid' }), 'real_debrid')
  assert.equal(effectiveTestType({ category: 'indexer', testType: 'tcp_reachability' }), 'tcp_reachability')
  assert.equal(effectiveTestType({ category: 'note', testType: 'generic_http' }), 'manual')
})

test('every new check type is registered, and the service-dated ones are known checks', () => {
  for (const t of ['nntp_auth', 'jellyfin_auth', 'aiostreams_config', 'tmdb_key', 'omdb_key', 'mdblist_key', 'rpdb_key', 'm3u_playlist']) {
    assert.equal(typeof CHECKERS[t], 'function', t)
  }
  for (const t of END_DATE_FROM_SERVICE) assert.equal(typeof CHECKERS[t], 'function', t)
})

test('a date found by a check is not stored for an entry paid once or free', () => {
  const found = { ok: true, expiresAt: d('2027-01-01T00:00:00Z') }
  assert.equal(storableExpiry({ costCycle: 'monthly' }, found).toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(storableExpiry({ costCycle: 'once' }, found), undefined)
  assert.equal(storableExpiry({ costCycle: 'free' }, found), undefined)
  assert.equal(storableExpiry({ costCycle: 'monthly' }, { ok: true }), undefined)
})

test('both schemas have autoRenew on VaultEntry', () => {
  for (const file of ['schema.sqlite.prisma', 'schema.postgres.prisma']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'prisma', file), 'utf8')
    const model = text.slice(text.indexOf('model VaultEntry'))
    const block = model.slice(0, model.indexOf('@@map("vault_entries")'))
    assert.match(block, /autoRenew\s+Boolean\s+@default\(false\)/, file)
  }
})

test('deleting an entry to the Trash and restoring it keeps autoRenew and the billing cycle', async () => {
  const { archiveVaultDelete, restoreTrashItem } = require('../server/utils/trash')
  const entry = { id: 'e1', accountId: 'acc', name: 'VPN', category: 'vpn', encryptedSecret: 'x', costCycle: 'yearly', autoRenew: true, backupEntryId: null, dashboardUrl: null }
  const trash = []
  const created = []
  const prisma = {
    vaultEntry: {
      findFirst: async () => entry,
      findUnique: async () => null,
      create: async ({ data }) => { created.push(data); return data },
    },
    trashItem: {
      create: async ({ data }) => { const row = { id: 't1', ...data }; trash.push(row); return row },
      findFirst: async () => trash[0],
      delete: async () => ({}),
    },
  }
  const held = await archiveVaultDelete(prisma, 'acc', 'e1')
  assert.equal(JSON.parse(held.payload).entry.autoRenew, true)
  await restoreTrashItem(prisma, 'acc', 't1')
  assert.equal(created.length, 1)
  assert.equal(created[0].autoRenew, true)
  assert.equal(created[0].costCycle, 'yearly')
})
