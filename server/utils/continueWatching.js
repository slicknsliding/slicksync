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

    const next = findNextEpisode(metadata.allEpisodes, row.season, row.episode)
    if (!next) continue

    const entry = {
      userId: user.id,
      username: user.username,
      showId: row.showId,
      showName: metadata.title || row.showName,
      poster: metadata.poster || row.poster,
      lastWatched: { season: row.season, episode: row.episode },
      nextEpisode: {
        season: next.season,
        episode: next.episode,
        title: next.title,
        thumbnail: next.thumbnail
      },
      lastWatchedAt: row.watchedAt
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
      if (user.providerType === 'stremio') {
        const links = buildStremioLinks(metadata.imdb_id, 'series', next.season, next.episode)
        entry.appUrl = links.appUrl
        entry.webUrl = links.webUrl
      } else {
        entry.appUrl = buildNuvioAppUrl('series', metadata.imdb_id)
        entry.webUrl = `https://www.imdb.com/title/${metadata.imdb_id}`
      }
    }

    results.push(entry)
  }

  return results
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
