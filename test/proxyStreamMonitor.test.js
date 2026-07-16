const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDisplayName, resolveUserForActiveConnection } = require('../server/utils/proxyStreamMonitor')

test('parseDisplayName: null/empty input returns null', () => {
  assert.equal(parseDisplayName(null), null)
  assert.equal(parseDisplayName(''), null)
})

test('parseDisplayName: parenthesized year with trailing release tags (the "Send Help" regression)', () => {
  // Was previously mismatched to a different, wrong "Send Help" movie
  // because the parenthesized year broke title extraction, which then
  // broke year-based disambiguation downstream in attemptPosterLookup.
  assert.equal(parseDisplayName('Send.Help.(2026).VU.Blu-ray.mkv'), 'Send Help (2026)')
})

test('parseDisplayName: non-parenthesized year with trailing release tags', () => {
  assert.equal(parseDisplayName('Send.Help.2026.WEB-DL.mkv'), 'Send Help (2026)')
})

test('parseDisplayName: parenthesized year with nothing after it', () => {
  assert.equal(parseDisplayName('Movie.Title.(2020).mkv'), 'Movie Title (2020)')
})

test('parseDisplayName: strips a numeric-junk parenthetical that is not a year', () => {
  assert.equal(parseDisplayName('Some.Show.(1.23.45).2019.mkv'), 'Some Show (2019)')
})

test('parseDisplayName: no year present falls back to quality-tag stripping', () => {
  assert.equal(
    parseDisplayName('Show.Name.S01E01.1080p.WEBRip.x264.mkv'),
    'Show Name S01E01'
  )
})

test('parseDisplayName: no year and no recognized quality tag returns the cleaned filename', () => {
  assert.equal(parseDisplayName('Just.A.Title.mkv'), 'Just A Title')
})

// --- resolveUserForActiveConnection: attribute a proxy stream to a SlickSync user ---

const USERS = [
  { id: 'u-stremio', username: 'SLICK STREMIO', email: 'me@example.com' },
  { id: 'u-nuvio', username: 'NuvioSLICK', email: 'me@example.com' },
  { id: 'u-other', username: 'someoneelse', email: 'other@example.com' },
]

test('resolveUserForActiveConnection: exact username match wins', () => {
  const u = resolveUserForActiveConnection(USERS, 'someoneelse')
  assert.equal(u.id, 'u-other')
})

test('resolveUserForActiveConnection: unique email local-part match when username does not match', () => {
  const u = resolveUserForActiveConnection([USERS[2], { id: 'u-solo', username: 'x', email: 'alice@example.com' }], 'alice')
  assert.equal(u.id, 'u-solo')
})

test('resolveUserForActiveConnection: ambiguous email + no fallback list falls back to first candidate', () => {
  // Two users share me@example.com; with no AIOSTREAMS_FALLBACK_USER_IDS set,
  // returns the first candidate rather than throwing.
  const prev = process.env.AIOSTREAMS_FALLBACK_USER_IDS
  delete process.env.AIOSTREAMS_FALLBACK_USER_IDS
  try {
    const u = resolveUserForActiveConnection(USERS, 'me')
    assert.ok(u && (u.id === 'u-stremio' || u.id === 'u-nuvio'))
  } finally {
    if (prev !== undefined) process.env.AIOSTREAMS_FALLBACK_USER_IDS = prev
  }
})

test('resolveUserForActiveConnection: ambiguous email uses AIOSTREAMS_FALLBACK_USER_IDS order', () => {
  const prev = process.env.AIOSTREAMS_FALLBACK_USER_IDS
  process.env.AIOSTREAMS_FALLBACK_USER_IDS = 'u-nuvio,u-stremio'
  try {
    const u = resolveUserForActiveConnection(USERS, 'me')
    assert.equal(u.id, 'u-nuvio', 'earliest id in the fallback list should win')
  } finally {
    if (prev !== undefined) process.env.AIOSTREAMS_FALLBACK_USER_IDS = prev
    else delete process.env.AIOSTREAMS_FALLBACK_USER_IDS
  }
})

test('resolveUserForActiveConnection: no match returns null', () => {
  assert.equal(resolveUserForActiveConnection(USERS, 'nobody'), null)
})
