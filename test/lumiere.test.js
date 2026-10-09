const test = require('node:test')
const assert = require('node:assert/strict')

// A fake LumiereDB: answers by path, and remembers every request.
function fakeLumiere(routes) {
  const calls = []
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} })
    const route = routes[u.pathname]
    if (!route) return { ok: false, status: 404, json: async () => ({ error: 'Not Found' }) }
    const { status = 200, body } = typeof route === 'function' ? route(u, opts) : route
    return { ok: status < 400, status, json: async () => body }
  }
  return calls
}

// An account whose settings hold `sync`.
const accountWith = (sync) => ({ appAccount: { findUnique: async () => ({ sync: JSON.stringify(sync) }) } })

const fresh = () => {
  delete require.cache[require.resolve('../server/utils/lumiere')]
  delete require.cache[require.resolve('../server/utils/titleFinder')]
  return require('../server/utils/lumiere')
}

test('an address is saved as just the server, whatever was pasted', () => {
  const { normalizeAddress } = fresh()
  assert.equal(normalizeAddress('http://lumiere-db:8000/'), 'http://lumiere-db:8000')
  assert.equal(normalizeAddress('lumiere.example.com'), 'http://lumiere.example.com')
  assert.equal(normalizeAddress('https://lumiere.example.com/readyz'), 'https://lumiere.example.com')
  assert.equal(normalizeAddress('https://lumiere.example.com/search?query=dune'), 'https://lumiere.example.com')
  assert.equal(normalizeAddress('https://lumiere.example.com/lumiere/'), 'https://lumiere.example.com/lumiere')
  assert.equal(normalizeAddress('ftp://x'), '')
  assert.equal(normalizeAddress(''), '')
})

test('a user name and password in the address become a sign-in header, never part of the URL', () => {
  const { _test } = fresh()
  const { url, headers } = _test.requestParts('https://me:p%40ss@lumiere.example.com', '/readyz', { a: 1, b: '', c: ['x', 'y'] })
  assert.equal(url, 'https://lumiere.example.com/readyz?a=1&c=x%2Cy')
  assert.equal(headers.Authorization, `Basic ${Buffer.from('me:p@ss').toString('base64')}`)
})

test('a public instance has no LumiereDB at all; a self-hosted one uses its own, then the server’s', async () => {
  process.env.LUMIERE_DB_URL = 'http://shared-lumiere:8000'
  const config = require('../server/utils/config')
  const was = config.INSTANCE_TYPE
  try {
    config.INSTANCE_TYPE = 'public'
    let lumiere = fresh()
    assert.equal(await lumiere.lumiereAddress(accountWith({}), 'acc'), '')
    assert.equal(await lumiere.lumiereAddress(accountWith({ lumiereDbUrl: 'https://mine.example.com' }), 'acc'), '')
    config.INSTANCE_TYPE = 'private'
    lumiere = fresh()
    assert.equal(await lumiere.lumiereAddress(accountWith({}), 'acc'), 'http://shared-lumiere:8000')
    assert.equal(await lumiere.lumiereAddress(accountWith({ lumiereDbUrl: 'https://mine.example.com' }), 'acc'), 'https://mine.example.com')
  } finally {
    config.INSTANCE_TYPE = was
    delete process.env.LUMIERE_DB_URL
  }
})

test('the status says ready, still building, or not LumiereDB at all', async () => {
  const lumiere = fresh()
  fakeLumiere({ '/readyz': { body: { status: 'ready' } } })
  assert.equal((await lumiere.lumiereStatus('http://a:8000', { fresh: true })).state, 'ready')
  fakeLumiere({ '/readyz': { status: 503, body: { error: 'no data', status: 'not_ready' } } })
  assert.equal((await lumiere.lumiereStatus('http://b:8000', { fresh: true })).state, 'building')
  fakeLumiere({})
  assert.equal((await lumiere.lumiereStatus('http://c:8000', { fresh: true })).state, 'wrong')
  fakeLumiere({ '/readyz': { status: 401, body: {} } })
  assert.equal((await lumiere.lumiereStatus('http://d:8000', { fresh: true })).state, 'login')
  global.fetch = async () => { throw new TypeError('fetch failed') }
  assert.equal((await lumiere.lumiereStatus('http://e:8000', { fresh: true })).state, 'unreachable')
  assert.equal((await lumiere.lumiereStatus('')).state, 'off')
})

test('search results become Discover items with IMDb ids and posters', async () => {
  const lumiere = fresh()
  const calls = fakeLumiere({
    '/search': { body: { items: [{ tconst: 'tt0816692', titleType: 'movie', startYear: 2014, primaryTitle: 'Interstellar' }, { tconst: 'bad' }] } },
  })
  const items = await lumiere.searchTitles('http://l:8000', 'movie', '  intersteller  ')
  assert.deepEqual(items.map((i) => [i.id, i.name, i.releaseInfo]), [['tt0816692', 'Interstellar', '2014']])
  assert.match(items[0].poster, /tt0816692/)
  assert.deepEqual(calls[0].params, { query: 'intersteller', type: 'movies', limit: '30' })
})

test('a Smart Catalog rule becomes LumiereDB’s own filters, people looked up by name', async () => {
  fresh()
  const calls = fakeLumiere({
    '/readyz': { body: { status: 'ready' } },
    '/search/people': (u) => ({
      body: {
        person: { nconst: u.searchParams.get('query') === 'Al Pacino' ? 'nm0000199' : u.searchParams.get('query') === 'Robert De Niro' ? 'nm0000134' : 'nm0000217', name: u.searchParams.get('query') },
        items: [{ tconst: 'tt0071562', primaryTitle: 'The Godfather Part II', startYear: 1974 }],
      },
    }),
    '/discover': { body: { items: [{ tconst: 'tt0113277', primaryTitle: 'Heat', startYear: 1995 }], meta: { hasMore: false } } },
  })
  const { findTitles } = require('../server/utils/titleFinder')
  const prisma = accountWith({ lumiereDbUrl: 'http://l:8000' })
  const { items, engine } = await findTitles(prisma, 'acc', {
    type: 'movie', genres: ['Crime', 'Sci-Fi'], excludeGenres: ['Romance'], cast: ['Al Pacino', 'Robert De Niro'], castMatch: 'all',
    directors: ['Martin Scorsese'], minVotes: 50000, minRating: 7, sort: 'votes', yearFrom: 1990, minRuntimeMinutes: 90,
  }, { limit: 10, excludeIds: ['tt0110912', 'not-an-id'] })
  assert.equal(engine, 'lumiere')
  assert.deepEqual(items, [{ id: 'tt0113277', type: 'movie', name: 'Heat', poster: 'https://images.metahub.space/poster/medium/tt0113277/img', year: 1995 }])
  const d = calls.find((c) => c.path === '/discover')
  assert.equal(d.method, 'POST')
  assert.deepEqual(d.body, { exclude_tconsts: ['tt0110912'] })
  assert.deepEqual(d.params, {
    type: 'movies', genres: 'crime,sci-fi', exclude_genres: 'romance', year_from: '1990', min_rating: '7', min_votes: '50000',
    runtime_min: '90', sort: 'votes', with_cast: 'nm0000199,nm0000134', cast_match: 'all', with_director: 'nm0000217', limit: '10',
    title_type: 'movie,tvmovie',
  })
})

test('a series rule: still airing means an episode in the last year; ended means none since', async () => {
  fresh()
  const { _test } = require('../server/utils/titleFinder')
  const year = new Date().getFullYear()
  const base = { genres: [], excludeGenres: [], cast: [], directors: [], castMatch: 'all' }
  const airing = await _test.lumiereFilters('http://l', { ...base, seriesStatus: 'airing', lastAiredFrom: null }, 'series')
  assert.equal(airing.last_aired_from, year - 1)
  const ended = await _test.lumiereFilters('http://l', { ...base, seriesStatus: 'ended', lastAiredFrom: 2020 }, 'series')
  assert.equal(ended.last_aired_from, 2020)
  assert.equal(ended.last_aired_to, year - 2)
  const film = await _test.lumiereFilters('http://l', { ...base, seriesStatus: 'airing' }, 'movie')
  assert.equal(film.last_aired_from, undefined)
  // Best-rated with no vote floor would be a wall of titles twelve people rated.
  assert.equal(film.min_votes, 1000)
})

test('nobody of that name stops the rule instead of quietly dropping the person', async () => {
  fresh()
  fakeLumiere({ '/readyz': { body: { status: 'ready' } }, '/search/people': { status: 404, body: { error: 'no person' } } })
  const { findTitles } = require('../server/utils/titleFinder')
  await assert.rejects(
    findTitles(accountWith({ lumiereDbUrl: 'http://l2:8000' }), 'acc', { type: 'movie', cast: ['Nobody Atall'] }, { limit: 5 }),
    /Couldn’t find anyone called “Nobody Atall”/,
  )
})

test('with neither a TMDb key nor a LumiereDB, it says what is needed', async () => {
  fresh()
  const { findTitles } = require('../server/utils/titleFinder')
  await assert.rejects(findTitles(accountWith({}), 'acc', { type: 'movie' }, { limit: 5 }), /TMDb key or a LumiereDB/)
})

test('a "movies and series" rule takes turns between the two', () => {
  fresh()
  const { _test } = require('../server/utils/titleFinder')
  assert.deepEqual(_test.interleave([1, 2, 3], ['a'], 3), [1, 'a', 2])
})

test('an import row matches by year, or by the exact title when it has none', async () => {
  fresh()
  fakeLumiere({
    '/search': (u) => ({
      body: {
        items: u.searchParams.get('query').startsWith('dune')
          ? [{ tconst: 'tt15239678', primaryTitle: 'Dune: Part Two', startYear: 2024 }, { tconst: 'tt1160419', primaryTitle: 'Dune', startYear: 2021 }]
          : [{ tconst: 'tt0468569', primaryTitle: 'The Dark Knight', startYear: 2008 }],
      },
    }),
  })
  const { resolveRowToImdbItem } = require('../server/utils/csvHistoryImport')
  const colMap = { title: 'Name', year: 'Year' }
  assert.equal((await resolveRowToImdbItem({ Name: 'dune', Year: '2021' }, colMap, null, 'http://l3:8000')).imdbId, 'tt1160419')
  assert.equal((await resolveRowToImdbItem({ Name: 'the dark knight' }, { title: 'Name' }, null, 'http://l3:8000')).imdbId, 'tt0468569')
  // A title that isn't the same, with no year to go on, isn't guessed.
  assert.equal(await resolveRowToImdbItem({ Name: 'dark knight rises' }, { title: 'Name' }, null, 'http://l3:8000'), null)
})
