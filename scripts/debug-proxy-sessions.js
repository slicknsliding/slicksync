// Read-only diagnostic - lists the ProxyStreamSession rows SlickSync's poller
// has captured from AIOStreams' proxy `active` list, with each connection's
// URL (so you can see which backend served it). Unlike a single live snapshot
// of /proxy/stats, this is the persisted record of everything SlickSync ever
// saw active, so it doesn't require catching a stream at the right second.
//
// Useful for answering "did the proxy ever see this stream?" - e.g. usenet via
// newznab bypasses the proxy entirely and will NOT appear here (native tracks
// it instead), whereas debrid/torrent streams do appear.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-proxy-sessions.js

const { PrismaClient } = require('@prisma/client')

// Host + leading path only - the full URL can carry credentials and long
// encrypted blobs.
function shortUrl(url) {
  if (!url) return '(none)'
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname.split('/').slice(0, 4).join('/')}`
  } catch {
    return String(url).slice(0, 100)
  }
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.proxyStreamSession.findMany({
      orderBy: { startTime: 'desc' },
      take: 60,
    })

    console.log(`${rows.length} most-recent ProxyStreamSession rows (what SlickSync captured from AIOStreams' active list):\n`)

    for (const r of rows) {
      console.log(
        `active=${String(r.isActive).padEnd(5)}  "${r.displayName || r.filename || '?'}"` +
        `  start=${r.startTime.toISOString()}  end=${r.endTime ? r.endTime.toISOString() : '(open)'}`
      )
      console.log(`   url: ${shortUrl(r.url)}`)
    }

    const active = rows.filter((r) => r.isActive).length
    console.log(`\nSummary: ${rows.length} row(s) shown, ${active} currently active.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
