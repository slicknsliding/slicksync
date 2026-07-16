// One-time cleanup for duplicate WatchActivity rows caused by the
// non-atomic activity+snapshot write bug fixed in metricsProcessor.js: a
// container restart landing between recording a delta and advancing the
// snapshot baseline (activityMonitor.js runs an immediate poll on every
// boot) could leave the delta recorded without the baseline that's
// supposed to prevent recording it again, so the next restart's poll
// recorded the exact same delta a second (or third) time.
//
// Finds rows that share the same (accountId, userId, itemId, date,
// watchTimeSeconds) - an exact-value match for the same item/day is, for
// all practical purposes, only possible from this bug, not two genuinely
// different viewing sessions happening to produce the identical second
// count - and keeps only the earliest (by createdAt), removing the rest.
//
// Dry-run by default (prints what it would do). Pass --apply to actually
// delete.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/dedupe-watch-activity.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/dedupe-watch-activity.js --apply

const { PrismaClient } = require('@prisma/client')

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.watchActivity.findMany({ orderBy: { createdAt: 'asc' } })

    const groups = new Map()
    for (const row of rows) {
      const key = `${row.accountId}::${row.userId}::${row.itemId}::${row.date.toISOString()}::${row.watchTimeSeconds}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }

    let totalDupes = 0
    const idsToDelete = []
    for (const group of groups.values()) {
      if (group.length <= 1) continue
      const [keep, ...dupes] = group // earliest kept - rows were fetched ordered by createdAt asc
      totalDupes += dupes.length
      console.log(
        `Duplicate group: itemId=${keep.itemId} date=${keep.date.toISOString().split('T')[0]} ` +
        `watchTimeSeconds=${keep.watchTimeSeconds} - keeping ${keep.id} (${keep.createdAt.toISOString()}), ` +
        `${apply ? 'deleting' : 'would delete'} ${dupes.length}: ${dupes.map((d) => d.id).join(', ')}`
      )
      idsToDelete.push(...dupes.map((d) => d.id))
    }

    console.log(`\n${totalDupes} duplicate row(s) found across ${rows.length} total WatchActivity rows.`)

    if (idsToDelete.length === 0) {
      console.log('Nothing to do.')
    } else if (apply) {
      const result = await prisma.watchActivity.deleteMany({ where: { id: { in: idsToDelete } } })
      console.log(`Deleted ${result.count} row(s).`)
    } else {
      console.log('Dry run only - re-run with --apply to actually delete these rows.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
