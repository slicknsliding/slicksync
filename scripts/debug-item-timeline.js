// Read-only diagnostic - dumps every row across every watch-tracking table for
// one (userId, itemId) pair: WatchSnapshot (the raw overallTimeWatched/timeOffset
// readings metricsProcessor.js diffs to compute WatchActivity deltas),
// WatchActivity (the resulting deltas), MovieWatchHistory/EpisodeWatchHistory
// (the native History record), and WatchSession (sessionTracker.js's
// position-tracked session). Useful for figuring out exactly which pipeline
// disagrees with which, and why - e.g. a big single WatchActivity delta that
// doesn't match the WatchSession duration badge, or an item with real
// WatchActivity minutes that never made it into History at all.
// Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-item-timeline.js <userId> <itemId>

const { PrismaClient } = require('@prisma/client')

async function main() {
  const [, , userId, itemId] = process.argv
  if (!userId || !itemId) {
    console.error('Usage: node scripts/debug-item-timeline.js <userId> <itemId>')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const [snapshots, activity, movieHistory, episodeHistory, session] = await Promise.all([
      prisma.watchSnapshot.findMany({ where: { userId, itemId }, orderBy: { date: 'asc' } }),
      prisma.watchActivity.findMany({ where: { userId, itemId }, orderBy: { createdAt: 'asc' } }),
      prisma.movieWatchHistory.findFirst({ where: { userId, itemId } }),
      prisma.episodeWatchHistory.findMany({ where: { userId, showId: itemId } }),
      prisma.watchSession.findUnique({ where: { accountId_userId_itemId: { accountId: 'default', userId, itemId } } }),
    ])

    console.log(`=== WatchSnapshot (${snapshots.length} rows) ===`)
    for (const s of snapshots) {
      console.log(`  date=${s.date.toISOString().split('T')[0]}  overallTimeWatched=${s.overallTimeWatched}  timeOffset=${s.timeOffset}  lastWatched=${s.lastWatched?.toISOString()}`)
    }

    console.log(`\n=== WatchActivity (${activity.length} rows) ===`)
    for (const a of activity) {
      console.log(`  date=${a.date.toISOString().split('T')[0]}  +${a.watchTimeSeconds}s  createdAt=${a.createdAt.toISOString()}`)
    }

    console.log(`\n=== MovieWatchHistory ===`)
    console.log(movieHistory
      ? `  itemName="${movieHistory.itemName}"  watchedAt=${movieHistory.watchedAt.toISOString()}  durationSeconds=${movieHistory.durationSeconds ?? 'null'}`
      : '  (none)')

    console.log(`\n=== EpisodeWatchHistory (${episodeHistory.length} rows) ===`)
    for (const e of episodeHistory) {
      console.log(`  S${e.season}E${e.episode}  videoId=${e.videoId}  watchedAt=${e.watchedAt.toISOString()}  durationSeconds=${e.durationSeconds ?? 'null'}`)
    }

    console.log(`\n=== WatchSession ===`)
    console.log(session
      ? `  itemName="${session.itemName}"  isActive=${session.isActive}  startTime=${session.startTime.toISOString()}  endTime=${session.endTime?.toISOString() ?? 'null'}  startPosition=${session.startPosition}  lastPosition=${session.lastPosition}  totalDuration=${session.totalDuration}  durationSeconds=${session.durationSeconds}  updatedAt=${session.updatedAt.toISOString()}`
      : '  (none)')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
