/**
 * Trakt integration — scrobbles SlickSync's own watch record to Trakt.
 *
 * WHY THIS WORKS FOR BOTH PROVIDERS: Trakt never talks to Nuvio or Stremio.
 * SlickSync is the bridge — it already keeps a unified watch record (the
 * native pipeline writes EpisodeWatchHistory / MovieWatchHistory for EVERY
 * source, Nuvio and Stremio alike, usenet included). This module just mirrors
 * that record to Trakt, so a watch shows up on Trakt no matter which provider
 * played it.
 *
 * DUP-SAFE BY WATERMARK: instead of firing inside the per-poll history upsert
 * (which re-runs constantly and would re-scrobble), a background poller pushes
 * only rows whose immutable `createdAt` is newer than a stored watermark
 * (`sync.trakt.lastSyncAt`), then advances the watermark. Trakt's /sync/history
 * is add-only, so the watermark — not Trakt-side dedup — is what prevents
 * duplicate plays.
 *
 * AUTH: Trakt device-code flow (no redirect URI to register). The account
 * pastes a client_id/client_secret from a one-time Trakt app registration
 * (trakt.tv/oauth/applications), clicks Connect, enters the shown code at
 * trakt.tv/activate. Tokens live in AppAccount.sync.trakt and auto-refresh.
 */

const TRAKT_BASE = 'https://api.trakt.tv'
const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh a bit before actual expiry
const POLL_INTERVAL_MS = 10 * 60 * 1000 // scrobble sweep every 10m
const FIRST_RUN_DELAY_MS = 4 * 60 * 1000
const MAX_ROWS_PER_SWEEP = 500 // cap a single sweep; watermark carries the rest forward

// ---- config read/write on AppAccount.sync ---------------------------------

async function readSync(prisma, accountId) {
  const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = account?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return (cfg && typeof cfg === 'object') ? cfg : {}
}

async function getTraktConfig(prisma, accountId) {
  const cfg = await readSync(prisma, accountId)
  return (cfg.trakt && typeof cfg.trakt === 'object') ? cfg.trakt : {}
}

/** Shallow-merge a patch into sync.trakt. Keys set to `undefined` are deleted. */
async function patchTraktConfig(prisma, accountId, patch) {
  const cfg = await readSync(prisma, accountId)
  const trakt = { ...(cfg.trakt && typeof cfg.trakt === 'object' ? cfg.trakt : {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete trakt[k]
    else trakt[k] = v
  }
  const next = { ...cfg, trakt }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(next) } })
  return trakt
}

/** Public-safe view (no secrets/tokens) for the settings UI. */
function publicStatus(trakt) {
  const connected = !!(trakt.accessToken && trakt.refreshToken)
  const pending = trakt.pendingDevice && trakt.pendingDevice.expiresAt > Date.now() ? {
    userCode: trakt.pendingDevice.userCode,
    verificationUrl: trakt.pendingDevice.verificationUrl,
    expiresAt: trakt.pendingDevice.expiresAt,
  } : null
  return {
    configured: !!(trakt.clientId && trakt.clientSecret),
    connected,
    username: connected ? (trakt.username || null) : null,
    lastSyncAt: trakt.lastSyncAt || null,
    pending,
  }
}

// ---- HTTP helpers ---------------------------------------------------------

function authHeaders(clientId, accessToken) {
  const h = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  }
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`
  return h
}

async function traktPost(path, clientId, body, accessToken) {
  const res = await fetch(`${TRAKT_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(clientId, accessToken),
    body: JSON.stringify(body),
  })
  return res
}

// ---- device-code auth -----------------------------------------------------

/** Start device auth; returns { userCode, verificationUrl, ... } and stores the pending state. */
async function startDeviceAuth(prisma, accountId) {
  const trakt = await getTraktConfig(prisma, accountId)
  if (!trakt.clientId || !trakt.clientSecret) {
    throw new Error('Add your Trakt Client ID and Secret first')
  }
  const res = await traktPost('/oauth/device/code', trakt.clientId, { client_id: trakt.clientId })
  if (!res.ok) throw new Error(`Trakt refused the device request (${res.status}) — check your Client ID`)
  const data = await res.json()
  const pendingDevice = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    interval: Math.max(1, data.interval || 5),
    expiresAt: Date.now() + (data.expires_in || 600) * 1000,
  }
  await patchTraktConfig(prisma, accountId, { pendingDevice })
  return { userCode: pendingDevice.userCode, verificationUrl: pendingDevice.verificationUrl, expiresAt: pendingDevice.expiresAt }
}

/**
 * Poll once for the device token. Returns:
 *  { status: 'authorized' } on success (tokens stored, watermark seeded)
 *  { status: 'pending' }    still waiting for the user to enter the code
 *  { status: 'expired' | 'denied' | 'none' }  terminal / nothing to poll
 */
async function pollDeviceToken(prisma, accountId) {
  const trakt = await getTraktConfig(prisma, accountId)
  const pd = trakt.pendingDevice
  if (!pd || !pd.deviceCode) return { status: 'none' }
  if (pd.expiresAt <= Date.now()) {
    await patchTraktConfig(prisma, accountId, { pendingDevice: undefined })
    return { status: 'expired' }
  }
  const res = await traktPost('/oauth/device/token', trakt.clientId, {
    code: pd.deviceCode,
    client_id: trakt.clientId,
    client_secret: trakt.clientSecret,
  })
  if (res.status === 200) {
    const tok = await res.json()
    const expiresAt = ((tok.created_at || Math.floor(Date.now() / 1000)) + tok.expires_in) * 1000
    // Seed the watermark to "now" so connecting doesn't bulk-dump the whole
    // back-catalogue onto Trakt — only watches from here forward scrobble.
    await patchTraktConfig(prisma, accountId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt,
      lastSyncAt: trakt.lastSyncAt || new Date().toISOString(),
      pendingDevice: undefined,
    })
    await refreshUsername(prisma, accountId).catch(() => {})
    return { status: 'authorized' }
  }
  if (res.status === 400) return { status: 'pending' } // user hasn't entered the code yet
  if (res.status === 410 || res.status === 404) {
    await patchTraktConfig(prisma, accountId, { pendingDevice: undefined })
    return { status: 'expired' }
  }
  if (res.status === 418) {
    await patchTraktConfig(prisma, accountId, { pendingDevice: undefined })
    return { status: 'denied' }
  }
  if (res.status === 409) return { status: 'authorized' } // already used — treat as done
  return { status: 'pending' }
}

async function refreshUsername(prisma, accountId) {
  const token = await ensureValidToken(prisma, accountId)
  if (!token) return
  const trakt = await getTraktConfig(prisma, accountId)
  const res = await fetch(`${TRAKT_BASE}/users/me`, { headers: authHeaders(trakt.clientId, token) })
  if (res.ok) {
    const me = await res.json()
    if (me?.username) await patchTraktConfig(prisma, accountId, { username: me.username })
  }
}

/** Returns a currently-valid access token, refreshing if near expiry. Null if not connected. */
async function ensureValidToken(prisma, accountId) {
  const trakt = await getTraktConfig(prisma, accountId)
  if (!trakt.accessToken || !trakt.refreshToken) return null
  if (trakt.expiresAt && Date.now() < trakt.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return trakt.accessToken
  }
  // Expired (or about to) — refresh.
  const res = await traktPost('/oauth/token', trakt.clientId, {
    refresh_token: trakt.refreshToken,
    client_id: trakt.clientId,
    client_secret: trakt.clientSecret,
    redirect_uri: OOB_REDIRECT,
    grant_type: 'refresh_token',
  })
  if (!res.ok) {
    // Refresh token dead — force a reconnect rather than silently retrying.
    await patchTraktConfig(prisma, accountId, { accessToken: undefined, refreshToken: undefined, expiresAt: undefined })
    return null
  }
  const tok = await res.json()
  const expiresAt = ((tok.created_at || Math.floor(Date.now() / 1000)) + tok.expires_in) * 1000
  await patchTraktConfig(prisma, accountId, { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt })
  return tok.access_token
}

async function disconnect(prisma, accountId) {
  await patchTraktConfig(prisma, accountId, {
    accessToken: undefined, refreshToken: undefined, expiresAt: undefined,
    username: undefined, pendingDevice: undefined, lastSyncAt: undefined,
  })
}

// ---- scrobble sweep -------------------------------------------------------

/** Only IMDb ids map cleanly to Trakt; kitsu/anime ids are skipped. */
function isImdb(id) {
  return typeof id === 'string' && /^tt\d+/.test(id)
}

/**
 * Push watch-history rows newer than the watermark to Trakt /sync/history.
 * Returns { synced, movies, episodes } counts. No-op (returns null) if the
 * account isn't connected.
 */
async function scrobbleNewWatches(prisma, accountId) {
  const token = await ensureValidToken(prisma, accountId)
  if (!token) return null
  const trakt = await getTraktConfig(prisma, accountId)
  const since = trakt.lastSyncAt ? new Date(trakt.lastSyncAt) : new Date(0)

  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.findMany({
      where: { accountId, createdAt: { gt: since } },
      select: { showId: true, season: true, episode: true, watchedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS_PER_SWEEP,
    }),
    prisma.movieWatchHistory.findMany({
      where: { accountId, createdAt: { gt: since } },
      select: { itemId: true, watchedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS_PER_SWEEP,
    }),
  ])

  if (episodes.length === 0 && movies.length === 0) return { synced: 0, movies: 0, episodes: 0 }

  // Establish a safe "frontier": the newest createdAt up to which we've seen
  // EVERY row on both tables. If a table hit the page cap we've only drained it
  // up to its last fetched row, so the frontier can't advance past that point —
  // otherwise the next sweep (createdAt > watermark) would skip the un-fetched
  // tail (data loss) or re-send rows (duplicate Trakt plays). We then only
  // scrobble rows at/below the frontier and set the watermark to it.
  const maxOf = (rows) => rows.length ? Math.max(...rows.map((r) => new Date(r.createdAt).getTime())) : -Infinity
  let frontier = Math.max(maxOf(episodes), maxOf(movies))
  if (episodes.length === MAX_ROWS_PER_SWEEP) frontier = Math.min(frontier, maxOf(episodes))
  if (movies.length === MAX_ROWS_PER_SWEEP) frontier = Math.min(frontier, maxOf(movies))
  const withinFrontier = (r) => new Date(r.createdAt).getTime() <= frontier

  // Group episodes by show so the payload is one entry per show with nested seasons.
  const showMap = new Map() // showId -> Map<season, Array<{ number, watched_at }>>
  let episodeCount = 0
  for (const e of episodes) {
    if (!withinFrontier(e)) continue
    if (!isImdb(e.showId) || e.season == null || e.episode == null) continue
    if (!showMap.has(e.showId)) showMap.set(e.showId, new Map())
    const seasons = showMap.get(e.showId)
    if (!seasons.has(e.season)) seasons.set(e.season, [])
    seasons.get(e.season).push({ number: e.episode, watched_at: new Date(e.watchedAt).toISOString() })
    episodeCount++
  }

  const showsPayload = [...showMap.entries()].map(([showId, seasons]) => ({
    ids: { imdb: showId },
    seasons: [...seasons.entries()].map(([number, eps]) => ({ number, episodes: eps })),
  }))

  const moviesPayload = []
  for (const m of movies) {
    if (!withinFrontier(m)) continue
    if (!isImdb(m.itemId)) continue
    moviesPayload.push({ ids: { imdb: m.itemId }, watched_at: new Date(m.watchedAt).toISOString() })
  }

  // Advance the watermark to the frontier (the immutable createdAt up to which
  // both tables are fully drained), even across skipped kitsu rows.
  const newWatermark = new Date(frontier)

  if (showsPayload.length === 0 && moviesPayload.length === 0) {
    // Nothing Trakt-mappable this batch — still advance the watermark.
    await patchTraktConfig(prisma, accountId, { lastSyncAt: newWatermark.toISOString() })
    return { synced: 0, movies: 0, episodes: 0 }
  }

  const body = {}
  if (moviesPayload.length) body.movies = moviesPayload
  if (showsPayload.length) body.shows = showsPayload

  const res = await traktPost('/sync/history', trakt.clientId, body, token)
  if (!res.ok) {
    // Leave the watermark untouched so the next sweep retries this batch.
    throw new Error(`Trakt /sync/history failed (${res.status})`)
  }
  await patchTraktConfig(prisma, accountId, { lastSyncAt: newWatermark.toISOString() })
  return { synced: moviesPayload.length + episodeCount, movies: moviesPayload.length, episodes: episodeCount }
}

// ---- watchlist ------------------------------------------------------------

// Trakt gives no poster URLs (it uses TMDB images), so watchlist items are
// enriched with posters from Cinemeta — the same source the rest of SlickSync
// uses. Cache the assembled, enriched list briefly so opening Discover
// repeatedly doesn't re-hit Trakt + Cinemeta each time.
const WATCHLIST_CACHE_MS = 10 * 60 * 1000
const watchlistCache = new Map() // accountId -> { at, items }
const MAX_WATCHLIST_ITEMS = 80

/**
 * The connected account's Trakt watchlist, shaped like a DiscoverItem so the
 * Discover grid/modal can render it directly. Movies and series combined,
 * newest-added first. Returns null if Trakt isn't connected.
 */
async function getTraktWatchlist(prisma, accountId) {
  const token = await ensureValidToken(prisma, accountId)
  if (!token) return null

  const cached = watchlistCache.get(accountId)
  if (cached && Date.now() - cached.at < WATCHLIST_CACHE_MS) return cached.items

  const trakt = await getTraktConfig(prisma, accountId)
  const res = await fetch(`${TRAKT_BASE}/sync/watchlist?extended=full`, { headers: authHeaders(trakt.clientId, token) })
  if (!res.ok) throw new Error(`Trakt watchlist fetch failed (${res.status})`)
  const raw = await res.json()

  // Newest-added first (Trakt returns rank order by default).
  const entries = (Array.isArray(raw) ? raw : [])
    .filter((e) => e && (e.type === 'movie' || e.type === 'show'))
    .sort((a, b) => new Date(b.listed_at || 0) - new Date(a.listed_at || 0))
    .map((e) => {
      const node = e.type === 'movie' ? e.movie : e.show
      const imdb = node?.ids?.imdb
      if (!imdb || !isImdb(imdb)) return null
      return {
        id: imdb,
        type: e.type === 'movie' ? 'movie' : 'series',
        name: node.title || 'Unknown',
        releaseInfo: node.year ? String(node.year) : null,
      }
    })
    .filter(Boolean)
    .slice(0, MAX_WATCHLIST_ITEMS)

  // Enrich each with a Cinemeta poster (fetchMetadata is itself cached).
  const { fetchMetadata } = require('./notify')
  const enriched = await Promise.all(entries.map(async (item) => {
    try {
      const meta = await fetchMetadata(item.id, item.type === 'series' ? 'series' : 'movie')
      return { ...item, poster: meta?.poster || null, imdbRating: null, genres: [] }
    } catch {
      return { ...item, poster: null, imdbRating: null, genres: [] }
    }
  }))

  watchlistCache.set(accountId, { at: Date.now(), items: enriched })
  return enriched
}

// ---- scheduler ------------------------------------------------------------

async function sweepAllAccounts(prisma) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true } })
  for (const { id } of accounts) {
    try {
      const trakt = await getTraktConfig(prisma, id)
      if (!trakt.accessToken) continue
      const r = await scrobbleNewWatches(prisma, id)
      if (r && r.synced > 0) {
        console.log(`[Trakt] Scrobbled ${r.synced} item${r.synced !== 1 ? 's' : ''} (${r.movies} movie, ${r.episodes} episode) for account ${id}`)
      }
    } catch (e) {
      console.warn(`[Trakt] Sweep failed for account ${id}:`, e?.message)
    }
  }
}

function scheduleTraktSync(prisma) {
  const run = () => sweepAllAccounts(prisma).catch((e) => console.warn('[Trakt] Sweep error:', e?.message))
  setTimeout(run, FIRST_RUN_DELAY_MS)
  setInterval(run, POLL_INTERVAL_MS)
}

module.exports = {
  getTraktConfig,
  patchTraktConfig,
  publicStatus,
  startDeviceAuth,
  pollDeviceToken,
  ensureValidToken,
  disconnect,
  scrobbleNewWatches,
  getTraktWatchlist,
  scheduleTraktSync,
}
