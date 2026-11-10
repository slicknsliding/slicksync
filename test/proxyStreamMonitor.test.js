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

test('parseDisplayName: underscores separate words like dots do', () => {
  // Read as a film called "Resident Evil 2026": no poster, no details.
  assert.equal(parseDisplayName('Resident_Evil_2026_2160p_MA_WEB-DL_H265_SDR_DDP_Atmos_5_1_English-HONE.mkv'), 'Resident Evil (2026)')
  assert.equal(parseDisplayName('Blade_Runner_2049_2017_1080p_BluRay.mkv'), 'Blade Runner 2049 (2017)')
  assert.equal(parseDisplayName('Some_Film_1979_2024_Remastered_1080p.mkv'), 'Some Film (1979)')
  assert.equal(parseDisplayName('Resident.Evil.2026.MULTI.1080p.mkv'), 'Resident Evil (2026)')
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

test('resolveUserForActiveConnection: ambiguous email + no fallback list attributes to nobody', () => {
  // Two users share me@example.com and nothing distinguishes them, so with no
  // AIOSTREAMS_FALLBACK_USER_IDS to break the tie this returns null rather
  // than picking one.
  //
  // It used to return the first candidate. That was changed deliberately -
  // guessing meant one household member's watch history could be credited to
  // another, and an unattributed stream is a far smaller problem than a
  // wrongly attributed one. This assertion still encoded the old behaviour.
  const prev = process.env.AIOSTREAMS_FALLBACK_USER_IDS
  delete process.env.AIOSTREAMS_FALLBACK_USER_IDS
  try {
    assert.equal(resolveUserForActiveConnection(USERS, 'me'), null)
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


// --- parseDisplayName: which number is the year -----------------------------

test('parseDisplayName: a number in the title is not the release year', () => {
  assert.equal(parseDisplayName('Blade.Runner.2049.2017.1080p.BluRay.mkv'), 'Blade Runner 2049 (2017)')
  assert.equal(parseDisplayName('Wonder.Woman.1984.2020.mkv'), 'Wonder Woman 1984 (2020)')
  assert.equal(parseDisplayName('Death.Race.2000.1975.mkv'), 'Death Race 2000 (1975)')
  assert.equal(parseDisplayName('Fall.2.2025.2160p.WEB-DL.mkv'), 'Fall 2 (2025)')
})

test('parseDisplayName: a number that cannot be a release year stays in the title', () => {
  assert.equal(parseDisplayName('Blade.Runner.2049.1080p.BluRay.mkv'), 'Blade Runner 2049')
})

test('parseDisplayName: a title that is itself a year', () => {
  assert.equal(parseDisplayName('1917.2019.mkv'), '1917 (2019)')
  assert.equal(parseDisplayName('1984.1984.1080p.mkv'), '1984 (1984)')
  assert.equal(parseDisplayName('2001.A.Space.Odyssey.1968.1080p.mkv'), '2001 A Space Odyssey (1968)')
})

test('parseDisplayName: a year among the release tags does not replace the release year', () => {
  assert.equal(parseDisplayName('Movie.2019.1080p.BluRay.REMASTERED.2021.x264.mkv'), 'Movie (2019)')
  assert.equal(parseDisplayName('Film.1999.Remastered.2021.1080p.mkv'), 'Film (1999)')
})

test('parseDisplayName: no extension, name ends in its year', () => {
  assert.equal(parseDisplayName('Some.Film.2020'), 'Some Film (2020)')
})

test('parseDisplayName: scene tags after a second year do not make it an edition year', () => {
  assert.equal(parseDisplayName('Wonder.Woman.1984.2020.PROPER.1080p.WEB-DL.mkv'), 'Wonder Woman 1984 (2020)')
  assert.equal(parseDisplayName('Wonder.Woman.1984.2020.REPACK.1080p.mkv'), 'Wonder Woman 1984 (2020)')
  assert.equal(parseDisplayName('Alien.1979.2024.PROPER.Remaster.1080p.mkv'), 'Alien (1979)')
})

test('parseDisplayName: any wording between two years means the second dates a re-release', () => {
  assert.equal(parseDisplayName('The.Wizard.of.Oz.1939.75th.Anniversary.Edition.2013.1080p.mkv'), 'The Wizard of Oz (1939)')
  assert.equal(parseDisplayName('Casablanca.1942.70th.Anniversary.2012.1080p.mkv'), 'Casablanca (1942)')
  assert.equal(parseDisplayName('Metropolis.1927.Restored.Version.2010.1080p.mkv'), 'Metropolis (1927)')
  assert.equal(parseDisplayName('Titanic.1997.3D.2012.1080p.mkv'), 'Titanic (1997)')
  assert.equal(parseDisplayName('Movie.2010.Extended.Version.2012.mkv'), 'Movie (2010)')
})

test('parseDisplayName: a title that starts with a release-tag word keeps it', () => {
  assert.equal(parseDisplayName('4K.Kings.2019.1080p.WEB.mkv'), '4K Kings (2019)')
  assert.equal(parseDisplayName('HDR.Hunters.2020.1080p.mkv'), 'HDR Hunters (2020)')
})

test('parseDisplayName: a second year that dates an edition is not the release year', () => {
  assert.equal(parseDisplayName('Blade.Runner.1982.Final.Cut.2007.1080p.mkv'), 'Blade Runner (1982)')
  assert.equal(parseDisplayName('Alien.1979.2024.Remaster.1080p.mkv'), 'Alien (1979)')
  assert.equal(parseDisplayName('Movie.Name.1998.2000.Special.Edition.1080p.mkv'), 'Movie Name (1998)')
})
