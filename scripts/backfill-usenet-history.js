// One-time backfill: creates History (WatchSession) entries for usenet
// streams SlickSync already captured as ProxyStreamSession rows but never
// wrote history for - because those connections closed before the usenet
// history writer existed. Native tracking never records usenet, so without
// this those past usenet watches are missing from History entirely.
//
// Only touches closed (isActive=false) usenet rows that don't already have a
// linked WatchSession. Presence markers only: durationSeconds 0. Safe to run
// more than once (rows already backfilled are skipped). Dry-run by default;
// pass --apply to write.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/backfill-usenet-history.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/backfill-usenet-history.js --apply

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
    const accounts = await prisma.appAccount.findMany({ select: { id: true } })
    let totalCreated = 0

    for (const account of accounts) {
      const rows = await prisma.proxyStreamSession.findMany({
        where: { accountId: account.id, isActive: false },
      })
      const usenetRows = rows.filter((r) => isUsenetUrl(r.url))
      if (usenetRows.length === 0) continue

      const users = await prisma.user.findMany({
        where: { accountId: account.id },
        select: { id: true, username: true, email: true },
      })

      // Group by user + normalized title so repeat watches / seeks collapse
      // to one history entry per title (keyed like the live writer).
      for (const row of usenetRows) {
        const user = resolveUser(users, row.aiostreamsUser)
        if (!user) continue
        const title = row.displayName || row.filename || 'Unknown'
        const itemId = row.metadataItemId || `proxy:${normalize(title).replace(/\s+/g, '-')}`
        const itemType = row.metadataItemType === 'series' ? 'series' : 'movie'

        const existing = await prisma.watchSession.findUnique({
          where: { accountId_userId_itemId: { accountId: account.id, userId: user.id, itemId } },
        })
        if (existing) continue // already have a history row for this title

        console.log(`${apply ? 'Creating' : 'Would create'} history: "${title}"  user=${user.username}  watched=${row.startTime.toISOString()}`)
        if (apply) {
          await prisma.watchSession.create({
            data: {
              accountId: account.id,
              userId: user.id,
              itemId,
              itemName: title,
              itemType,
              poster: row.posterUrl || null,
              startTime: row.startTime,
              endTime: row.endTime || row.lastSeenAt,
              durationSeconds: 0,
              requestCount: row.requestCount || 1,
              isActive: false,
            },
          })
          totalCreated++
        }
      }
    }

    if (apply) {
      console.log(`\nDone. Created ${totalCreated} history entr(y/ies).`)
    } else {
      console.log('\nDry run only - re-run with --apply to create these history entries.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
