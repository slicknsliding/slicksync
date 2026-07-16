// One-time cleanup for the inflated watch-time data produced by the old
// proxy pipeline, which stored AIOStreams proxy-connection *lifetime* as if
// it were watch *time* (fixed in proxyStreamMonitor.js - the proxy is now a
// presence-only signal and never writes durations). That bug produced:
//   - WatchSession rows with absurd durationSeconds (e.g. 22h for a
//     5-minute view), accumulated across replays.
//   - WatchActivity rows (which feed "Watch Time Today") with the same
//     inflated connection-lifetime values, ballooning the daily total into
//     the tens of hours.
//
// This script:
//   1. Resets durationSeconds to 0 on every proxy-touched WatchSession
//      (identified by requestCount > 0) - proxy entries are presence
//      markers with no reliable duration.
//   2. Deletes WatchActivity rows whose itemId is a synthetic proxy id
//      ("proxy:..."), which are unambiguously proxy-written.
//   3. Flags (and, with --apply, deletes) WatchActivity rows whose single
//      watchTimeSeconds value exceeds THRESHOLD_SECONDS - the native
//      pipeline records small per-poll deltas (~2 min each), so a single
//      multi-hour row is a proxy-lifetime artifact, not real. This one is
//      threshold-based, so it is shown for review; re-run with --apply to
//      actually delete.
//
// Dry-run by default. Pass --apply to make changes. Safe to run more than
// once. Threshold override: --threshold=900 (seconds).
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reset-proxy-inflated-durations.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reset-proxy-inflated-durations.js --apply

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
    // 1) Reset inflated proxy WatchSession durations.
    const inflatedSessions = await prisma.watchSession.findMany({
      where: { requestCount: { gt: 0 }, durationSeconds: { gt: 0 } },
      select: { id: true, itemName: true, durationSeconds: true, requestCount: true },
    })
    console.log(`\n[1] Proxy WatchSession rows with a stored duration to reset: ${inflatedSessions.length}`)
    for (const s of inflatedSessions) {
      console.log(`    ${s.id}  "${s.itemName}"  ${fmt(s.durationSeconds)}  (${s.requestCount} reqs) -> 0`)
    }
    if (apply && inflatedSessions.length > 0) {
      const r = await prisma.watchSession.updateMany({
        where: { id: { in: inflatedSessions.map((s) => s.id) } },
        data: { durationSeconds: 0 },
      })
      console.log(`    Reset ${r.count} session(s).`)
    }

    // 2) Delete unambiguously proxy-written WatchActivity (synthetic "proxy:" ids).
    const proxyActivity = await prisma.watchActivity.findMany({
      where: { itemId: { startsWith: 'proxy:' } },
      select: { id: true, itemId: true, watchTimeSeconds: true, date: true },
    })
    console.log(`\n[2] WatchActivity rows with synthetic proxy itemIds: ${proxyActivity.length}`)
    for (const a of proxyActivity) {
      console.log(`    ${a.id}  ${a.itemId}  ${fmt(a.watchTimeSeconds)}  ${a.date.toISOString().split('T')[0]}`)
    }
    if (apply && proxyActivity.length > 0) {
      const r = await prisma.watchActivity.deleteMany({ where: { id: { in: proxyActivity.map((a) => a.id) } } })
      console.log(`    Deleted ${r.count} row(s).`)
    }

    // 3) Flag oversized WatchActivity rows (proxy-lifetime artifacts).
    const oversized = await prisma.watchActivity.findMany({
      where: { watchTimeSeconds: { gt: THRESHOLD_SECONDS }, itemId: { not: { startsWith: 'proxy:' } } },
      select: { id: true, itemId: true, itemType: true, watchTimeSeconds: true, date: true, createdAt: true },
      orderBy: { watchTimeSeconds: 'desc' },
    })
    console.log(`\n[3] WatchActivity rows over ${fmt(THRESHOLD_SECONDS)} (single-row max the native pipeline should never produce): ${oversized.length}`)
    for (const a of oversized) {
      console.log(`    ${a.id}  ${a.itemId} (${a.itemType})  ${fmt(a.watchTimeSeconds)}  date=${a.date.toISOString().split('T')[0]} created=${a.createdAt.toISOString()}`)
    }
    if (apply && oversized.length > 0) {
      const r = await prisma.watchActivity.deleteMany({ where: { id: { in: oversized.map((a) => a.id) } } })
      console.log(`    Deleted ${r.count} row(s).`)
    }

    if (!apply) {
      console.log('\nDry run only - re-run with --apply to make these changes.')
    } else {
      console.log('\nDone.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
