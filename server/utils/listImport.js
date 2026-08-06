/**
 * List import: pull an existing list from TMDb or MDBList into a new
 * SlickSync CustomList. Auto-detects the provider from the pasted URL so
 * there's one "Import" flow, not a provider picker.
 *
 * TMDb: the v3 List resource (`/list/{id}`) is genuinely public with just an
 * API key - no OAuth - but it is MOVIES ONLY (TMDb's mixed-media v4 Lists
 * require account-level OAuth, out of scope for a key-only integration).
 * Each item needs a follow-up `/movie/{id}/external_ids` call to resolve an
 * IMDb id, since v3 list items only carry the TMDb id - same resolution
 * SlickSync's own cast-credit click-through already does (see discover.js's
 * /imdb-id endpoint).
 *
 * MDBList: purpose-built for exactly this - `/lists/{username}/{slug}`
 * resolves a public list by its own URL slug, `/lists/{listid}/items`
 * returns items with imdb_id already attached (no per-item follow-up
 * needed), and covers movies AND shows. Confirmed via MDBList's own OpenAPI
 * spec: public lists are readable with any valid API key, not just the list
 * owner's. Posters aren't in the base item response, so they're backfilled
 * per item via the same Cinemeta lookup the rest of the app already uses
 * (resolveSinglePoster) - bounded concurrency so a large list doesn't fire
 * hundreds of simultaneous requests at Cinemeta.
 *
 * Letterboxd is deliberately NOT supported - it has no public API at all;
 * the only way to read a list is scraping their HTML, which is fragile and
 * outside what this app should depend on.
 */
const { resolveSinglePoster } = require('./libraryHelpers')

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342'
// Real lists are almost always well under this; it exists purely as a
// safety bound (MDBList imports do one Cinemeta poster lookup per item, so
// an unbounded list could otherwise take minutes and hammer Cinemeta).
// Surfaced to the caller via `truncated` so it's never a silent cut.
const MAX_IMPORT_ITEMS = 200

async function resolveKeyFromSettings(prisma, getAccountId, req, settingsField, envVar) {
  try {
    const accountId = (typeof getAccountId === 'function' ? getAccountId(req) : null) || 'default'
    const acc = await prisma?.appAccount?.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = acc?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    const fromSettings = cfg && typeof cfg === 'object' && typeof cfg[settingsField] === 'string' ? cfg[settingsField].trim() : ''
    if (fromSettings) return fromSettings
  } catch {}
  return (process.env[envVar] || '').trim()
}

const resolveTmdbKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'tmdbApiKey', 'TMDB_API_KEY')
const resolveMdblistKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'mdblistApiKey', 'MDBLIST_API_KEY')

// accountId-direct variant (no req/getAccountId) for background jobs that
// already have (prisma, accountId) in scope from their own per-account
// loop, rather than an Express request.
async function resolveOmdbKeyForAccount(prisma, accountId) {
  return resolveKeyFromSettings(prisma, () => accountId, null, 'omdbApiKey', 'OMDB_API_KEY')
}
const resolveOmdbKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'omdbApiKey', 'OMDB_API_KEY')

function detectProvider(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host === 'mdblist.com') return 'mdblist'
    if (host === 'themoviedb.org') return 'tmdb'
  } catch {}
  return null
}

// Small bounded-concurrency map - avoids firing N simultaneous requests at
// an external service for a large list.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function importFromTmdb(apiKey, url) {
  if (!apiKey) throw new Error('TMDb API key not configured (Settings -> SlickTrax)')
  const m = url.match(/\/list\/(\d+)/)
  const listId = m ? m[1] : null
  if (!listId) throw new Error('Could not find a list id in that TMDb URL')

  const rsp = await fetch(`https://api.themoviedb.org/3/list/${listId}?api_key=${encodeURIComponent(apiKey)}`)
  if (!rsp.ok) throw new Error(rsp.status === 404 ? 'TMDb list not found (it may be private)' : 'TMDb request failed')
  const data = await rsp.json()
  const rawItems = data.items || []
  const truncated = rawItems.length > MAX_IMPORT_ITEMS
  const capped = rawItems.slice(0, MAX_IMPORT_ITEMS).filter((it) => !it.media_type || it.media_type === 'movie')

  const resolved = await mapLimit(capped, 8, async (it) => {
    try {
      const ext = await fetch(`https://api.themoviedb.org/3/movie/${it.id}/external_ids?api_key=${encodeURIComponent(apiKey)}`)
      if (!ext.ok) return null
      const extData = await ext.json()
      if (!extData.imdb_id) return null
      return {
        id: extData.imdb_id,
        type: 'movie',
        name: it.title || 'Untitled',
        poster: it.poster_path ? `${TMDB_IMG}${it.poster_path}` : null,
        year: it.release_date ? it.release_date.slice(0, 4) : null,
      }
    } catch { return null }
  })

  return { name: data.name || 'Imported list', items: resolved.filter(Boolean), truncated, totalAvailable: rawItems.length }
}

async function importFromMdblist(apiKey, url) {
  if (!apiKey) throw new Error('MDBList API key not configured (Settings -> SlickTrax)')
  const m = url.match(/mdblist\.com\/lists\/([^/?#]+)\/([^/?#]+)/i)
  if (!m) throw new Error('Could not find a username/list in that MDBList URL')
  const [, username, slug] = m

  const listRsp = await fetch(`https://api.mdblist.com/lists/${encodeURIComponent(username)}/${encodeURIComponent(slug)}?apikey=${encodeURIComponent(apiKey)}`)
  if (!listRsp.ok) throw new Error(listRsp.status === 404 ? 'MDBList list not found (it may be private)' : 'MDBList request failed')
  const listData = await listRsp.json()
  const list = Array.isArray(listData) ? listData[0] : listData
  const listId = list?.id
  if (!listId) throw new Error('Could not resolve that MDBList list')

  const itemsRsp = await fetch(`https://api.mdblist.com/lists/${listId}/items?apikey=${encodeURIComponent(apiKey)}&limit=${MAX_IMPORT_ITEMS + 1}`)
  if (!itemsRsp.ok) throw new Error('MDBList request failed fetching list items')
  const page = await itemsRsp.json()
  const rawItems = Array.isArray(page) ? page : (Array.isArray(page.items) ? page.items : [...(page.movies || []), ...(page.shows || [])])

  const truncated = rawItems.length > MAX_IMPORT_ITEMS
  const capped = rawItems.slice(0, MAX_IMPORT_ITEMS)

  const resolved = await mapLimit(capped, 8, async (it) => {
    const imdbId = it.imdb_id || it.ids?.imdb
    if (!imdbId) return null
    const type = (it.mediatype === 'show' || it.mediatype === 'tv') ? 'series' : 'movie'
    const poster = await resolveSinglePoster(imdbId, type, null).catch(() => null)
    return { id: imdbId, type, name: it.title || 'Untitled', poster, year: it.release_year ? String(it.release_year) : null }
  })

  return { name: list.name || 'Imported list', items: resolved.filter(Boolean), truncated, totalAvailable: rawItems.length }
}

// Suggest titles for a catalog by name (e.g. "Halloween", "Christmas
// Movies") - explicitly a preview, never auto-added. Seeds from TMDb's own
// keyword taxonomy when the name matches a real keyword ("halloween",
// "christmas", ...), which is far more precise than a plain text search
// (keyword-tagged results are actually about that theme, not just titles
// that happen to contain the word); falls back to a plain title search when
// nothing matches, so an unusual catalog name still returns *something*
// rather than an empty result.
const MAX_SUGGESTIONS = 20

// Words that carry no thematic signal on their own ("90s movies" is about
// the 90s, not about "movies"); stripped before retrying a keyword lookup so
// a natural catalog name like "30 days of halloween" still resolves to the
// real "halloween" keyword instead of failing outright.
const GENERIC_WORDS = new Set([
  'movie', 'movies', 'film', 'films', 'show', 'shows', 'tv', 'series',
  'collection', 'picks', 'favorites', 'favourites', 'list', 'of', 'the',
  'a', 'an', 'and', 'for', 'to', 'my', 'best', 'top', 'classics', 'classic',
])

// A bare decade ("90s", "1980s") isn't a TMDb keyword - it's a release-date
// range - so it needs its own discover query rather than a keyword lookup.
// Two-digit decades are assumed 1900s/2000s by the usual cutoff (a plain
// "90s" almost never means 1890s or 2090s in this context).
function extractDecadeRange(query) {
  const m = String(query || '').match(/\b(19|20)?(\d)0s\b/i)
  if (!m) return null
  const century = m[1] || (Number(m[2]) <= 2 ? '20' : '19')
  const startYear = Number(`${century}${m[2]}0`)
  return { start: startYear, end: startYear + 9 }
}

async function lookupTmdbKeywordId(text, apiKey) {
  const rsp = await fetch(`https://api.themoviedb.org/3/search/keyword?query=${encodeURIComponent(text)}&api_key=${encodeURIComponent(apiKey)}`)
  const data = rsp.ok ? await rsp.json() : { results: [] }
  const results = data.results || []
  if (results.length === 0) return null
  // TMDb's keyword search doesn't rank an exact match first - confirmed
  // live, "horror" returns b-horror, j-horror, horror in that order, so a
  // blind results[0] picked a niche subgenre keyword with almost no 90s/
  // quality-filtered matches instead of the real "horror" keyword (1 vs 3
  // results for the exact same discover query, live-verified). Prefer an
  // exact case-insensitive name match when the results include one.
  const exact = results.find((r) => r.name?.toLowerCase() === text.toLowerCase())
  return (exact || results[0]).id
}

async function discoverByKeyword(keywordId, apiKey) {
  // Sorted by rating, not raw popularity - confirmed live against the real
  // "christmas" keyword: TMDb's community tagging attaches it to any film
  // with so much as a Christmas-set scene (Iron Man 3, Die Hard), and
  // sorted by popularity.desc those blockbusters buried every actual
  // Christmas movie under them (top 6 results were all Harry Potter).
  // vote_average.desc + a vote_count floor (filters out obscure high-rated
  // flukes with a handful of votes) surfaces genuine, well-regarded genre
  // entries (It's a Wonderful Life, Klaus, The Nightmare Before Christmas)
  // mixed with the big franchises instead of drowned out by them.
  const qualitySort = 'sort_by=vote_average.desc&vote_count.gte=500'
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?with_keywords=${keywordId}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?with_keywords=${keywordId}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

async function discoverByDecade(range, apiKey) {
  const dateParams = `primary_release_date.gte=${range.start}-01-01&primary_release_date.lte=${range.end}-12-31`
  const airDateParams = `first_air_date.gte=${range.start}-01-01&first_air_date.lte=${range.end}-12-31`
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?${dateParams}&sort_by=popularity.desc&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?${airDateParams}&sort_by=popularity.desc&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

// Both a genre keyword AND a decade in the same query ("90s horror movies")
// - TMDb's discover endpoint takes with_keywords and a date range in the
// same call, so this is a real intersection, not two separate searches
// merged after the fact. Confirmed real bug this was written to fix: a
// decade-only search for this exact query returned Shawshank Redemption,
// Fight Club, Titanic, Forrest Gump, The Lion King - the most popular 90s
// titles overall, zero of them horror, because the decade branch used to
// short-circuit and never even attempt a keyword lookup for "horror".
async function discoverByKeywordAndDecade(keywordId, range, apiKey) {
  const qualitySort = 'sort_by=vote_average.desc&vote_count.gte=500'
  const dateParams = `primary_release_date.gte=${range.start}-01-01&primary_release_date.lte=${range.end}-12-31`
  const airDateParams = `first_air_date.gte=${range.start}-01-01&first_air_date.lte=${range.end}-12-31`
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?with_keywords=${keywordId}&${dateParams}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?with_keywords=${keywordId}&${airDateParams}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

async function suggestTitlesForCatalog(apiKey, query, excludeIds = []) {
  if (!apiKey) throw new Error('TMDb API key not configured (Settings -> SlickTrax)')
  const trimmed = String(query || '').trim()
  if (!trimmed) throw new Error('Nothing to search for - rename the catalog to something like "Halloween" first')
  const excluded = new Set(excludeIds)

  let candidates = []
  const decadeRange = extractDecadeRange(trimmed)
  // Strip the decade token itself ("90s", "1990s") before looking for a
  // genre/theme keyword in what's left - otherwise a query like "90s horror
  // movies" would try to look up "90s" as a keyword alongside "horror".
  const withoutDecade = trimmed.replace(/\b(19|20)?\d0s\b/i, ' ').replace(/\s+/g, ' ').trim()
  const significant = withoutDecade
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w))
    .sort((a, b) => b.length - a.length)

  let keywordId = null
  if (significant.length > 0) {
    keywordId = await lookupTmdbKeywordId(withoutDecade, apiKey)
    if (!keywordId) {
      // Full remaining phrase didn't match a real keyword - retry word by
      // word, longest first, so multi-word themes still win over incidental
      // single-word matches ("30 days of halloween" -> "halloween").
      for (const word of significant) {
        keywordId = await lookupTmdbKeywordId(word, apiKey)
        if (keywordId) break
      }
    }
  }

  if (decadeRange && keywordId) {
    candidates = await discoverByKeywordAndDecade(keywordId, decadeRange, apiKey)
  } else if (decadeRange) {
    candidates = await discoverByDecade(decadeRange, apiKey)
  } else if (keywordId) {
    candidates = await discoverByKeyword(keywordId, apiKey)
  } else {
    // No matching TMDb keyword at all - fall back to a plain title search
    // (movies only; TV title search is noisier for a theme-driven name).
    const searchRsp = await fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(trimmed)}&api_key=${encodeURIComponent(apiKey)}`)
    const searchData = searchRsp.ok ? await searchRsp.json() : { results: [] }
    candidates = (searchData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) }))
  }

  const capped = candidates.slice(0, MAX_SUGGESTIONS * 2) // headroom for excluded/unresolvable dropouts
  const resolved = await mapLimit(capped, 8, async (c) => {
    try {
      const ext = await fetch(`https://api.themoviedb.org/3/${c.type === 'series' ? 'tv' : 'movie'}/${c.tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`)
      if (!ext.ok) return null
      const extData = await ext.json()
      const imdbId = extData.imdb_id
      if (!imdbId || excluded.has(imdbId)) return null
      return {
        id: imdbId,
        type: c.type,
        name: c.name || 'Untitled',
        poster: c.poster ? `${TMDB_IMG}${c.poster}` : null,
        year: c.year || null,
      }
    } catch { return null }
  })

  return resolved.filter(Boolean).slice(0, MAX_SUGGESTIONS)
}

// Export a local CustomList's items as a brand-new MDBList list - the
// inverse of importFromMdblist above, using the same create-list +
// add-items pair confirmed live against MDBList's own OpenAPI spec
// (https://api.mdblist.com/schema/): POST /lists/user/add creates the list,
// POST /lists/{id}/items/add populates it (movies/shows split by imdb id).
// The list is created private by default - purely a mechanical copy of this
// app's own catalog, not something meant to be discoverable on MDBList.
async function exportListToMdblist(apiKey, listName, items) {
  if (!apiKey) throw new Error('MDBList API key not configured (Settings -> SlickTrax)')

  const createRsp = await fetch(`https://api.mdblist.com/lists/user/add?apikey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: listName, private: true }),
  })
  if (!createRsp.ok) throw new Error('Failed to create the MDBList list')
  const createdRaw = await createRsp.json()
  const created = Array.isArray(createdRaw) ? createdRaw[0] : createdRaw
  const listId = created?.id
  if (!listId) throw new Error('MDBList did not return a list id')

  const movies = items.filter((i) => i.type === 'movie').map((i) => ({ imdb: i.id }))
  const shows = items.filter((i) => i.type === 'series').map((i) => ({ imdb: i.id }))

  const addRsp = await fetch(`https://api.mdblist.com/lists/${listId}/items/add?apikey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ movies, shows }),
  })
  if (!addRsp.ok) throw new Error('List created, but failed to add items to it')
  const addResult = await addRsp.json()
  // Confirmed live against a real MDBList account this session: each of
  // added/existing/not_found is itself an object broken down by media type
  // ({movies, shows, seasons, episodes}), not a flat number - summing
  // movies+shows here (seasons/episodes don't apply, this app only ever
  // sends whole movies/shows).
  const sumMoviesAndShows = (obj) => (Number(obj?.movies) || 0) + (Number(obj?.shows) || 0)

  return {
    id: listId,
    name: created?.name || listName,
    slug: created?.slug || null,
    // Confirmed live: the create response returns this directly (e.g.
    // https://mdblist.com/lists/{username}/{slug}) - no need to guess the
    // username or construct it ourselves.
    url: created?.url || null,
    added: sumMoviesAndShows(addResult?.added),
    existing: sumMoviesAndShows(addResult?.existing),
    notFound: sumMoviesAndShows(addResult?.not_found),
  }
}

// Shared core of POST /api/lists/:id/refresh, factored out so the manual
// (human-reviewed diff, opt-in apply) route and the automatic scheduler
// (server/utils/catalogAutoRefresh.js, always applies - that's the whole
// point of opting in) both go through the exact same fetch-and-diff logic
// rather than two copies that could quietly drift apart. accountId-direct
// (no req) since the scheduler has no Express request to resolve a key
// from - same pattern as resolveOmdbKeyForAccount above.
async function refreshListFromSourceForAccount(prisma, accountId, list) {
  if (!list.importSourceUrl) throw new Error('This catalog wasn\'t imported from a list, so there\'s no source to refresh from.')
  const provider = detectProvider(list.importSourceUrl)
  if (!provider) throw new Error('The source URL saved for this catalog is no longer recognized')

  const noReq = () => accountId
  let result
  if (provider === 'tmdb') {
    const key = await resolveTmdbKey(prisma, noReq, null)
    result = await importFromTmdb(key, list.importSourceUrl)
  } else {
    const key = await resolveMdblistKey(prisma, noReq, null)
    result = await importFromMdblist(key, list.importSourceUrl)
  }

  const parseItems = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
  const currentIds = new Set(parseItems(list.itemsJson).map((i) => i.id))
  const freshIds = new Set(result.items.map((i) => i.id))
  const added = result.items.filter((i) => !currentIds.has(i.id)).length
  const removed = [...currentIds].filter((id) => !freshIds.has(id)).length
  const unchanged = result.items.length - added

  return { items: result.items, added, removed, unchanged }
}

module.exports = { detectProvider, importFromTmdb, importFromMdblist, exportListToMdblist, resolveTmdbKey, resolveMdblistKey, resolveOmdbKey, resolveOmdbKeyForAccount, refreshListFromSourceForAccount, suggestTitlesForCatalog, MAX_IMPORT_ITEMS }
