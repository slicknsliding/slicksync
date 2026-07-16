// Read-only diagnostic - prints every WatchActivity row currently bucketed
// as "today" (in the account's configured timezone), so we can see exactly
// what's contributing to an unexpectedly large Watch Time Today total
// instead of guessing. Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-watch-time-today.js

const { PrismaClient } = require('@prisma/client')
const { getAccountDateString, resolveAccountTimezone } = require('../server/utils/dateUtils')

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const accounts = await prisma.appAccount.findMany({ select: { id: true } })

    for (const account of accounts) {
      const timeZone = await resolveAccountTimezone(prisma, account.id)
      const todayStr = getAccountDateString(new Date(), timeZone)
      const todayDate = new Date(todayStr)

      const rows = await prisma.watchActivity.findMany({
        where: { accountId: account.id, date: todayDate },
        orderBy: { createdAt: 'asc' },
      })

      const total = rows.reduce((sum, r) => sum + r.watchTimeSeconds, 0)

      console.log(`\n=== Account ${account.id} | timezone ${timeZone} | today = ${todayStr} ===`)
      console.log(`${rows.length} WatchActivity rows, total ${fmtDuration(total)}`)
      for (const row of rows) {
        console.log(
          `  [${row.id}] userId=${row.userId} itemId=${row.itemId} itemType=${row.itemType} ` +
          `watchTimeSeconds=${row.watchTimeSeconds} (${fmtDuration(row.watchTimeSeconds)}) ` +
          `createdAt=${row.createdAt.toISOString()} storedDate=${row.date.toISOString()}`
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
