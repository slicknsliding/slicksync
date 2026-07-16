// One-time reconcile of proxy-written History (WatchSession) entries.
//
// Background: the proxy pipeline used to write History for ALL streams, which
// duplicated debrid watches (native records those with a real title/poster/
// duration). It now writes History for USENET only - the one source native
// never records. But the old debrid proxy cards are still in the DB, and now
// show as duplicates.
//
// This script:
//   1. Deletes every proxy-written History card (WatchSession with a non-null
//      requestCount - only the proxy sets that; native never does). That
//      clears the old debrid duplicates AND any stale usenet cards.
//   2. Recreates usenet History cards from the closed usenet ProxyStreamSession
//      rows SlickSync captured (presence markers, durationSeconds 0), so past
//      usenet watches - which native never recorded - aren't lost.
//
// Net result: debrid history = native only (no duplicate); usenet history =
// proxy only (restored). Safe to run more than once. Dry-run by default;
// pass --apply to make changes.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-proxy-history.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/reconcile-proxy-history.js --apply

const { PrismaClient } = require('@prisma/client')
const { isUsenetUrl } = require('../server/utils/proxyStreamMonitor')

function normalize(name) {
  return (name || '').toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function resolveUser(users, aiostreamsUser) {
  const lower = (aiostreamsUser || '').toLowerCase()
  const direct = users.find((u) => u.username && u.username.toLowerCase() === lower)
  if (direct) return direct
  const emailMatches = users.filter((u) => u.email && u.email.split('@')[0].toLowerCase() === lower)
  if (emailMatches.length === 1) return emailMatches[0]
  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const candidates = emailMatches.length > 0 ? emailMatches : fallbackUserIds.map((id) => users.find((u) => u.id === id)).filter(Boolean)
  if (candidates.length === 0) return null
  if (candidates.length > 1 && fallbackUserIds.length > 0) {
    const ranked = candidates.map((u) => ({ u, r: fallbackUserIds.indexOf(u.id) })).filter((c) => c.r !== -1).sort((a, b) => a.r - b.r)
    if (ranked.length) return ranked[0].u
  }
  return candidates[0]
}

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    // 1) Delete all proxy-written WatchSessions (requestCount is set only by
    //    the proxy; native never sets it).
    const proxyCards = await prisma.watchSession.findMany({
      where: { requestCount: { not: null } },
      select: { id: true, itemName: true, durationSeconds: true, requestCount: true },
    })
    console.log(`[1] Proxy-written History cards to remove: ${proxyCards.length}`)
    for (const c of proxyCards) {
      console.log(`    "${c.itemName}"  (${c.requestCount} reqs, ${c.durationSeconds}s)`)
    }
    if (apply && proxyCards.length > 0) {
      const r = await prisma.watchSession.deleteMany({ where: { id: { in: proxyCards.map((c) => c.id) } } })
      console.log(`    Deleted ${r.count}.`)
    }

    // 2) Recreate usenet History from captured closed usenet ProxyStreamSessions.
    const accounts = await prisma.appAccount.findMany({ select: { id: true } })
    let created = 0
    console.log(`\n[2] Recreating usenet History from captured proxy sessions:`)
    for (const account of accounts) {
      const rows = await prisma.proxyStreamSession.findMany({ where: { accountId: account.id, isActive: false } })
      const usenetRows = rows.filter((r) => isUsenetUrl(r.url))
      if (usenetRows.length === 0) continue
      const users = await prisma.user.findMany({ where: { accountId: account.id }, select: { id: true, username: true, email: true } })

      // One entry per user+title (collapse repeat watches / seeks); keep the
      // most-recent occurrence.
      const byKey = new Map()
      for (const row of usenetRows) {
        const user = resolveUser(users, row.aiostreamsUser)
        if (!user) continue
        const title = row.displayName || row.filename || 'Unknown'
        const itemId = row.metadataItemId || `proxy:${normalize(title).replace(/\s+/g, '-')}`
        const key = `${user.id}::${itemId}`
        const prev = byKey.get(key)
        if (!prev || row.startTime > prev.row.startTime) byKey.set(key, { row, user, title, itemId })
      }

      for (const { row, user, title, itemId } of byKey.values()) {
        const itemType = row.metadataItemType === 'series' ? 'series' : 'movie'
        console.log(`    "${title}"  user=${user.username}  watched=${row.startTime.toISOString()}`)
        if (apply) {
          await prisma.watchSession.upsert({
            where: { accountId_userId_itemId: { accountId: account.id, userId: user.id, itemId } },
            create: {
              accountId: account.id, userId: user.id, itemId, itemName: title, itemType,
              poster: row.posterUrl || null, startTime: row.startTime, endTime: row.endTime || row.lastSeenAt,
              durationSeconds: 0, requestCount: row.requestCount || 1, isActive: false,
            },
            update: {
              itemName: title, itemType, poster: row.posterUrl || undefined,
              endTime: row.endTime || row.lastSeenAt, requestCount: row.requestCount || 1, isActive: false,
            },
          })
          created++
        }
      }
    }

    if (apply) {
      console.log(`\nDone. Removed ${proxyCards.length} proxy card(s), recreated ${created} usenet card(s).`)
    } else {
      console.log('\nDry run only - re-run with --apply to make these changes.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
