// One-time repair for WatchActivity rows written before the ACCOUNT_TIMEZONE
// fix (server/utils/dateUtils.js): the `date` bucket used to be derived from
// the server's UTC "today" at write time instead of the account's actual
// local calendar day. A row watched late in the local evening could get
// permanently stamped with the wrong day - most visibly, showing up in
// "Watch Time Today" on a day nothing was actually watched, forever, since
// nothing ever revisits an already-written row's date.
//
// This recomputes `date` from each row's `createdAt` (the real moment it
// was recorded, an immutable DB timestamp unaffected by the old bug) using
// the account's configured timezone, and only touches rows where the two
// disagree. WatchActivity has no unique constraint on (accountId, userId,
// itemId, date) - it's an append-only delta log - so re-bucketing rows onto
// a day that already has other rows is safe; they just sum together same
// as any other same-day deltas already do.
//
// Safe to run more than once. Run from the container:
//   docker exec -it slicksync node scripts/fix-stale-watch-activity-dates.js

const { PrismaClient } = require('@prisma/client')
const { getAccountDateString, resolveAccountTimezone } = require('../server/utils/dateUtils')

async function main() {
  const prisma = new PrismaClient()
  try {
    const accounts = await prisma.appAccount.findMany({ select: { id: true } })
    let totalChecked = 0
    let totalFixed = 0

    for (const account of accounts) {
      const timeZone = await resolveAccountTimezone(prisma, account.id)
      const rows = await prisma.watchActivity.findMany({ where: { accountId: account.id } })

      for (const row of rows) {
        totalChecked++
        const correctDateStr = getAccountDateString(row.createdAt, timeZone)
        const storedDateStr = row.date.toISOString().split('T')[0]
        if (correctDateStr !== storedDateStr) {
          await prisma.watchActivity.update({
            where: { id: row.id },
            data: { date: new Date(correctDateStr) },
          })
          totalFixed++
          console.log(`Fixed WatchActivity ${row.id}: ${storedDateStr} -> ${correctDateStr} (account ${account.id}, timezone ${timeZone})`)
        }
      }
    }

    console.log(`Done. Checked ${totalChecked} rows, fixed ${totalFixed}.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
