/**
 * Continue Watching - for each show a user has partway watched, finds the
 * next unwatched episode using Cinemeta's full episode list, and builds a
 * deep link to resume it in the provider app.
 *
 * Stremio has a well-established deep-link URL scheme (stremio:///detail/...)
 * that opens the app directly to a specific episode, with a web.stremio.com
 * fallback for anyone without the app installed.
 *
 * Nuvio's own format was confirmed by reading NuvioMedia/NuvioDesktop's
 * source directly (composeApp/src/commonMain/kotlin/com/nuvio/app/core/
 * deeplink/AppUrlBridge.kt, buildMetaDeepLinkUrl) rather than guessed at -
 * the app registers nuvio:// on Windows (Nuvio Desktop 0.1.11-alpha+) and
 * its parser accepts nuvio://meta?type={movie|series}&id={imdbId}. Unlike
 * Stremio's link, that format has no season/episode parameter at all, so it
 * can only open the show's own page, not a specific episode - still a real
 * improvement over the IMDb-only fallback used before this was confirmed.
 */

const { fetchMetadata } = require('./notify')
const { buildStremioLinks, buildNuvioAppUrl } = require('./appLinks')

/**
 * Given the season/episode of the last-watched episode and the show's full
 * sorted episode list, finds the next one in watch order. Returns null if
 * the last watched episode IS the last known episode (caught up / waiting
 * on the next season).
 */
function findNextEpisode(allEpisodes, lastSeason, lastEpisode) {
  if (!Array.isArray(allEpisodes) || allEpisodes.length === 0) return null

  const lastIndex = allEpisodes.findIndex((e) => e.season === lastSeason && e.episode === lastEpisode)
  if (lastIndex === -1 || lastIndex === allEpisodes.length - 1) return null

  return allEpisodes[lastIndex + 1]
}

// Minimum position (2 min in) and completion ceiling (92%) for a session to
// count as "partway through" - below the floor is a barely-started click
// that would be noise to resume, above the ceiling is close enough to done
// that the next episode is what the person actually wants (the same ballpark
// thresholds streaming apps themselves use for their own resume rows).
// lastPosition/totalDuration come from WatchSession, which records them from
// state.timeOffset/state.duration only - the position field that's bounded
// by the item's own runtime and safe to read at a point in time (see
// CLAUDE.md on timeOffset vs overallTimeWatched; overallTimeWatched is
// never used here).
const RESUME_MIN_POSITION_MS = 2 * 60 * 1000
const RESUME_MAX_RATIO = 0.92

/**
 * Reads how far through an item's most recent viewing the user got, from
 * that item's WatchSession row. Returns { inProgress, progressPercent } -
 * inProgress false when there's no session, no usable position data, or the
 * position falls outside the resume window above. For series, the session
 * must be for the SAME episode as `videoId` (WatchSession is one reused row
 * per show, so its lastPosition belongs to whatever episode videoId says).
 */
async function getResumeState(prisma, accountId, userId, itemId, videoId) {
  let session = null
  try {
    session = await prisma.watchSession.findUnique({
      where: { accountId_userId_itemId: { accountId, userId, itemId } },
      select: { videoId: true, lastPosition: true, totalDuration: true }
    })
  } catch {}

  if (!session || !session.lastPosition || !session.totalDuration) {
    return { inProgress: false, progressPercent: null }
  }
  if (videoId && session.videoId !== videoId) {
    return { inProgress: false, progressPercent: null }
  }

  const ratio = session.lastPosition / session.totalDuration
  const inProgress = session.lastPosition >= RESUME_MIN_POSITION_MS && ratio < RESUME_MAX_RATIO
  return { inProgress, progressPercent: Math.round(ratio * 100) }
}

/**
 * Builds the Continue Watching list for an account: one entry per show with
 * a computable next episode, most-recently-watched shows first, capped to
 * `limit`.
 */
async function getContinueWatching(prisma, accountId, limit = 8) {
  const accountIdValue = accountId || 'default'

  // Most recently watched episode per (userId, showId) - fetch a reasonable
  // recent window and reduce in JS rather than fighting SQLite/Prisma
  // groupBy for "latest row per group with full columns".
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) // 120 days
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId: accountIdValue, watchedAt: { gte: since } },
    orderBy: { watchedAt: 'desc' }
  })

  const latestPerShow = new Map()
  for (const row of rows) {
    const key = `${row.userId}:${row.showId}`
    if (!latestPerShow.has(key)) latestPerShow.set(key, row)
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
    select: { id: true, username: true, providerType: true }
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  const dismissed = await prisma.dismissedContinueWatching.findMany({
    where: { accountId: accountIdValue },
    select: { userId: true, showId: true }
  })
  const dismissedKeys = new Set(dismissed.map((d) => `${d.userId}:${d.showId}`))

  const candidates = Array.from(latestPerShow.values())
    .filter((row) => !dismissedKeys.has(`${row.userId}:${row.showId}`))
    .sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime())
    .slice(0, limit * 2) // fetch extra since some won't have a computable next episode

  const results = []
  for (const row of candidates) {
    if (results.length >= limit) break

    const user = userMap.get(row.userId)
    if (!user) continue

    const metadata = await fetchMetadata(row.showId, 'series', row.videoId)
    if (!metadata || !metadata.allEpisodes) continue

    // If the last-watched episode itself is still partway through, resume
    // THAT episode - jumping to the next one mid-episode was the reported
    // bug this exists to fix. Only when it's finished (or there's no
    // position data to judge by) does the card advance to the next episode.
    const resumeState = await getResumeState(prisma, accountIdValue, row.userId, row.showId, row.videoId)

    let target
    let isResume = false
    if (resumeState.inProgress && row.season != null && row.episode != null) {
      const current = metadata.allEpisodes.find((e) => e.season === row.season && e.episode === row.episode)
      target = {
        season: row.season,
        episode: row.episode,
        title: current?.title ?? null,
        thumbnail: current?.thumbnail ?? null
      }
      isResume = true
    } else {
      const next = findNextEpisode(metadata.allEpisodes, row.season, row.episode)
      if (!next) continue
      target = {
        season: next.season,
        episode: next.episode,
        title: next.title,
        thumbnail: next.thumbnail
      }
    }

    const entry = {
      userId: user.id,
      username: user.username,
      contentType: 'series',
      showId: row.showId,
      showName: metadata.title || row.showName,
      poster: metadata.poster || row.poster,
      lastWatched: { season: row.season, episode: row.episode },
      // Field name kept for client compatibility - when resume=true this is
      // the in-progress episode itself, not actually the "next" one.
      nextEpisode: target,
      resume: isResume,
      progressPercent: isResume ? resumeState.progressPercent : null,
      lastWatchedAt: row.watchedAt,
      imdbRating: metadata.imdbRating || null,
      rottenTomatoes: metadata.rottenTomatoes || null,
      metacritic: metadata.metacritic || null
    }

    if (metadata.imdb_id) {
      // Both branches use a plain native <a href> on the client with no JS
      // in the way (see ContinueWatchingCard in page.tsx) - a prior attempt
      // at JS-driven fallback logic (intercept the click, set location.href
      // programmatically, time a fallback) broke the Stremio link that
      // already worked, because browsers handle a direct anchor click far
      // more reliably than scripted navigation for custom URL schemes. That
      // means neither link can "detect and fall back" if the app isn't
      // installed - same known tradeoff Stremio's link already had, applied
      // symmetrically now that Nuvio has a real scheme to offer too.
      // For a resume entry the link targets the in-progress episode -
      // Stremio itself owns the saved playback position, so opening that
      // episode resumes from where they left off.
      if (user.providerType === 'stremio') {
        const links = buildStremioLinks(metadata.imdb_id, 'series', target.season, target.episode)
        entry.appUrl = links.appUrl
        entry.webUrl = links.webUrl
      } else {
        entry.appUrl = buildNuvioAppUrl('series', metadata.imdb_id)
        entry.webUrl = `https://www.imdb.com/title/${metadata.imdb_id}`
      }
    }

    results.push(entry)
  }

  // In-progress MOVIES - previously absent entirely (only episodeWatchHistory
  // was read, so a movie stopped halfway never appeared anywhere). A movie
  // only qualifies while its WatchSession says it's partway through; finished
  // movies have nothing to continue.
  const movieRows = await prisma.movieWatchHistory.findMany({
    where: { accountId: accountIdValue, watchedAt: { gte: since } },
    orderBy: { watchedAt: 'desc' }
  })
  const latestPerMovie = new Map()
  for (const row of movieRows) {
    const key = `${row.userId}:${row.itemId}`
    if (!latestPerMovie.has(key)) latestPerMovie.set(key, row)
  }

  const movieUsers = await prisma.user.findMany({
    where: { id: { in: [...new Set(movieRows.map((r) => r.userId))] } },
    select: { id: true, username: true, providerType: true }
  })
  for (const u of movieUsers) userMap.set(u.id, u)

  const movieEntries = []
  for (const row of latestPerMovie.values()) {
    // Dismissals reuse the showId column with the movie's own id.
    if (dismissedKeys.has(`${row.userId}:${row.itemId}`)) continue

    const user = userMap.get(row.userId)
    if (!user) continue

    const resumeState = await getResumeState(prisma, accountIdValue, row.userId, row.itemId, null)
    if (!resumeState.inProgress) continue

    const metadata = await fetchMetadata(row.itemId, 'movie', null)

    const entry = {
      userId: user.id,
      username: user.username,
      contentType: 'movie',
      showId: row.itemId,
      showName: metadata?.title || row.itemName,
      poster: metadata?.poster || row.poster,
      lastWatched: null,
      nextEpisode: null,
      resume: true,
      progressPercent: resumeState.progressPercent,
      lastWatchedAt: row.watchedAt,
      imdbRating: metadata?.imdbRating || null,
      rottenTomatoes: metadata?.rottenTomatoes || null,
      metacritic: metadata?.metacritic || null
    }

    const imdbId = metadata?.imdb_id || (row.itemId.startsWith('tt') ? row.itemId : null)
    if (imdbId) {
      if (user.providerType === 'stremio') {
        const links = buildStremioLinks(imdbId, 'movie')
        entry.appUrl = links.appUrl
        entry.webUrl = links.webUrl
      } else {
        entry.appUrl = buildNuvioAppUrl('movie', imdbId)
        entry.webUrl = `https://www.imdb.com/title/${imdbId}`
      }
    }

    movieEntries.push(entry)
  }

  // Merge, most recently watched first, and re-cap - movies compete for the
  // same row as shows rather than getting bolted onto the end.
  return [...results, ...movieEntries]
    .sort((a, b) => new Date(b.lastWatchedAt).getTime() - new Date(a.lastWatchedAt).getTime())
    .slice(0, limit)
}

/**
 * Removes a show from the account's Continue Watching row. Persisted
 * server-side (not localStorage) so a dismissal made from one browser or
 * device stays dismissed everywhere.
 */
async function dismissContinueWatching(prisma, accountId, userId, showId) {
  const accountIdValue = accountId || 'default'
  await prisma.dismissedContinueWatching.upsert({
    where: { accountId_userId_showId: { accountId: accountIdValue, userId, showId } },
    create: { accountId: accountIdValue, userId, showId },
    update: {}
  })
}

module.exports = { getContinueWatching, dismissContinueWatching }
