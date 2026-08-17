// SIMKL Watchlist <-> Catalogs bridge.
//
// Simkl's public API has no named Custom Lists endpoint yet - confirmed live
// against their own current docs (api.simkl.org/guides/custom-lists):
// "Custom Lists are not yet available via the API... no public endpoint to
// read, create, or modify Custom Lists, and no firm ETA." (served by an
// in-development "V2 Beta" backend that isn't publicly callable). So this
// isn't a URL-based import like TMDb/MDBList (server/utils/listImport.js) -
// there's no list URL to paste. The closest real equivalent Simkl's sync API
// DOES expose today is the `plantowatch` status on /sync/all-items and
// /sync/add-to-list, i.e. Simkl's own "Plan to Watch" list - other real
// sync tools in this space (e.g. plexytrack) use exactly this same
// scope-down for the identical gap. So: import pulls a specific linked
// User's Plan to Watch into a new Catalog; export adds a Catalog's items to
// that User's Plan to Watch. Picking which User is required since Catalogs
// are account-scoped but a SIMKL link is per-User (see schema comment on
// User.simklAccessToken) - an account can have more than one linked user.
const { authHeaders, resolveSimklClientIdForAccount, SIMKL_BASE } = require('./simklAuth')
const { decrypt } = require('./encryption')
const { resolveSinglePoster } = require('./libraryHelpers')
const { mapLimit } = require('./listImport')

// Same bound as listImport.js's MAX_IMPORT_ITEMS worth of add-to-list
// requests - keeps a single sweep well clear of any undocumented Simkl
// per-request item cap.
const MAX_EXPORT_BATCH = 500

function isImdb(id) {
  return typeof id === 'string' && /^tt\d+/.test(id)
}

async function simklFetch(path, clientId, accessToken, options = {}) {
  return fetch(`${SIMKL_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(clientId, accessToken), ...(options.headers || {}) },
  })
}

// linkedUser needs at least { id, accountId, username, simklAccessToken }.
async function importSimklWatchlist(prisma, linkedUser) {
  if (!linkedUser?.simklAccessToken) throw new Error('That user isn\'t linked to SIMKL')
  const accessToken = decrypt(linkedUser.simklAccessToken, { appAccountId: linkedUser.accountId })
  const clientId = await resolveSimklClientIdForAccount(prisma, linkedUser.accountId)

  const [moviesRes, showsRes] = await Promise.all([
    simklFetch('/sync/all-items/movies/plantowatch?extended=full', clientId, accessToken),
    simklFetch('/sync/all-items/shows/plantowatch?extended=full', clientId, accessToken),
  ])
  if (!moviesRes.ok || !showsRes.ok) throw new Error('Simkl request failed fetching Plan to Watch')
  const movies = await moviesRes.json().catch(() => [])
  const shows = await showsRes.json().catch(() => [])

  const raw = []
  for (const it of (Array.isArray(movies) ? movies : [])) {
    const imdb = it?.movie?.ids?.imdb
    if (!isImdb(imdb)) continue
    raw.push({ id: imdb, type: 'movie', name: it.movie.title || imdb, year: it.movie.year ? String(it.movie.year) : null })
  }
  for (const it of (Array.isArray(shows) ? shows : [])) {
    const imdb = it?.show?.ids?.imdb
    if (!isImdb(imdb)) continue
    raw.push({ id: imdb, type: 'series', name: it.show.title || imdb, year: it.show.year ? String(it.show.year) : null })
  }

  // Simkl's own item payload doesn't carry a ready-to-use poster URL (unlike
  // MDBList) - same Cinemeta-by-IMDb-id backfill listImport.js's MDBList
  // import already uses, bounded concurrency so a large Plan to Watch
  // doesn't fire hundreds of simultaneous requests at Cinemeta.
  const items = await mapLimit(raw, 8, async (it) => ({
    ...it,
    poster: await resolveSinglePoster(it.id, it.type, null).catch(() => null),
  }))

  return { name: `${linkedUser.username}'s SIMKL Plan to Watch`, items, truncated: false, totalAvailable: items.length }
}

// items: this app's CustomList item shape [{ id, type, name, poster?, year? }].
async function exportListToSimklWatchlist(prisma, linkedUser, items) {
  if (!linkedUser?.simklAccessToken) throw new Error('That user isn\'t linked to SIMKL')
  const eligible = (items || []).filter((i) => isImdb(i.id) && (i.type === 'movie' || i.type === 'series'))
  if (eligible.length === 0) throw new Error('This catalog has no exportable titles (missing IMDb ids)')

  const accessToken = decrypt(linkedUser.simklAccessToken, { appAccountId: linkedUser.accountId })
  const clientId = await resolveSimklClientIdForAccount(prisma, linkedUser.accountId)

  const sum = (obj) => (Number(obj?.movies) || 0) + (Number(obj?.shows) || 0)
  let added = 0
  let notFound = 0

  for (let i = 0; i < eligible.length; i += MAX_EXPORT_BATCH) {
    const batch = eligible.slice(i, i + MAX_EXPORT_BATCH)
    const body = {}
    const movies = batch.filter((it) => it.type === 'movie').map((it) => ({ title: it.name, ids: { imdb: it.id }, to: 'plantowatch' }))
    const shows = batch.filter((it) => it.type === 'series').map((it) => ({ title: it.name, ids: { imdb: it.id }, to: 'plantowatch' }))
    if (movies.length) body.movies = movies
    if (shows.length) body.shows = shows

    const res = await simklFetch('/sync/add-to-list', clientId, accessToken, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Simkl request failed (${res.status})`)
    const result = await res.json().catch(() => ({}))
    added += sum(result?.added)
    notFound += sum(result?.not_found)
  }

  return { added, notFound, existing: eligible.length - added - notFound }
}

// Discover row: SIMKL's public Trending/Most Anticipated feeds. Unlike
// import/export above, these are catalog-browsing endpoints, not tied to
// any one linked User - only a Client ID is needed, no per-user access
// token (confirmed against SIMKL's own docs: /movies|tv/{trending|
// anticipated}/{period} don't require Authorization, just simkl-api-key).
// So this works for any account with a SIMKL Client ID configured
// (Settings -> External API Keys), even with zero linked users.
const SIMKL_DISCOVER_LISTS = new Set(['trending', 'anticipated'])
const SIMKL_DISCOVER_TYPES = { movies: 'movies', shows: 'tv' } // SlickSync's own naming vs SIMKL's URL segment

async function fetchSimklDiscoverRow(prisma, accountId, { list, mediaType, period = 'weekly' } = {}) {
  if (!SIMKL_DISCOVER_LISTS.has(list)) throw new Error(`Unknown SIMKL list "${list}"`)
  const urlType = SIMKL_DISCOVER_TYPES[mediaType]
  if (!urlType) throw new Error(`Unknown media type "${mediaType}"`)

  const clientId = await resolveSimklClientIdForAccount(prisma, accountId)
  const res = await fetch(`${SIMKL_BASE}/${urlType}/${list}/${period}?extended=full`, {
    headers: { 'simkl-api-key': clientId },
  })
  if (!res.ok) throw new Error(`SIMKL request failed (${res.status})`)
  const data = await res.json().catch(() => [])

  const raw = []
  for (const it of (Array.isArray(data) ? data : [])) {
    const entry = it?.movie || it?.show
    const imdb = entry?.ids?.imdb
    if (!isImdb(imdb)) continue
    raw.push({
      id: imdb,
      type: mediaType === 'movies' ? 'movie' : 'series',
      name: entry.title || imdb,
      year: entry.year ? String(entry.year) : null,
    })
  }

  // Same Cinemeta-by-IMDb-id poster backfill as importSimklWatchlist -
  // SIMKL's own payload has a poster path, but it's on SIMKL's own CDN and
  // this app standardizes on Cinemeta-resolved posters everywhere else
  // (consistent art style/size across every row, not a visually different
  // source for just this one).
  return mapLimit(raw, 8, async (it) => ({
    ...it,
    poster: await resolveSinglePoster(it.id, it.type, null).catch(() => null),
  }))
}

module.exports = { importSimklWatchlist, exportListToSimklWatchlist, fetchSimklDiscoverRow }
