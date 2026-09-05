/**
 * Discover - browse/search Cinemeta's real catalogs (Popular/New/Featured
 * for movies and series). This is a DIFFERENT Cinemeta host than the one
 * notify.js's fetchMetadata uses for per-item lookups
 * (cinemeta-live.strem.io) - that one's manifest declares no catalogs at
 * all (catalogs: []), meta-lookup only. v3-cinemeta.strem.io is the
 * addon that actually exposes catalog/search (confirmed via its own
 * manifest.json), following the standard Stremio addon protocol:
 * {base}/catalog/{type}/{catalogId}/{extra}.json
 *
 * Only the "top" (Popular) catalog supports search, per that manifest -
 * "year" (New) and "imdbRating" (Featured) only support genre/skip.
 */

const CINEMETA_CATALOG_BASE = 'https://v3-cinemeta.strem.io'
const FETCH_TIMEOUT_MS = 5000

// Every Discover visit went to Cinemeta live, so opening the page always
// cost a round trip to someone else's server before a single poster
// appeared - for lists that are the same for everyone and change on the
// order of hours, not seconds. Ten minutes is well inside how fast
// "Popular" actually moves, and a warm entry turns the first paint into a
// local read.
//
// Search is deliberately NOT cached: those keys are unbounded (one per
// query anyone ever types) and a search is typed once and read once.
const CATALOG_TTL_MS = 10 * 60 * 1000
const catalogCache = new Map()
const MAX_CATALOG_ENTRIES = 120

function cacheKey(type, catalog, extraParts) {
  return `${type}|${catalog}|${extraParts.join('&')}`
}

function readCache(key) {
  const hit = catalogCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CATALOG_TTL_MS) { catalogCache.delete(key); return null }
  return hit.items
}

function writeCache(key, items) {
  // Never cache an empty result: an upstream blip would otherwise pin an
  // empty grid in front of everyone for the whole TTL.
  if (!Array.isArray(items) || items.length === 0) return
  catalogCache.set(key, { at: Date.now(), items })
  if (catalogCache.size > MAX_CATALOG_ENTRIES) {
    for (const k of catalogCache.keys()) {
      catalogCache.delete(k)
      if (catalogCache.size <= MAX_CATALOG_ENTRIES) break
    }
  }
}

async function fetchCatalogRaw(type, catalog, extraParts) {
  const extra = extraParts.length ? `/${extraParts.join('&')}` : ''
  const url = `${CINEMETA_CATALOG_BASE}/catalog/${type}/${catalog}${extra}.json`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SlickSync/1.0' },
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    if (!response.ok) return []
    const data = await response.json()
    const metas = Array.isArray(data?.metas) ? data.metas : []
    return metas.map((m) => ({
      id: m.id,
      type: m.type,
      name: m.name || 'Unknown',
      poster: m.poster || null,
      releaseInfo: m.releaseInfo || (m.year ? String(m.year) : null),
      imdbRating: m.imdbRating || null,
      genres: Array.isArray(m.genres) ? m.genres : []
    })).filter((m) => m.id && m.id.startsWith('tt')) // only IMDb-backed items work with our modal/app links
  } catch (error) {
    clearTimeout(timeoutId)
    return []
  }
}

async function fetchCatalog(type, { catalog = 'top', genre, skip, search } = {}) {
  const extraParts = []
  if (search) extraParts.push(`search=${encodeURIComponent(search)}`)
  if (genre) extraParts.push(`genre=${encodeURIComponent(genre)}`)
  if (skip) extraParts.push(`skip=${encodeURIComponent(skip)}`)

  // Search results are read straight from the source; everything else is a
  // shared, slow-moving list worth keeping for a few minutes.
  const key = search ? null : cacheKey(type, catalog, extraParts)
  if (key) {
    const hit = readCache(key)
    if (hit) return hit
  }

  const primary = await fetchCatalogRaw(type, catalog, extraParts)
  if (key && primary.length > 0) writeCache(key, primary)

  // Cinemeta's manifest lists genre extras for every catalog but a couple
  // of specific combos always return empty. Confirmed by probing:
  //   - `year` catalog's "genre" extra is actually a YEAR list (1920-2026),
  //     not a real genre list — so `year + Horror` etc. always returns [].
  //   - `imdbRating + Documentary` returns [] even though the manifest
  //     lists Documentary as a valid genre option there.
  // For those cases, transparently fall back to `top` (Popular) with the
  // same genre so the user sees SOMETHING instead of an empty grid. Only
  // triggered when: page-1 primary was empty AND we have a genre AND we
  // aren't already on top. `skip` is preserved so pagination through the
  // fallback keeps working.
  if (primary.length === 0 && genre && catalog !== 'top') {
    const fallbackKey = cacheKey(type, 'top', extraParts)
    const warm = readCache(fallbackKey)
    if (warm) return warm
    const fallback = await fetchCatalogRaw(type, 'top', extraParts)
    writeCache(fallbackKey, fallback)
    return fallback
  }
  return primary
}

/**
 * Fills the cache for the views Discover opens on, before anyone opens it.
 *
 * The page starts on Popular with no genre filter, and the other two tabs
 * are one click away - six small requests in total for both media types.
 * Running them on a timer means the common case is served from memory
 * rather than from a round trip to Cinemeta, and it costs the same handful
 * of requests whether the household opens Discover once or fifty times.
 *
 * Errors are swallowed on purpose: this is an optimisation, and a failed
 * warm just means the next real visit fetches normally.
 */
async function warmDiscoverCatalogs() {
  const combos = []
  for (const type of ['movie', 'series']) {
    for (const catalog of ['top', 'year', 'imdbRating']) combos.push([type, catalog])
  }
  let warmed = 0
  for (const [type, catalog] of combos) {
    try {
      const items = await fetchCatalogRaw(type, catalog, [])
      if (items.length > 0) { writeCache(cacheKey(type, catalog, []), items); warmed++ }
    } catch { /* optimisation only */ }
  }
  return warmed
}

// Refreshed on the same cadence the entries expire, so a warmed view never
// goes cold between passes. The first pass waits a moment so it cannot
// compete with startup work.
function scheduleDiscoverWarm() {
  const run = () => { warmDiscoverCatalogs().catch(() => {}) }
  setTimeout(run, 20 * 1000).unref?.()
  const timer = setInterval(run, CATALOG_TTL_MS)
  timer.unref?.()
  return timer
}

module.exports = { fetchCatalog, warmDiscoverCatalogs, scheduleDiscoverWarm }
