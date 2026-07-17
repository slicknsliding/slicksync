// Read-only diagnostic - for a user's recent EpisodeWatchHistory/
// MovieWatchHistory rows, shows whether a matching native WatchSession
// exists and whether it would be picked up by mergeCrossPipelineDuplicates
// (metricsBuilder.js): same item id (+ same season/episode for series), and
// within MERGE_WINDOW_MS of the session's updatedAt. Useful for confirming
// whether a history entry showing no duration in the Activity feed is
// missing a session entirely vs. just falling outside the merge window.
// Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-history-duration-merge.js <userId> [days]

const { PrismaClient } = require('@prisma/client')

const MERGE_WINDOW_MS = 3 * 60 * 60 * 1000 // keep in sync with metricsBuilder.js

async function main() {
  const [, , userId, daysArg] = process.argv
  if (!userId) {
    console.error('Usage: node scripts/debug-history-duration-merge.js <userId> [days]')
    process.exit(1)
  }
  const days = daysArg ? parseInt(daysArg, 10) : 7
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const prisma = new PrismaClient()
  try {
    const [episodes, movies, sessions] = await Promise.all([
      prisma.episodeWatchHistory.findMany({
        where: { userId, watchedAt: { gte: since } },
        orderBy: { watchedAt: 'desc' },
      }),
      prisma.movieWatchHistory.findMany({
        where: { userId, watchedAt: { gte: since } },
        orderBy: { watchedAt: 'desc' },
      }),
      prisma.watchSession.findMany({
        where: { userId },
      }),
    ])

    const entries = [
      ...episodes.map((e) => ({
        kind: 'episode', itemId: e.showId, name: e.showName,
        season: e.season, episode: e.episode, watchedAt: e.watchedAt,
      })),
      ...movies.map((m) => ({
        kind: 'movie', itemId: m.itemId, name: m.itemName,
        season: null, episode: null, watchedAt: m.watchedAt,
      })),
    ].sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime())

    console.log(`${entries.length} history rows for userId=${userId} since ${since.toISOString()}`)
    console.log(`${sessions.length} total WatchSession rows for this user (any date)\n`)

    for (const entry of entries) {
      const byId = sessions.filter((s) => s.itemId === entry.itemId)
      if (byId.length === 0) {
        console.log(`✗ NO SESSION  [${entry.kind}] ${entry.name}${entry.season != null ? ` S${entry.season}E${entry.episode}` : ''}  watchedAt=${entry.watchedAt.toISOString()}  itemId=${entry.itemId}`)
        continue
      }

      for (const s of byId) {
        const seMatch = entry.season == null || (s.season === entry.season && s.episode === entry.episode)
        const updatedAt = s.updatedAt || s.startTime
        const diffMs = Math.abs(updatedAt.getTime() - entry.watchedAt.getTime())
        const withinWindow = diffMs <= MERGE_WINDOW_MS
        const wouldMatch = seMatch && withinWindow
        console.log(
          `${wouldMatch ? '✓ MATCH' : '✗ NO MATCH'}  [${entry.kind}] ${entry.name}${entry.season != null ? ` S${entry.season}E${entry.episode}` : ''}` +
          `  session(S${s.season ?? '-'}E${s.episode ?? '-'}, duration=${s.durationSeconds ?? 0}s, updatedAt=${updatedAt.toISOString()})` +
          `  diff=${Math.round(diffMs / 60000)}m  seMatch=${seMatch}  withinWindow=${withinWindow}`
        )
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
