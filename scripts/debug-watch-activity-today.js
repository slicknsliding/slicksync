// Read-only diagnostic - shows every WatchActivity row for "today" (per the
// account's configured timezone), grouped by user and item, so you can see
// exactly what's contributing to the "Watch Time Today" stat. Useful when
// that number doesn't seem to match what's visible in the Activity feed's
// "Today" section, which only shows completed EpisodeWatchHistory/
// MovieWatchHistory entries - a stricter, separate gate than WatchActivity.
// Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-watch-activity-today.js [accountId]

const { PrismaClient } = require('@prisma/client')
const { getAccountDateString, resolveAccountTimezone } = require('../server/utils/dateUtils')

async function main() {
  const [, , accountIdArg] = process.argv
  const accountId = accountIdArg || 'default'

  const prisma = new PrismaClient()
  try {
    const timeZone = await resolveAccountTimezone(prisma, accountId)
    const todayStr = getAccountDateString(new Date(), timeZone)

    const rows = await prisma.watchActivity.findMany({
      where: { accountId, date: new Date(todayStr) },
      orderBy: { createdAt: 'asc' },
    })

    const users = await prisma.user.findMany({ select: { id: true, username: true } })
    const userMap = new Map(users.map((u) => [u.id, u.username]))

    console.log(`Today = ${todayStr} (timezone ${timeZone})`)
    console.log(`${rows.length} WatchActivity rows for account=${accountId}\n`)

    const byUser = new Map()
    for (const row of rows) {
      const key = row.userId
      if (!byUser.has(key)) byUser.set(key, [])
      byUser.get(key).push(row)
    }

    let grandTotal = 0
    for (const [userId, userRows] of byUser) {
      const userTotal = userRows.reduce((sum, r) => sum + r.watchTimeSeconds, 0)
      grandTotal += userTotal
      console.log(`${userMap.get(userId) || userId}  —  ${Math.round(userTotal / 60)}m total`)
      for (const r of userRows) {
        console.log(`    ${r.itemId} (${r.itemType})  +${r.watchTimeSeconds}s  createdAt=${r.createdAt.toISOString()}`)
      }
    }

    console.log(`\nGrand total across all users: ${Math.round(grandTotal / 60)}m (${grandTotal}s)`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
