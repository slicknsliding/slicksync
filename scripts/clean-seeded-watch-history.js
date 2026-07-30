// One-time cleanup for MovieWatchHistory/EpisodeWatchHistory rows that look
// like pre-existing seed/demo data rather than genuine tracked watches.
//
// Signature: durationSeconds IS NULL AND completed IS NULL. Every row with
// real playback data has at least one of those set (metricsProcessor.js's
// recordMovieWatch/recordEpisodeWatch always compute `completed` via
// computeCompleted() and backfill durationSeconds from WatchSession when
// available) - a row with BOTH null never went through that real pipeline.
// Confirmed on the account this was built for: 801 of 827 MovieWatchHistory
// rows (97%) and 170 of 195 EpisodeWatchHistory rows (87%) match this
// signature, and among the movie rows, 326 pairs share the exact same
// millisecond timestamp across two different users - real playback never
// produces that; it's the signature of a bulk seed/import script.
//
// This inflates every stat feature that reads these tables (Year in Review,
// Metrics, the Activity feed's movie/episode counts) with data that isn't
// real viewing. Does NOT touch WatchActivity (the actual watch-TIME source)
// or WatchSession - those have a different, much smaller footprint and
// deleting from them would directly change Watch Time Today totals, a
// separate decision from removing fake title-count entries.
//
// Dry-run by default: prints counts + a title sample for review. Pass
// --apply to actually delete. Safe to run more than once (a second dry run
// after --apply should show 0 remaining).
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/clean-seeded-watch-history.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/clean-seeded-watch-history.js --apply

const { PrismaClient } = require('@prisma/client')

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()

  try {
    const seededMovies = await prisma.movieWatchHistory.findMany({
      where: { durationSeconds: null, completed: null },
      select: { id: true, itemId: true, itemName: true, userId: true, watchedAt: true },
      orderBy: { watchedAt: 'asc' },
    })
    const seededEpisodes = await prisma.episodeWatchHistory.findMany({
      where: { durationSeconds: null, completed: null },
      select: { id: true, showId: true, showName: true, season: true, episode: true, userId: true, watchedAt: true },
      orderBy: { watchedAt: 'asc' },
    })

    const totalMovies = await prisma.movieWatchHistory.count()
    const totalEpisodes = await prisma.episodeWatchHistory.count()

    console.log(`MovieWatchHistory: ${seededMovies.length} of ${totalMovies} rows look seeded (null duration + null completed)`)
    console.log(`EpisodeWatchHistory: ${seededEpisodes.length} of ${totalEpisodes} rows look seeded\n`)

    if (seededMovies.length > 0) {
      console.log(`Date range: ${seededMovies[0].watchedAt.toISOString().slice(0, 10)} to ${seededMovies[seededMovies.length - 1].watchedAt.toISOString().slice(0, 10)}`)
      console.log('Sample (first 10):')
      for (const m of seededMovies.slice(0, 10)) {
        console.log(`  ${m.watchedAt.toISOString()}  ${m.itemName}  user=${m.userId}`)
      }
      console.log('')
    }
    if (seededEpisodes.length > 0) {
      console.log('Sample episodes (first 10):')
      for (const e of seededEpisodes.slice(0, 10)) {
        console.log(`  ${e.watchedAt.toISOString()}  ${e.showName} S${e.season}E${e.episode}  user=${e.userId}`)
      }
      console.log('')
    }

    if (seededMovies.length === 0 && seededEpisodes.length === 0) {
      console.log('Nothing to do.')
    } else if (apply) {
      const rm = await prisma.movieWatchHistory.deleteMany({ where: { id: { in: seededMovies.map((m) => m.id) } } })
      const re = await prisma.episodeWatchHistory.deleteMany({ where: { id: { in: seededEpisodes.map((e) => e.id) } } })
      console.log(`Deleted ${rm.count} MovieWatchHistory row(s) and ${re.count} EpisodeWatchHistory row(s).`)
    } else {
      console.log('Dry run only - review the sample above, then re-run with --apply to delete.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
