// Read-only diagnostic - lists the ProxyStreamSession rows SlickSync's poller
// has actually captured from AIOStreams' proxy `active` list. Unlike a single
// live snapshot of /proxy/stats, this is the persisted record of everything
// SlickSync ever saw active, so it definitively answers: has the poller ever
// caught a USENET stream live? (If usenet rows exist, usenet does reach the
// `active` list and Now Playing/History should work for it; if only debrid/
// torrent rows exist, usenet never hits `active` and needs a different signal.)
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-proxy-sessions.js

const { PrismaClient } = require('@prisma/client')
const { isUsenetUrl } = require('../server/utils/proxyStreamMonitor')

async function main() {
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.proxyStreamSession.findMany({
      orderBy: { startTime: 'desc' },
      take: 60,
    })

    console.log(`${rows.length} most-recent ProxyStreamSession rows (what SlickSync captured from AIOStreams' active list):\n`)

    let usenet = 0
    let other = 0
    for (const r of rows) {
      const kind = isUsenetUrl(r.url) ? 'USENET' : 'debrid/other'
      if (isUsenetUrl(r.url)) usenet++; else other++
      console.log(
        `[${kind.padEnd(12)}] active=${r.isActive}  "${r.displayName || r.filename || '?'}"` +
        `  start=${r.startTime.toISOString()}  end=${r.endTime ? r.endTime.toISOString() : '(open)'}`
      )
      // The URL is what the usenet-vs-debrid classification keys off, so print
      // it (host + leading path only - the full URL can carry credentials and
      // long encrypted blobs). This is how we identify a new usenet backend's
      // pattern when the setup changes (e.g. nzbdav -> newznab).
      let shown = r.url || ''
      try {
        const u = new URL(r.url)
        shown = `${u.protocol}//${u.host}${u.pathname.split('/').slice(0, 4).join('/')}`
      } catch {
        shown = shown.slice(0, 100)
      }
      console.log(`                 url: ${shown}`)
    }

    console.log(`\nSummary: ${usenet} usenet row(s), ${other} debrid/other row(s), ${rows.length} total shown.`)
    if (usenet === 0) {
      console.log('\nNo usenet ProxyStreamSession rows exist - SlickSync has never caught a usenet')
      console.log('stream in AIOStreams\' `active` list. That means usenet does not surface as an')
      console.log('active proxy connection, so neither Now Playing nor the proxy history writer')
      console.log('can see it. We would need a different signal for usenet live/history.')
    } else {
      console.log('\nUsenet rows exist - SlickSync DOES catch usenet as an active proxy connection,')
      console.log('so Now Playing (live) and the new usenet History writer should both work for it.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
