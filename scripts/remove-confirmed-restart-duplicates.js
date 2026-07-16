// Deletes only the specific WatchActivity rows confirmed (by manual timing
// review, not a heuristic) to be restart-artifact duplicates from the
// non-atomic activity+snapshot write bug fixed in metricsProcessor.js.
//
// This deliberately does NOT do general "same value = duplicate" detection
// - an earlier version of this script (dedupe-watch-activity.js) did, and
// it was wrong: a real continuous-watching session naturally produces many
// consecutive WatchActivity rows with the identical delta value (e.g. 50
// rows of exactly 120s each, one per 2-minute poll, for someone watching
// something for 1h45m straight) - that's correct behavior, not a bug.
// WatchActivity only stores the computed delta, not the underlying
// position at each poll, so there's no way to safely tell "the baseline
// didn't advance" apart from "the baseline advanced by a value that
// happened to repeat" after the fact. Automating that distinction risks
// deleting real watch history, which is worse than leaving a few
// historical duplicate rows in place - so this only removes the rows
// below, whose restart-artifact origin was confirmed by inspecting the
// actual timing pattern (irregular multi-minute gaps, 2-3 total
// occurrences - unlike the tight, uniform, many-row pattern a real
// session produces) against known container-restart timing.
//
// Safe to run more than once (no-ops on rows that no longer exist).
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/remove-confirmed-restart-duplicates.js

const { PrismaClient } = require('@prisma/client')

const CONFIRMED_DUPLICATE_IDS = [
  // itemId=tt14452776, date=2026-07-16, watchTimeSeconds=20919 - kept cmrnpy6yy0dobqr2km1xleugh
  'cmrnq8go30h7fqr2kg57d9hit',
  'cmrnq9enx0hjbqr2k4dex701m',
  // itemId=tt37287335, date=2026-07-16, watchTimeSeconds=6368 - kept cmrnq1yvh0faxqr2kvljfo02e
  'cmrnq8j4j0h8jqr2km5jl60j4',
  'cmrnqayug0iixqr2kjrod5skd',
]

async function main() {
  const prisma = new PrismaClient()
  try {
    const existing = await prisma.watchActivity.findMany({
      where: { id: { in: CONFIRMED_DUPLICATE_IDS } },
    })

    if (existing.length === 0) {
      console.log('None of the confirmed duplicate rows exist anymore - nothing to do.')
      return
    }

    for (const row of existing) {
      console.log(`Deleting ${row.id}: itemId=${row.itemId} watchTimeSeconds=${row.watchTimeSeconds} createdAt=${row.createdAt.toISOString()}`)
    }

    const result = await prisma.watchActivity.deleteMany({
      where: { id: { in: existing.map((r) => r.id) } },
    })
    console.log(`\nDeleted ${result.count} row(s).`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
