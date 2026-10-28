const test = require('node:test')
const assert = require('node:assert/strict')

// Made-up people and ids throughout.
const realFetch = global.fetch
test.afterEach(() => { global.fetch = realFetch })

process.env.PERSON_FACTS_CACHE_FILE = '' // never touch the real data folder

const fresh = () => {
  delete require.cache[require.resolve('../server/utils/wikipediaFacts')]
  return require('../server/utils/wikipediaFacts')
}

const row = (o = {}) => ({
  birth: { value: '1994-03-12T00:00:00Z' }, bprec: { value: '11' },
  placeLabel: { value: 'Springfield' }, countryLabel: { value: 'Freedonia' },
  article: { value: 'https://en.wikipedia.org/wiki/Jordan_Ellis' },
  ...o,
})

// A fake Wikidata + Wikipedia; remembers every request.
function fakeWiki({ bindings = [row()], extract = 'Jordan Ellis is an actress. She began on stage.', type = 'standard' } = {}) {
  const calls = []
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    calls.push({ host: u.host, path: u.pathname, query: u.searchParams.get('query'), headers: opts.headers || {} })
    if (u.host === 'query.wikidata.org') return { ok: true, status: 200, json: async () => ({ results: { bindings } }) }
    if (u.host === 'en.wikipedia.org') return { ok: true, status: 200, json: async () => ({ type, extract }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return calls
}

test('TMDb wins: a person TMDb has fully described is never looked up', async () => {
  const { enrichFacts } = fresh()
  const calls = fakeWiki()
  const facts = { birthday: '1990-01-01', placeOfBirth: 'Town, Region, Freedonia', bio: 'TMDb bio.' }
  const out = await enrichFacts({ tmdbId: 11, imdbId: 'nm0000001', facts })
  assert.equal(calls.length, 0)
  assert.deepEqual(out, { facts, factsFrom: null, factsFilled: [] })
})

test('what TMDb has is kept; only the missing parts are filled', async () => {
  const { enrichFacts } = fresh()
  fakeWiki()
  const out = await enrichFacts({ tmdbId: 12, imdbId: 'nm0000002', facts: { birthday: '1980-05-05', placeOfBirth: 'Town, Region, Freedonia', bio: null } })
  assert.equal(out.facts.birthday, '1980-05-05')
  assert.equal(out.facts.placeOfBirth, 'Town, Region, Freedonia')
  assert.equal(out.facts.bio, 'Jordan Ellis is an actress. She began on stage.')
  assert.equal(out.factsFrom, 'wikipedia')
  assert.deepEqual(out.factsFilled, ['bio'])
})

test('missing facts are filled: birthday, birthplace and bio', async () => {
  const { enrichFacts } = fresh()
  fakeWiki()
  const out = await enrichFacts({ tmdbId: 13, imdbId: 'nm0000003', facts: { birthday: null, placeOfBirth: null, bio: null } })
  assert.equal(out.facts.birthday, '1994-03-12')
  assert.equal(out.facts.placeOfBirth, 'Springfield, Freedonia')
  assert.deepEqual(out.factsFilled, ['bio', 'birthday', 'birthplace'])
})

test('a country-only birthplace is upgraded when Wikidata has a city, and kept when it has none', async () => {
  let { enrichFacts } = fresh()
  fakeWiki()
  let out = await enrichFacts({ tmdbId: 14, imdbId: 'nm0000004', facts: { birthday: '1990-01-01', placeOfBirth: 'Freedonia', bio: 'x' } })
  // TMDb has a birthday and bio, but the country-only place triggers the look-up.
  assert.equal(out.facts.placeOfBirth, 'Springfield, Freedonia')
  assert.deepEqual(out.factsFilled, ['birthplace'])

  ;({ enrichFacts } = fresh())
  fakeWiki({ bindings: [row({ placeLabel: { value: 'Freedonia' }, countryLabel: { value: 'Freedonia' } })] })
  out = await enrichFacts({ tmdbId: 15, imdbId: 'nm0000005', facts: { birthday: '1990-01-01', placeOfBirth: 'Freedonia', bio: 'x' } })
  assert.equal(out.facts.placeOfBirth, 'Freedonia')
  assert.equal(out.factsFrom, null)
})

test('only a birthday known to the day is taken, and a death date fills too', () => {
  const { _test } = fresh()
  const read = _test.readBindings([{ birth: { value: '1950-01-01T00:00:00Z' }, bprec: { value: '9' }, death: { value: '2020-02-03T00:00:00Z' }, dprec: { value: '11' } }])
  assert.equal(read.birthday, null)
  assert.equal(read.deathday, '2020-02-03')
  const { fillFacts } = fresh()
  const { facts } = fillFacts({ birthday: '1950-06-07', deathday: null, placeOfBirth: null, bio: 'x' }, { deathday: '2020-02-03' })
  assert.equal(facts.deathday, '2020-02-03')
})

test('the Wikipedia summary goes through shortBiography', async () => {
  const { enrichFacts } = fresh()
  const { shortBiography } = require('../server/utils/personFacts')
  const extract = 'Jordan Ellis (/ˈdʒɔːrdən/; born March 12, 1994) is an actress. She began on stage. A second line. A third line. A fourth line follows here.'
  fakeWiki({ extract })
  const out = await enrichFacts({ tmdbId: 16, imdbId: 'nm0000006', facts: {} })
  assert.equal(out.facts.bio, shortBiography(extract))
  assert.ok(!out.facts.bio.includes('born'))
})

test('the lookup goes by IMDb id, falls back to the TMDb id, and says who is asking', async () => {
  let { enrichFacts } = fresh()
  let calls = fakeWiki()
  await enrichFacts({ tmdbId: 17, imdbId: 'nm0000007', facts: {} })
  assert.match(calls[0].query, /wdt:P345 "nm0000007"/)
  assert.match(calls[0].headers['User-Agent'], /github\.com\/slicknsliding\/slicksync/)
  assert.ok(!/@/.test(calls[0].headers['User-Agent']))
  assert.equal(calls[1].host, 'en.wikipedia.org')
  assert.equal(calls[1].path, '/api/rest_v1/page/summary/Jordan_Ellis')

  ;({ enrichFacts } = fresh())
  calls = fakeWiki()
  await enrichFacts({ tmdbId: 18, imdbId: null, facts: {} })
  assert.match(calls[0].query, /wdt:P4985 "18"/)
})

test('an answer is remembered, a miss too: the second card makes no request', async () => {
  const { enrichFacts } = fresh()
  let calls = fakeWiki()
  const first = await enrichFacts({ tmdbId: 19, imdbId: 'nm0000009', facts: {} })
  const used = calls.length
  assert.ok(used > 0)
  const second = await enrichFacts({ tmdbId: 19, imdbId: 'nm0000009', facts: {} })
  assert.equal(calls.length, used)
  assert.deepEqual(second, first)

  calls = fakeWiki({ bindings: [] })
  const miss = await enrichFacts({ tmdbId: 20, imdbId: 'nm0000010', facts: {} })
  assert.equal(miss.factsFrom, null)
  const again = await enrichFacts({ tmdbId: 20, imdbId: 'nm0000010', facts: {} })
  assert.equal(calls.length, 1)
  assert.equal(again.factsFrom, null)
})

test('a slow Wikidata is given up on at the time-box and the card stays as TMDb had it', async () => {
  const { enrichFacts } = fresh()
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const facts = { birthday: null, placeOfBirth: 'Freedonia', bio: null }
  const t0 = Date.now()
  const out = await enrichFacts({ tmdbId: 21, imdbId: 'nm0000011', facts }, { timeoutMs: 60 })
  assert.ok(Date.now() - t0 < 1000)
  assert.deepEqual(out, { facts, factsFrom: null, factsFilled: [] })
})

test('a failing Wikidata returns the TMDb card, and a failure is not remembered as a miss for a month', async () => {
  const { enrichFacts, _test } = fresh()
  global.fetch = async () => { throw new Error('network down') }
  const facts = { birthday: null, placeOfBirth: null, bio: null }
  const out = await enrichFacts({ tmdbId: 22, imdbId: 'nm0000012', facts })
  assert.deepEqual(out, { facts, factsFrom: null, factsFilled: [] })
  assert.equal(_test.cache.get('tmdb:22').failed, true)

  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) })
  const limited = await enrichFacts({ tmdbId: 23, imdbId: 'nm0000013', facts })
  assert.equal(limited.factsFrom, null)

  // A summary that fails still leaves the dates and place.
  global.fetch = async (url) => (new URL(url).host === 'query.wikidata.org'
    ? { ok: true, status: 200, json: async () => ({ results: { bindings: [row()] } }) }
    : { ok: false, status: 500, json: async () => ({}) })
  const partial = await enrichFacts({ tmdbId: 24, imdbId: 'nm0000014', facts })
  assert.equal(partial.facts.birthday, '1994-03-12')
  assert.equal(partial.facts.bio, null)
})

test('no ids means no lookup', async () => {
  const { enrichFacts } = fresh()
  const calls = fakeWiki()
  const out = await enrichFacts({ tmdbId: null, imdbId: null, facts: {} })
  assert.equal(calls.length, 0)
  assert.equal(out.factsFrom, null)
})
