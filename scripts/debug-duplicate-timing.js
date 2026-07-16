// Read-only diagnostic - prints the createdAt timestamps (and gaps between
// them) for every WatchActivity row for a given itemId+date, to see
// whether duplicate deltas were clustered (consistent with a handful of
// container restarts) or spread evenly across many consecutive poll
// cycles (which would point to a different, ongoing bug rather than just
// restart timing). Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-duplicate-timing.js <itemId> <YYYY-MM-DD>

const { PrismaClient } = require('@prisma/client')

async function main() {
  const [, , itemId, dateStr] = process.argv
  if (!itemId || !dateStr) {
    console.error('Usage: node scripts/debug-duplicate-timing.js <itemId> <YYYY-MM-DD>')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const rows = await prisma.watchActivity.findMany({
      where: { itemId, date: new Date(dateStr) },
      orderBy: { createdAt: 'asc' },
    })

    console.log(`${rows.length} rows for itemId=${itemId} date=${dateStr}\n`)

    let prev = null
    for (const row of rows) {
      const gapSec = prev ? Math.round((row.createdAt.getTime() - prev.getTime()) / 1000) : null
      console.log(
        `${row.createdAt.toISOString()}  watchTimeSeconds=${row.watchTimeSeconds}` +
        (gapSec !== null ? `  (+${gapSec}s since previous)` : '')
      )
      prev = row.createdAt
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
