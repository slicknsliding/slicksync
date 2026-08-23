const test = require('node:test')
const assert = require('node:assert/strict')
const { getAccountDateString, resolveAccountTimezone, DEFAULT_TIMEZONE, createdAtFromCuid } = require('../server/utils/dateUtils')

test('getAccountDateString formats in the given timezone, not UTC', () => {
  // Regression test for the "Watch Time Today" bug: 3am UTC on July 16 is
  // still 8pm July 15 in America/Los_Angeles (PDT, UTC-7) - the whole point
  // of this helper is that these two must NOT agree.
  const date = new Date('2026-07-16T03:00:00Z')
  assert.equal(getAccountDateString(date, 'America/Los_Angeles'), '2026-07-15')
  assert.equal(getAccountDateString(date, 'UTC'), '2026-07-16')
})

test('getAccountDateString defaults to DEFAULT_TIMEZONE when none given', () => {
  const date = new Date('2026-07-16T03:00:00Z')
  assert.equal(getAccountDateString(date), getAccountDateString(date, DEFAULT_TIMEZONE))
})

test('getAccountDateString falls back instead of throwing on an invalid timezone', () => {
  const date = new Date('2026-07-16T12:00:00Z')
  assert.doesNotThrow(() => getAccountDateString(date, 'Not/AZone'))
  assert.match(getAccountDateString(date, 'Not/AZone'), /^\d{4}-\d{2}-\d{2}$/)
})

test('resolveAccountTimezone reads AppAccount.sync.accountTimezone (stringified JSON, SQLite shape)', async () => {
  const fakePrisma = {
    appAccount: {
      findFirst: async () => ({ sync: JSON.stringify({ accountTimezone: 'Europe/London' }) }),
    },
  }
  assert.equal(await resolveAccountTimezone(fakePrisma, 'test-account-string'), 'Europe/London')
})

test('resolveAccountTimezone reads AppAccount.sync.accountTimezone (plain object, Postgres shape)', async () => {
  const fakePrisma = {
    appAccount: {
      findFirst: async () => ({ sync: { accountTimezone: 'Asia/Tokyo' } }),
    },
  }
  assert.equal(await resolveAccountTimezone(fakePrisma, 'test-account-object'), 'Asia/Tokyo')
})

test('resolveAccountTimezone falls back to DEFAULT_TIMEZONE when unset', async () => {
  const fakePrisma = {
    appAccount: {
      findFirst: async () => ({ sync: null }),
    },
  }
  assert.equal(await resolveAccountTimezone(fakePrisma, 'test-account-unset'), DEFAULT_TIMEZONE)
})

test('resolveAccountTimezone falls back to DEFAULT_TIMEZONE if the DB call throws', async () => {
  const fakePrisma = {
    appAccount: {
      findFirst: async () => { throw new Error('db down') },
    },
  }
  assert.equal(await resolveAccountTimezone(fakePrisma, 'test-account-error'), DEFAULT_TIMEZONE)
})

test('resolveAccountTimezone caches per account so a poll cycle does not hit the DB per item', async () => {
  let calls = 0
  const fakePrisma = {
    appAccount: {
      findFirst: async () => { calls++; return { sync: { accountTimezone: 'Pacific/Auckland' } } },
    },
  }
  const first = await resolveAccountTimezone(fakePrisma, 'test-account-cache')
  const second = await resolveAccountTimezone(fakePrisma, 'test-account-cache')
  assert.equal(first, 'Pacific/Auckland')
  assert.equal(second, 'Pacific/Auckland')
  assert.equal(calls, 1, 'second call should hit the in-memory cache, not the DB')
})

test('createdAtFromCuid recovers the creation time embedded in a cuid v1', () => {
  // cuid v1 is `c` + Date.now() in base36 + counter + fingerprint + random,
  // so the id itself is the timestamp. This is what lets the Group detail
  // page show a real "Created" date for a model that has no createdAt column.
  const ms = Date.UTC(2026, 7, 4, 7, 46, 4, 589) // 2026-08-04T07:46:04.589Z
  const id = 'c' + ms.toString(36) + '001slb2keh7fxhlh'.slice(0, 16)
  assert.equal(id.length, 25)
  assert.equal(createdAtFromCuid(id).toISOString(), '2026-08-04T07:46:04.589Z')
})

test('createdAtFromCuid returns null for ids that are not cuid v1', () => {
  // The caller renders "Unknown" on null. Guessing a date for a uuid or a
  // seeded id would put a confidently wrong timestamp in the UI, which is
  // worse than admitting we do not know.
  for (const id of [
    '550e8400-e29b-41d4-a716-446655440000', // uuid
    'group-1',                              // seeded/imported
    '',
    null,
    undefined,
    12345,
    'cmsectay5001slb2keh7fxhl',             // 24 chars, one short
    'cMSECTAY5001slb2keh7fxhlh',            // base36 is lowercase only
  ]) {
    assert.equal(createdAtFromCuid(id), null, `expected null for ${String(id)}`)
  }
})

test('createdAtFromCuid rejects timestamps outside a plausible range', () => {
  // A block that parses as base36 but lands centuries away means the id was
  // never a cuid v1 - the digits just happened to be legal.
  const ancient = 'c' + (0).toString(36).padStart(8, '0') + '001slb2keh7fxhlh'.slice(0, 16)
  assert.equal(createdAtFromCuid(ancient), null, '1970 should be rejected')

  const farFuture = 'c' + Date.UTC(2300, 0, 1).toString(36) + '001slb2keh7fxhlh'.slice(0, 16)
  assert.equal(createdAtFromCuid(farFuture), null, 'year 2300 should be rejected')
})
