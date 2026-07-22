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

  const primary = await fetchCatalogRaw(type, catalog, extraParts)

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
    return await fetchCatalogRaw(type, 'top', extraParts)
  }
  return primary
}

module.exports = { fetchCatalog }
