// One-time backfill: recomputes durationSeconds=0 on already-closed WatchSession
// rows created before the timeOffset-seeding fix (commit b360c6c) landed. That
// fix only changes behavior for sessions created going forward - it doesn't
// retroactively repair rows that were already created-and-closed at 0 under the
// old logic (single-sitting, no-pause watches, where sessionTracker.js only ever
// saw one checkpoint and had nothing to compute a position-delta against).
//
// startPosition and lastPosition are still stored on these old closed rows even
// though durationSeconds ended up 0 - startPosition is the same "how far into
// this video were we at the first checkpoint" value the live fix now seeds from,
// capped against totalDuration (the item's own runtime) as a safety net, exactly
// matching sessionTracker.js's seeding logic.
//
// Only touches rows where isActive=false, durationSeconds=0, and startPosition
// is a real positive number - never touches rows that already have a real
// measured duration.
//
// Safe to run more than once. Dry-run by default; pass --apply to write.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/fix-zero-duration-sessions.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/fix-zero-duration-sessions.js --apply

const { PrismaClient } = require('@prisma/client')

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.watchSession.findMany({
      where: {
        isActive: false,
        durationSeconds: 0,
        startPosition: { not: null, gt: 0 },
      },
      select: { id: true, itemName: true, startPosition: true, totalDuration: true, startTime: true, endTime: true },
      orderBy: { startTime: 'desc' },
    })

    console.log(`Closed sessions with durationSeconds=0 and a usable startPosition: ${rows.length}\n`)

    let totalFixed = 0
    for (const row of rows) {
      const cappedMs = row.totalDuration && row.totalDuration > 0
        ? Math.min(row.startPosition, row.totalDuration)
        : row.startPosition
      const seedSeconds = Math.max(0, Math.floor(cappedMs / 1000))
      if (seedSeconds <= 0) continue

      console.log(`  "${row.itemName}"  ${row.startTime.toISOString()}  0s -> ${seedSeconds}s`)
      totalFixed++

      if (apply) {
        // Explicitly preserve updatedAt at the row's own endTime/startTime rather
        // than letting Prisma's @updatedAt auto-bump it to "now" - the Activity
        // page's cross-pipeline duration merge matches on updatedAt against a
        // 3-hour window around the original watch date, and running this script
        // days later would otherwise push that window's anchor to today and
        // break the exact match this backfill is trying to enable.
        await prisma.watchSession.update({
          where: { id: row.id },
          data: { durationSeconds: seedSeconds, updatedAt: row.endTime || row.startTime },
        })
      }
    }

    if (totalFixed === 0) {
      console.log('Nothing to do.')
    } else if (apply) {
      console.log(`\nUpdated ${totalFixed} session(s).`)
    } else {
      console.log(`\nDry run only - re-run with --apply to write these ${totalFixed} update(s).`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
