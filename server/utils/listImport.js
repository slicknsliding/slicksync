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

module.exports = { detectProvider, importFromTmdb, importFromMdblist, resolveTmdbKey, resolveMdblistKey, MAX_IMPORT_ITEMS }
