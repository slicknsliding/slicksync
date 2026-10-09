// LumiereDB - a self-hosted search and discovery service built on IMDb's
// own datasets (ghcr.io/0xconstant1/lumiere-db). When an account points
// SlickSync at one, Discover search forgives typos, people search needs no
// TMDb key, Popular/Trending come from IMDb's numbers, Smart Catalogs get
// rules TMDb can't answer, and history imports match more titles. With no
// address set, every one of those keeps working the way it did before.
//
// IMDb's datasets are for personal, non-commercial use, and their terms
// forbid running a movie database for other people. So it's for
// self-hosted instances only: on a public instance it's off entirely.

const { INSTANCE_TYPE } = require('./config')

const TIMEOUT_MS = 6000
const STATUS_TTL_MS = 60 * 1000
const CACHE_TTL_MS = 10 * 60 * 1000
const LIST_TTL_MS = 30 * 60 * 1000
const MAX_CACHE = 300

// IMDb's terms ask for this line wherever their data is shown.
const ATTRIBUTION = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.'

const isPublic = () => INSTANCE_TYPE === 'public'

/** The address as a base every path can be appended to, or '' when it isn't one. */
function normalizeAddress(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return ''
  let url
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`) } catch { return '' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  // Someone pasting the readiness check or a search they tried keeps only
  // the server's own address.
  url.pathname = url.pathname.replace(/\/(readyz|search(\/people)?|lists\/[a-z]+|discover(\/options)?)\/?$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

async function readCfg(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId || 'default' }, select: { sync: true } })
  let cfg = acc?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  return cfg && typeof cfg === 'object' ? cfg : {}
}

/** The LumiereDB this account uses: its own, else the server's. None on a public instance. */
async function lumiereAddress(prisma, accountId) {
  if (isPublic()) return ''
  let own = ''
  try { own = normalizeAddress((await readCfg(prisma, accountId)).lumiereDbUrl) } catch {}
  if (own) return own
  return normalizeAddress(process.env.LUMIERE_DB_URL || '')
}

// fetch refuses a URL carrying a user name and password, which is how
// someone who put their LumiereDB behind a login would paste it.
function requestParts(base, path, params) {
  const url = new URL(`${base}${path}`)
  const headers = { Accept: 'application/json' }
  if (url.username || url.password) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    url.username = ''
    url.password = ''
  }
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  return { url: url.toString(), headers }
}

function fail(message, status) {
  return Object.assign(new Error(message), { status })
}

async function call(base, path, { params, body, timeoutMs = TIMEOUT_MS } = {}) {
  if (!base) throw fail('No LumiereDB address', 0)
  if (isPublic()) {
    const { assertSafeUrl } = require('./safeUrl')
    try { await assertSafeUrl(base) } catch (e) {
      throw fail(e.message === 'blocked host' ? 'That address is on a private network, which this instance can’t reach' : `That address can’t be used: ${e.message}`, 0)
    }
  }
  const { url, headers } = requestParts(base, path, params)
  let res
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw fail(e?.name === 'TimeoutError' ? 'LumiereDB didn’t answer in time' : 'Can’t reach LumiereDB at that address', 0)
  }
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) throw fail(data?.error || `LumiereDB answered ${res.status}`, res.status)
  return data
}

// ---- Status -------------------------------------------------------------

const statusCache = new Map()

/**
 * { state: 'off' | 'ready' | 'building' | 'unreachable' | 'login' | 'wrong', message }
 * 'building' is the first start (or a schema upgrade): it downloads IMDb's
 * data and builds its index, and answers nothing until that's done.
 */
async function lumiereStatus(base, { fresh = false } = {}) {
  if (!base) return { state: 'off', message: 'No LumiereDB address set' }
  const hit = statusCache.get(base)
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status
  let status
  try {
    const data = await call(base, '/readyz', { timeoutMs: 4000 })
    status = data?.status === 'ready'
      ? { state: 'ready', message: 'Ready' }
      : { state: 'wrong', message: 'Something answered at that address, but it isn’t LumiereDB' }
  } catch (e) {
    if (e.status === 503) status = { state: 'building', message: 'Downloading IMDb’s data and building its index - the first start takes about ten minutes' }
    else if (e.status === 401 || e.status === 403) status = { state: 'login', message: 'A sign-in page answered - put the user name and password in the address (https://name:password@host)' }
    else if (e.status) status = { state: 'wrong', message: 'Something answered at that address, but it isn’t LumiereDB' }
    else status = { state: 'unreachable', message: e.message }
  }
  statusCache.set(base, { at: Date.now(), status })
  return status
}

/** The account's LumiereDB base when it's ready to answer, else ''. */
async function readyLumiere(prisma, accountId) {
  const base = await lumiereAddress(prisma, accountId)
  if (!base) return ''
  const { state } = await lumiereStatus(base)
  return state === 'ready' ? base : ''
}

// ---- Cache --------------------------------------------------------------

const cache = new Map()
async function cached(key, ttl, load) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.value
  }
  const value = await load()
  // An empty answer is never kept: a blip must not pin "nothing" for everyone.
  if (Array.isArray(value) ? value.length > 0 : value != null) {
    cache.set(key, { at: Date.now(), value })
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  }
  return value
}

// ---- Reads --------------------------------------------------------------

const typeParam = (type) => (type === 'series' ? 'series' : 'movies')

/** One title row in the shape Discover and catalogs use. */
function toItem(row, type) {
  if (!row || typeof row.tconst !== 'string' || !/^tt\d+$/.test(row.tconst)) return null
  const year = Number(row.startYear) || null
  const rating = Number(row.averageRating)
  return {
    id: row.tconst,
    type: type === 'series' ? 'series' : 'movie',
    name: row.primaryTitle || row.originalTitle || 'Unknown',
    poster: `https://images.metahub.space/poster/medium/${row.tconst}/img`,
    releaseInfo: year ? (type === 'series' && row.endYear ? `${year}-${row.endYear}` : String(year)) : null,
    year,
    imdbRating: Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : null,
    votes: Number(row.numVotes) || null,
    genres: Array.isArray(row.genres) ? row.genres.map(genreLabel) : [],
    ...(Array.isArray(row.roles) ? { roles: row.roles } : {}),
  }
}

const clip = (text, max) => Array.from(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('')

/** Title search: typos, run-together words, sequel numbers, a trailing year, nicknames. */
async function searchTitles(base, type, query, { limit = 30 } = {}) {
  const q = clip(query, 120)
  if (!q) return []
  return cached(`s|${base}|${type}|${limit}|${q.toLowerCase()}`, CACHE_TTL_MS, async () => {
    const data = await call(base, '/search', { params: { query: q, type: typeParam(type), limit: Math.min(50, Math.max(1, limit)) } })
    return (data?.items || []).map((r) => toItem(r, type)).filter(Boolean)
  })
}

/** People search: a full name, and the titles that person is best known for. */
async function searchPeople(base, type, query) {
  const q = clip(query, 80)
  if (!q) return null
  return cached(`p|${base}|${type}|${q.toLowerCase()}`, CACHE_TTL_MS, async () => {
    let data
    try {
      data = await call(base, '/search/people', { params: { query: q, type: typeParam(type), limit: 200 } })
    } catch (e) {
      if (e.status === 404) return null
      throw e
    }
    const items = (data?.items || []).map((r) => toItem(r, type)).filter(Boolean)
    if (!items.length) return null
    const person = data?.person || data?.meta?.person || null
    return {
      person: person ? { id: person.nconst || null, name: person.primaryName || person.name || q } : { id: null, name: q },
      items,
    }
  })
}

/** Every id on IMDb's Popular (500 deep) or Trending (100) list, optionally one genre. */
async function listIds(base, list, type, genre) {
  const g = genre ? String(genre).toLowerCase() : ''
  return cached(`l|${base}|${list}|${type}|${g}`, LIST_TTL_MS, async () => {
    const rows = []
    let cursor = ''
    for (let page = 0; page < 12; page++) {
      const data = await call(base, `/lists/${list}`, { params: { type: typeParam(type), limit: 50, genres: g, cursor } })
      for (const r of data?.items || []) {
        const item = toItem(r, type)
        if (item) rows.push(item)
      }
      cursor = data?.meta?.nextCursor || ''
      if (!data?.meta?.hasMore || !cursor) break
    }
    return rows
  })
}

/** The titles one person (an nconst) is known for, of one type. */
async function personTitles(base, nconst, type) {
  if (!/^nm\d+$/.test(nconst || '')) return []
  return cached(`n|${base}|${nconst}|${type}`, CACHE_TTL_MS, async () => {
    const data = await call(base, `/people/${nconst}`, { params: { type: typeParam(type) } })
    return (data?.items || []).map((r) => toItem(r, type)).filter(Boolean)
  })
}

/** A full name to the person LumiereDB thinks it means: { nconst, name } or null. */
async function findPerson(base, name, type = 'movie') {
  const found = await searchPeople(base, type, name).catch(() => null)
  return found?.person?.id ? { nconst: found.person.id, name: found.person.name } : null
}

// LumiereDB's own Popular and Trending lists leave out titles with fewer
// than 10,000 votes or rated under 5.5 - without that floor, sorting the
// whole of IMDb by popularity surfaces things nobody has heard of.
const LIST_FLOOR = { minVotes: 10000, minRating: 5.5 }

/**
 * Filtered titles, IMDb ids straight from IMDb's data. `filters` uses
 * LumiereDB's own names (snake_case query parameters):
 *   genres, exclude_genres, genre_match, year_from, year_to, min_votes,
 *   min_rating, max_rating, runtime_min, runtime_max, last_aired_from,
 *   last_aired_to, with_cast, cast_match, with_director, director_match, sort.
 * `exclude` (IMDb ids) is left out by LumiereDB itself before it counts, so
 * a catalog that skips what's been watched still comes back full.
 */
async function discoverTitles(base, type, filters, { limit = 40, exclude = [] } = {}) {
  const params = { type: typeParam(type) }
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    params[k] = v
  }
  if ((params.sort === 'popular' || params.sort === 'trending') && params.min_votes == null) {
    params.min_votes = LIST_FLOOR.minVotes
    if (params.min_rating == null) params.min_rating = LIST_FLOOR.minRating
  }
  const body = exclude.length ? { exclude_tconsts: exclude.filter((id) => /^tt\d+$/.test(id)).slice(0, 20000) } : undefined
  const items = []
  let cursor = ''
  for (let page = 0; page < 10 && items.length < limit; page++) {
    const data = await call(base, '/discover', { params: { ...params, limit: Math.min(50, limit - items.length), cursor }, body })
    for (const r of data?.items || []) {
      const item = toItem(r, type)
      if (item) items.push(item)
    }
    cursor = data?.meta?.nextCursor || ''
    if (!data?.meta?.hasMore || !cursor) break
  }
  return items.slice(0, limit)
}

/** LumiereDB's genres for movies and series, as { value, label }. */
async function genreOptions(base) {
  return cached(`g|${base}`, 24 * 60 * 60 * 1000, async () => {
    const data = await call(base, '/discover/options')
    const pick = (t) => (Array.isArray(t?.genres) ? t.genres : [])
      .map((g) => (typeof g?.value === 'string' && g.value ? { value: g.value, label: g.label || genreLabel(g.value) } : null))
      .filter(Boolean)
    return { movie: pick(data?.types?.movies), series: pick(data?.types?.series) }
  })
}

function genreLabel(slug) {
  return String(slug).split('-').map((p) => (p === 'tv' ? 'TV' : p.charAt(0).toUpperCase() + p.slice(1))).join('-')
}

/** Cinemeta/TMDb-style genre names ("Sci-Fi", "Science Fiction") to LumiereDB's slugs. */
function genreSlug(name) {
  const lower = String(name || '').trim().toLowerCase()
  const aliases = { 'science fiction': 'sci-fi', scifi: 'sci-fi', 'sci fi': 'sci-fi', 'tv movie': 'tv-movie', 'film noir': 'film-noir', noir: 'film-noir', 'reality tv': 'reality-tv', 'game show': 'game-show', 'talk show': 'talk-show' }
  return aliases[lower] || lower.replace(/\s+/g, '-')
}

module.exports = {
  ATTRIBUTION,
  normalizeAddress,
  lumiereAddress,
  lumiereStatus,
  readyLumiere,
  call,
  toItem,
  searchTitles,
  searchPeople,
  personTitles,
  findPerson,
  discoverTitles,
  listIds,
  genreOptions,
  genreSlug,
  _test: { requestParts, cache, statusCache },
}
