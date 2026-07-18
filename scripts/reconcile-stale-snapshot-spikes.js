// One-time cleanup for WatchActivity rows inflated by the stale-snapshot-
// recovery bug (fixed in metricsProcessor.js: delta baseline now uses the
// running max overallTimeWatched across all history, not just the single
// most recent snapshot).
//
// Root cause: Nuvio's multi-profile merge (server/providers/nuvio.js) falls
// back to an empty progress array for a profile whose sync_pull_watch_progress
// call fails transiently. If a second, unrelated profile watched the same
// item long ago and is fetched successfully that same poll, its old, frozen
// reading can briefly become the only available data for that item - a real
// regression that self-corrects on the next successful poll. Comparing
// against only the single prior snapshot treated that recovery as new
// watching, producing a single, oversized WatchActivity row (confirmed real
// case: a 5480-second/91-minute row from a snapshot recovering to a value
// already recorded six days earlier).
//
// Like reset-proxy-inflated-durations.js's threshold-based check for a
// structurally similar problem: the native pipeline polls frequently, so a
// single legitimate delta should rarely exceed the threshold. This is shown
// for review rather than auto-applied by default, since an oversized delta
// CAN legitimately happen (e.g. the poller was down for a while and picks
// up a real multi-hour jump on restart) - use judgment before --apply.
//
// Dry-run by default. Pass --apply to delete. Safe to run more than once.
// Threshold override: --threshold=900 (seconds).
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-stale-snapshot-spikes.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-stale-snapshot-spikes.js --apply

const { PrismaClient } = require('@prisma/client')

function fmt(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

async function main() {
  const apply = process.argv.includes('--apply')
  const thresholdArg = process.argv.find((a) => a.startsWith('--threshold='))
  const THRESHOLD_SECONDS = thresholdArg ? Number(thresholdArg.split('=')[1]) : 900 // 15 min

  const prisma = new PrismaClient()
  try {
    const oversized = await prisma.watchActivity.findMany({
      where: { watchTimeSeconds: { gt: THRESHOLD_SECONDS } },
      select: { id: true, userId: true, itemId: true, itemType: true, watchTimeSeconds: true, date: true, createdAt: true },
      orderBy: { watchTimeSeconds: 'desc' },
    })

    console.log(`WatchActivity rows over ${fmt(THRESHOLD_SECONDS)} in a single delta: ${oversized.length}\n`)
    for (const a of oversized) {
      console.log(`  ${a.id}  user=${a.userId}  ${a.itemId} (${a.itemType})  ${fmt(a.watchTimeSeconds)}  date=${a.date.toISOString().split('T')[0]}  created=${a.createdAt.toISOString()}`)
    }

    if (oversized.length === 0) {
      console.log('Nothing to do.')
    } else if (apply) {
      const r = await prisma.watchActivity.deleteMany({ where: { id: { in: oversized.map((a) => a.id) } } })
      console.log(`\nDeleted ${r.count} row(s).`)
    } else {
      console.log('\nDry run only - review each row above before deciding, then re-run with --apply.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
