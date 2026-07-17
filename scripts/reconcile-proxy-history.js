// One-time cleanup: removes proxy-written History (WatchSession) entries.
//
// Background: earlier builds had the proxy pipeline write History cards.
// History is now owned entirely by the native provider pipeline, which
// records every source this deployment uses - including usenet (a newznab
// usenet watch lands in History via native, with the real library title,
// poster and duration). The proxy writes no history at all now; it's a live
// presence signal only (Now Playing + the "started watching" notification).
//
// The old proxy cards are still in the DB though, and show as blank
// duplicates alongside the real native cards ("Simpsley (2026)" next to
// "Simpsley", "Send Help (2026) VU Blu-ray" next to "Send Help", etc.).
// This deletes them.
//
// Identified by requestCount being set - only the proxy ever set that;
// native leaves it null. Native cards are therefore never touched.
//
// Safe to run more than once. Dry-run by default; pass --apply to delete.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-proxy-history.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-proxy-history.js --apply

const { PrismaClient } = require('@prisma/client')

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    const proxyCards = await prisma.watchSession.findMany({
      where: { requestCount: { not: null } },
      select: { id: true, itemName: true, durationSeconds: true, requestCount: true, startTime: true },
      orderBy: { startTime: 'desc' },
    })

    console.log(`Proxy-written History cards found: ${proxyCards.length}\n`)
    for (const c of proxyCards) {
      console.log(`  "${c.itemName}"  (${c.requestCount} reqs, ${c.durationSeconds}s)  ${c.startTime.toISOString()}`)
    }

    if (proxyCards.length === 0) {
      console.log('Nothing to do.')
      return
    }

    if (apply) {
      const r = await prisma.watchSession.deleteMany({ where: { id: { in: proxyCards.map((c) => c.id) } } })
      console.log(`\nDeleted ${r.count} proxy-written card(s). Native history is untouched.`)
    } else {
      console.log('\nDry run only - re-run with --apply to delete these.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
