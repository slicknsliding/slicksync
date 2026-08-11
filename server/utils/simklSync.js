// SIMKL watch-history sync - per-user, bidirectional. Adapted from the
// removed Trakt integration's scrobble sweep (git show cd25ca3, later
// removed in 6319b8d for a Trakt-side policy reason that doesn't apply to
// SIMKL - see the schema comment on User.simklAccessToken). The "safe
// frontier" watermark algorithm below is carried over unchanged from that
// code; it isn't reinvented here, just re-targeted per-user instead of
// per-account and pointed at SIMKL's API instead of Trakt's.
//
// PULL side (Simkl -> SlickSync): closes the blind spot when a Nuvio
// account has delegated its own native tracking to Simkl (Nuvio Settings >
// Tracking) - SlickSync's normal getLibrary() call only reads Nuvio's own
// Supabase tables and sees nothing for that account otherwise.
//
// PUSH side (SlickSync -> Simkl): mirrors SlickSync's already-unified watch
// record (native pipeline writes EpisodeWatchHistory/MovieWatchHistory for
// every source - Nuvio, Stremio, usenet included) out to Simkl, so a watch
// shows up there regardless of which provider played it. Same value the
// removed Trakt integration had.
//
// UNVERIFIED: Simkl's public docs don't show a confirmed example of
// watched_at on a /sync/history POST payload (only a GET query param called
// episode_watched_at was documented) - this sends it anyway on the Trakt-
// compatible assumption most sync tools in this space make, but it needs
// checking against a real account before trusting timestamps land correctly
// rather than just "watched now".

const { authHeaders, resolveSimklClientIdForAccount, SIMKL_BASE } = require('./simklAuth')

const MAX_ROWS_PER_SWEEP = 500
const ACTIVITY_CHECK_TIMEOUT_MS = 10_000

function isImdb(id) {
  return typeof id === 'string' && /^tt\d+/.test(id)
}

async function simklFetch(path, clientId, accessToken, options = {}) {
  const res = await fetch(`${SIMKL_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(clientId, accessToken), ...(options.headers || {}) },
  })
  return res
}

// ---- push: SlickSync -> Simkl ---------------------------------------------

/**
 * Push watch-history rows newer than the user's watermark to Simkl
 * /sync/history. Returns { synced, movies, episodes } or null if the user
 * isn't connected. Mirrors the removed Trakt scrobbleNewWatches() exactly,
 * see the module comment above.
 */
async function pushNewWatches(prisma, user) {
  if (!user.simklAccessToken) return null
  const { decrypt } = require('./encryption')
  const accessToken = decrypt(user.simklAccessToken, { appAccountId: user.accountId })
  const clientId = await resolveSimklClientIdForAccount(prisma, user.accountId)
  const since = user.simklLastPushAt ? new Date(user.simklLastPushAt) : new Date(0)

  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.findMany({
      where: { accountId: user.accountId, userId: user.id, createdAt: { gt: since } },
      select: { showId: true, showName: true, season: true, episode: true, watchedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS_PER_SWEEP,
    }),
    prisma.movieWatchHistory.findMany({
      where: { accountId: user.accountId, userId: user.id, createdAt: { gt: since } },
      select: { itemId: true, itemName: true, watchedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS_PER_SWEEP,
    }),
  ])

  if (episodes.length === 0 && movies.length === 0) return { synced: 0, movies: 0, episodes: 0 }

  // Safe frontier: the newest createdAt up to which BOTH tables are fully
  // drained this sweep. If a table hit the page cap, the frontier can't
  // advance past its last fetched row - otherwise the next sweep would skip
  // the un-fetched tail (data loss) or resend rows already sent (duplicate
  // plays on Simkl).
  const maxOf = (rows) => (rows.length ? Math.max(...rows.map((r) => new Date(r.createdAt).getTime())) : -Infinity)
  let frontier = Math.max(maxOf(episodes), maxOf(movies))
  if (episodes.length === MAX_ROWS_PER_SWEEP) frontier = Math.min(frontier, maxOf(episodes))
  if (movies.length === MAX_ROWS_PER_SWEEP) frontier = Math.min(frontier, maxOf(movies))
  const withinFrontier = (r) => new Date(r.createdAt).getTime() <= frontier

  const showMap = new Map() // showId -> { title, seasons: Map<season, episodes[]> }
  let episodeCount = 0
  for (const e of episodes) {
    if (!withinFrontier(e)) continue
    if (!isImdb(e.showId) || e.season == null || e.episode == null) continue
    if (!showMap.has(e.showId)) showMap.set(e.showId, { title: e.showName, seasons: new Map() })
    const entry = showMap.get(e.showId)
    if (!entry.seasons.has(e.season)) entry.seasons.set(e.season, [])
    entry.seasons.get(e.season).push({ number: e.episode, watched_at: new Date(e.watchedAt).toISOString() })
    episodeCount++
  }

  const showsPayload = [...showMap.entries()].map(([showId, { title, seasons }]) => ({
    title,
    ids: { imdb: showId },
    seasons: [...seasons.entries()].map(([number, eps]) => ({ number, episodes: eps })),
  }))

  const moviesPayload = []
  for (const m of movies) {
    if (!withinFrontier(m)) continue
    if (!isImdb(m.itemId)) continue
    moviesPayload.push({ title: m.itemName, ids: { imdb: m.itemId }, watched_at: new Date(m.watchedAt).toISOString() })
  }

  const newWatermark = new Date(frontier)

  if (showsPayload.length === 0 && moviesPayload.length === 0) {
    await prisma.user.update({ where: { id: user.id }, data: { simklLastPushAt: newWatermark } })
    return { synced: 0, movies: 0, episodes: 0 }
  }

  const body = {}
  if (moviesPayload.length) body.movies = moviesPayload
  if (showsPayload.length) body.shows = showsPayload

  const res = await simklFetch('/sync/history', clientId, accessToken, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) {
    // Leave the watermark untouched so the next sweep retries this batch.
    throw new Error(`Simkl /sync/history failed (${res.status})`)
  }
  await prisma.user.update({ where: { id: user.id }, data: { simklLastPushAt: newWatermark } })
  return { synced: moviesPayload.length + episodeCount, movies: moviesPayload.length, episodes: episodeCount }
}

// ---- pull: Simkl -> SlickSync -----------------------------------------------

/**
 * Cheap staleness check via /sync/activities, compared against the last
 * seen activities blob (User.simklSyncState). Returns which top-level
 * categories actually changed since last pull - never calls /sync/all-items
 * on a timer, per Simkl's own docs warning against that.
 */
async function getChangedCategories(clientId, accessToken, previousState) {
  const res = await simklFetch('/sync/activities', clientId, accessToken, { signal: AbortSignal.timeout(ACTIVITY_CHECK_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Simkl /sync/activities failed (${res.status})`)
  const activities = await res.json()
  const prev = previousState ? JSON.parse(previousState) : {}
  const changed = []
  for (const category of ['movies', 'tv_shows', 'anime']) {
    const currentAll = activities?.[category]?.all
    if (currentAll && currentAll !== prev?.[category]?.all) changed.push(category)
  }
  return { changed, activities }
}

/**
 * Pull changed categories from /sync/all-items and merge into
 * EpisodeWatchHistory / MovieWatchHistory, the same tables Stremio/Nuvio's
 * own native pipeline already writes to - tagged to this user like any
 * other watch. Returns { pulled, movies, episodes } or null if not
 * connected / nothing changed.
 */
async function pullWatchHistory(prisma, user) {
  if (!user.simklAccessToken) return null
  const { decrypt } = require('./encryption')
  const accessToken = decrypt(user.simklAccessToken, { appAccountId: user.accountId })
  const clientId = await resolveSimklClientIdForAccount(prisma, user.accountId)

  const { changed, activities } = await getChangedCategories(clientId, accessToken, user.simklSyncState)
  if (changed.length === 0) return { pulled: 0, movies: 0, episodes: 0 }

  let movieCount = 0
  let episodeCount = 0

  for (const category of changed) {
    const type = category === 'movies' ? 'movies' : 'shows'
    // episode_watched_at=yes is what actually puts a watched_at timestamp on
    // each episode below - without it the per-episode watched_at this code
    // reads wouldn't be there at all.
    const extraParams = type === 'shows' ? '&extended=full&episode_watched_at=yes' : ''
    const res = await simklFetch(`/sync/all-items/${type}/completed?${extraParams}`, clientId, accessToken)
    if (!res.ok) {
      console.warn(`[SimklSync] /sync/all-items/${type} failed (${res.status}) for user ${user.id}`)
      continue
    }
    const items = await res.json().catch(() => [])
    if (!Array.isArray(items)) continue

    if (type === 'movies') {
      for (const item of items) {
        const imdb = item?.movie?.ids?.imdb
        if (!isImdb(imdb) || !item?.last_watched) continue
        const watchedAt = new Date(item.last_watched)
        if (isNaN(watchedAt.getTime())) continue
        await prisma.movieWatchHistory.upsert({
          where: { accountId_userId_itemId: { accountId: user.accountId, userId: user.id, itemId: imdb } },
          create: {
            accountId: user.accountId, userId: user.id, itemId: imdb,
            itemName: item.movie.title || imdb, poster: item.movie.poster || null,
            watchedAt, completed: true,
          },
          update: { watchedAt, completed: true },
        }).catch(() => {}) // best-effort - a native pipeline row for the same item wins on unique-constraint conflicts it can't cleanly merge into
        movieCount++
      }
    } else {
      for (const item of items) {
        const showImdb = item?.show?.ids?.imdb
        if (!isImdb(showImdb)) continue
        for (const season of item.seasons || []) {
          for (const ep of season.episodes || []) {
            if (!ep?.watched_at) continue
            const watchedAt = new Date(ep.watched_at)
            if (isNaN(watchedAt.getTime())) continue
            const videoId = `${showImdb}:${season.number}:${ep.episode}`
            await prisma.episodeWatchHistory.upsert({
              where: { accountId_userId_videoId: { accountId: user.accountId, userId: user.id, videoId } },
              create: {
                accountId: user.accountId, userId: user.id, showId: showImdb,
                showName: item.show.title || showImdb, videoId,
                season: season.number, episode: ep.episode,
                poster: item.show.poster || null, watchedAt, completed: true,
              },
              update: { watchedAt, completed: true },
            }).catch(() => {})
            episodeCount++
          }
        }
      }
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { simklSyncState: JSON.stringify(activities), simklLastPullAt: new Date() },
  })

  return { pulled: movieCount + episodeCount, movies: movieCount, episodes: episodeCount }
}

// ---- scheduler --------------------------------------------------------------

async function sweepAllUsers(prisma) {
  const users = await prisma.user.findMany({
    where: { simklAccessToken: { not: null } },
    select: { id: true, accountId: true, username: true, simklAccessToken: true, simklSyncState: true, simklLastPushAt: true },
  })
  for (const user of users) {
    try {
      const pulled = await pullWatchHistory(prisma, user)
      if (pulled && pulled.pulled > 0) {
        console.log(`[SimklSync] Pulled ${pulled.pulled} item(s) (${pulled.movies} movie, ${pulled.episodes} episode) for user ${user.username}`)
      }
    } catch (e) {
      console.warn(`[SimklSync] Pull failed for user ${user.username}:`, e?.message)
    }
    try {
      const pushed = await pushNewWatches(prisma, user)
      if (pushed && pushed.synced > 0) {
        console.log(`[SimklSync] Pushed ${pushed.synced} item(s) (${pushed.movies} movie, ${pushed.episodes} episode) for user ${user.username}`)
      }
    } catch (e) {
      console.warn(`[SimklSync] Push failed for user ${user.username}:`, e?.message)
    }
  }
}

let simklTimer = null
const SWEEP_INTERVAL_MS = 30 * 60 * 1000 // 30m - watch history is time-sensitive, unlike e.g. the 6h vault/DB-size checks

function scheduleSimklSync(prisma) {
  if (simklTimer) return
  const run = () => sweepAllUsers(prisma).catch((e) => console.warn('[SimklSync] Sweep failed:', e?.message))
  run()
  simklTimer = setInterval(run, SWEEP_INTERVAL_MS)
}

module.exports = {
  pushNewWatches,
  pullWatchHistory,
  sweepAllUsers,
  scheduleSimklSync,
}
