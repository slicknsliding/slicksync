// Posters from a Jellyfin-compatible server's own images.
//
// Posters were metahub-only, which only knows IMDb ids - so anime and
// TMDb/TVDB-only titles on a Jellyfin, AIOStreams or AIOMetadata server had
// none. Those now use the server's own Primary image:
//
//   {server}/Items/{id}/Images/Primary?tag={tag}&maxWidth=600
//
// The tag is in the address, so new art on the server is a new address and a
// new entry in the poster cache (utils/imageCacheCore.js keys by address).
// An episode uses its show's poster (SeriesId + SeriesPrimaryImageTag).
//
// The image proxy (/api/img) refuses private addresses, and a home server
// usually is one. On an instance that may reach private addresses at all
// (not a public one - see jellyfinAuth.restrictsPrivateAddresses), it lets
// through exactly these image addresses on a server someone here signed in
// to, fetched without following redirects. Nothing else on that server.
//
// A server behind a sign-in proxy answers images with 401/403: the provider
// checks once per server (imagesOpen) and keeps the old behaviour there -
// metahub for IMDb ids, nothing otherwise.

const IMAGE_PATH = /^\/Items\/[0-9a-f]{32}\/Images\/Primary$/i
const POSTER_WIDTH = 600

function normId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase()
}

/** The server's own poster address for a /Items, /Sessions or /Resume item, or null. */
function serverPosterUrl(base, item) {
  if (!base || !item || typeof item !== 'object') return null
  let id = null
  let tag = null
  if (item.Type === 'Episode') {
    id = item.SeriesId
    tag = item.SeriesPrimaryImageTag
  } else {
    id = item.Id
    tag = item.ImageTags?.Primary
  }
  id = normId(id)
  if (!/^[0-9a-f]{32}$/.test(id) || !tag) return null
  const qs = new URLSearchParams({ tag: String(tag), maxWidth: String(POSTER_WIDTH) })
  return `${String(base).replace(/\/+$/, '')}/Items/${id}/Images/Primary?${qs}`
}

/** Shaped like a server poster address, on any server. */
function looksLikeServerPoster(src) {
  try {
    return /\/Items\/[0-9a-f]{32}\/Images\/Primary$/i.test(new URL(src).pathname)
  } catch {
    return false
  }
}

/**
 * Whether `src` is a poster address on one of `serverUrls` - a server's own
 * base (which may carry a path, like AIOStreams' /jellyfin/u/<alias>), then
 * exactly /Items/<id>/Images/Primary, with only tag and maxWidth.
 */
function isServerPosterUrl(src, serverUrls) {
  let url
  try { url = new URL(src) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password || url.hash) return false
  for (const key of url.searchParams.keys()) if (key !== 'tag' && key !== 'maxWidth') return false
  for (const raw of serverUrls || []) {
    let base
    try { base = new URL(raw) } catch { continue }
    if (base.origin !== url.origin) continue
    const prefix = base.pathname.replace(/\/+$/, '')
    if (!url.pathname.startsWith(`${prefix}/`)) continue
    if (IMAGE_PATH.test(url.pathname.slice(prefix.length))) return true
  }
  return false
}

// The server addresses people here signed in to, read at most every 5 minutes.
let known = { at: 0, urls: [] }
const KNOWN_TTL_MS = 5 * 60 * 1000

async function knownServerUrls(prisma) {
  if (Date.now() - known.at < KNOWN_TTL_MS) return known.urls
  const urls = new Set()
  try {
    const rows = await prisma.user.findMany({ where: { jellyfinServerUrl: { not: null } }, select: { jellyfinServerUrl: true } })
    for (const r of rows) if (r.jellyfinServerUrl) urls.add(r.jellyfinServerUrl)
    const merged = await prisma.userProviderCredential.findMany({ where: { jellyfinServerUrl: { not: null } }, select: { jellyfinServerUrl: true } }).catch(() => [])
    for (const r of merged) if (r.jellyfinServerUrl) urls.add(r.jellyfinServerUrl)
  } catch (e) {
    console.warn('[JellyfinImages] could not read server addresses:', e?.message)
    return known.urls
  }
  known = { at: Date.now(), urls: [...urls] }
  return known.urls
}

/** Whether the image proxy may fetch this private-address poster. */
async function allowPrivatePoster(prisma, src) {
  if (!prisma) return false
  const { restrictsPrivateAddresses } = require('../providers/jellyfinAuth')
  if (restrictsPrivateAddresses()) return false
  return isServerPosterUrl(src, await knownServerUrls(prisma))
}

// Per server: does it hand out images without a sign-in? Checked once with
// the first poster address that comes up, remembered for 6 hours.
const openByServer = new Map()
const OPEN_TTL_MS = 6 * 60 * 60 * 1000

/**
 * true / false once known; `fetchImpl` is for tests. A server that can't be
 * reached right now isn't remembered either way - it is asked again later.
 */
async function imagesOpen(serverKey, posterUrl, { fetchImpl = fetch } = {}) {
  const cached = openByServer.get(serverKey)
  if (cached && Date.now() - cached.at < OPEN_TTL_MS) return cached.open
  if (!posterUrl) return true
  try {
    const res = await fetchImpl(posterUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    try { await res.body?.cancel?.() } catch {}
    const open = res.status !== 401 && res.status !== 403
    openByServer.set(serverKey, { open, at: Date.now() })
    return open
  } catch {
    return true
  }
}

/**
 * Titles watched before server posters existed were recorded with none. After
 * a library read, fill the person's blank History, viewing and session
 * posters from it - only blank ones, only titles the library now has a poster
 * for. Two cheap reads when there is nothing to do.
 */
async function fillMissingPosters(prisma, accountId, userId, library) {
  if (!userId || !Array.isArray(library) || library.length === 0) return 0
  const posters = new Map()
  for (const item of library) if (item?._id && item.poster) posters.set(item._id, item.poster)
  if (posters.size === 0) return 0
  let filled = 0
  const where = { accountId, userId, poster: null }
  const [movies, episodes, sessions] = await Promise.all([
    prisma.movieWatchHistory.findMany({ where, select: { itemId: true }, distinct: ['itemId'] }).catch(() => []),
    prisma.episodeWatchHistory.findMany({ where, select: { showId: true }, distinct: ['showId'] }).catch(() => []),
    prisma.watchSession.findMany({ where, select: { itemId: true }, distinct: ['itemId'] }).catch(() => []),
  ])
  for (const { itemId } of movies) {
    if (!posters.has(itemId)) continue
    filled += (await prisma.movieWatchHistory.updateMany({ where: { ...where, itemId }, data: { poster: posters.get(itemId) } })).count
  }
  for (const { showId } of episodes) {
    if (!posters.has(showId)) continue
    filled += (await prisma.episodeWatchHistory.updateMany({ where: { ...where, showId }, data: { poster: posters.get(showId) } })).count
  }
  for (const { itemId } of sessions) {
    if (!posters.has(itemId)) continue
    filled += (await prisma.watchSession.updateMany({ where: { ...where, itemId }, data: { poster: posters.get(itemId) } })).count
  }
  return filled
}

function forgetForTests() {
  openByServer.clear()
  known = { at: 0, urls: [] }
}

module.exports = { serverPosterUrl, isServerPosterUrl, looksLikeServerPoster, fillMissingPosters, knownServerUrls, allowPrivatePoster, imagesOpen, forgetForTests, POSTER_WIDTH }
