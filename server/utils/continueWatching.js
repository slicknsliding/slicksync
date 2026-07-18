/**
 * Continue Watching - for each show a user has partway watched, finds the
 * next unwatched episode using Cinemeta's full episode list, and builds a
 * deep link to resume it in the provider app.
 *
 * Stremio has a well-established deep-link URL scheme (stremio:///detail/...)
 * that opens the app directly to a specific episode, with a web.stremio.com
 * fallback for anyone without the app installed. Nuvio has no known
 * equivalent - rather than guess at a URL scheme that might not exist and
 * ship a broken button, Nuvio users get an IMDb link instead, which is still
 * useful for finding what's next even without a one-tap launch into the app.
 */

const { fetchMetadata } = require('./notify')

function buildStremioLinks(imdbId, season, episode) {
  const videoId = `${imdbId}:${season}:${episode}`
  return {
    appUrl: `stremio:///detail/series/${imdbId}/${videoId}`,
    webUrl: `https://web.stremio.com/#/detail/series/${imdbId}/${videoId}`
  }
}

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
      const links = buildStremioLinks(metadata.imdb_id, next.season, next.episode)

      // Stremio's own desktop/mobile clients have long-established stremio://
      // registration - confirmed working (a real click opened the app). Nuvio's
      // Android app also registers that scheme in its manifest, but Nuvio's
      // desktop client is alpha/testers-only and has no confirmed protocol
      // registration on any platform - handing it an app link that can never
      // be caught just adds a broken step before the fallback, and a prior
      // attempt at JS-driven fallback logic for exactly this case ended up
      // breaking the Stremio path that already worked. Simplest reliable
      // split: Stremio gets the real app link (plain <a href>, no JS
      // involved - that's what was confirmed working). Everyone else gets
      // the web.stremio.com link as an ordinary web link - same rich detail
      // page, no native handoff attempted.
      if (user.providerType === 'stremio') {
        entry.appUrl = links.appUrl
      }
      entry.webUrl = links.webUrl
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
