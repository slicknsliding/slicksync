const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDisplayName } = require('../server/utils/proxyStreamMonitor')

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
