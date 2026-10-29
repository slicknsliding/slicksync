// Pieces of a person's own Home that the activity answer carries
// (routes/publicLibrary.js GET /activity).

/**
 * What they watched lately, newest first, with back-to-back episodes of one
 * show folded into a single entry ("S03 · E01-E05, 5 episodes"). Five entries.
 */
async function recentlyWatchedGroups(prisma, accountId, userId, limit = 5) {
  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.findMany({
      where: { accountId, userId },
      orderBy: { watchedAt: 'desc' },
      take: 80,
      select: { showId: true, itemName: true, poster: true, season: true, episode: true, watchedAt: true },
    }).catch(() => []),
    prisma.movieWatchHistory.findMany({
      where: { accountId, userId },
      orderBy: { watchedAt: 'desc' },
      take: 20,
      select: { itemId: true, itemName: true, poster: true, watchedAt: true },
    }).catch(() => []),
  ])
  const watches = [
    ...episodes.map((e) => ({ kind: 'series', id: e.showId, name: e.itemName, poster: e.poster, season: e.season, episode: e.episode, at: new Date(e.watchedAt) })),
    ...movies.map((m) => ({ kind: 'movie', id: m.itemId, name: m.itemName, poster: m.poster, at: new Date(m.watchedAt) })),
  ].sort((a, b) => b.at - a.at)

  const groups = []
  for (const w of watches) {
    const last = groups[groups.length - 1]
    if (last && w.kind === 'series' && last.type === 'series' && last.id === w.id && last.season === w.season) {
      last.count++
      if (w.episode != null) {
        last.fromEpisode = last.fromEpisode == null ? w.episode : Math.min(last.fromEpisode, w.episode)
        last.toEpisode = last.toEpisode == null ? w.episode : Math.max(last.toEpisode, w.episode)
      }
      continue
    }
    if (groups.length >= limit) break
    groups.push({
      id: w.id,
      type: w.kind,
      name: w.name || w.id,
      poster: w.poster || null,
      season: w.kind === 'series' ? (w.season ?? null) : null,
      fromEpisode: w.kind === 'series' ? (w.episode ?? null) : null,
      toEpisode: w.kind === 'series' ? (w.episode ?? null) : null,
      count: 1,
      watchedAt: w.at.toISOString(),
    })
  }
  return groups
}

/** The Nuvio (or AIOStreams) profile their history last recorded, or null. */
async function latestProfileLabel(prisma, accountId, userId) {
  try {
    const row = await prisma.watchActivity.findFirst({
      where: { accountId, userId, profileLabel: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { profileLabel: true },
    })
    return row?.profileLabel || null
  } catch {
    return null
  }
}

module.exports = { recentlyWatchedGroups, latestProfileLabel }
