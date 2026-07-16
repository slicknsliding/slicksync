const test = require('node:test')
const assert = require('node:assert/strict')
const { getAccountDateString, resolveAccountTimezone, DEFAULT_TIMEZONE } = require('../server/utils/dateUtils')

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
