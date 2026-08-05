// Read-only diagnostic - proves whether the shared-email dedup fix
// (server/utils/watchDedup.js's dedupWatchActivityBySharedEmail, wired into
// metricsBuilder.js's episodeHistory/movieHistory) actually collapses a
// real phantom-duplicate row, independent of what's currently deployed:
// this script requires the CURRENT checkout's own watchDedup.js and runs it
// directly against the account's real History rows, so it verifies the fix
// itself rather than whatever code happens to be running in a container.
//
// Scans every episode/movie History row for the account, finds every
// (item, day) group where 2+ users from a shared-email pair both have a
// row, and prints exactly which row the fix would KEEP vs DROP - the real
// question being answered ("is Nuvio SLICK's row kept and Slick Stremio's
// dropped, or the reverse?").
//
// Makes no changes.
//
// Usage: docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/debug-shared-email-phantom-watchers.js [days]
//   days - how many days back to scan (default 30)

const { PrismaClient } = require('@prisma/client')
const { findSharedEmailUserIds, dedupWatchActivityBySharedEmail } = require('../server/utils/watchDedup')

async function main() {
  const days = parseInt(process.argv[2] || '30', 10)
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const prisma = new PrismaClient()
  try {
    const users = await prisma.user.findMany({ select: { id: true, email: true, username: true } })
    const sharedEmailUserIds = findSharedEmailUserIds(users)
    const userMap = new Map(users.map((u) => [u.id, u]))

    if (sharedEmailUserIds.size === 0) {
      console.log('No shared-email user pairs found on this account - nothing for this fix to affect.')
      return
    }
    console.log(`Shared-email users: ${[...sharedEmailUserIds].map((id) => userMap.get(id)?.username || id).join(', ')}\n`)

    const [episodesRaw, moviesRaw] = await Promise.all([
      prisma.episodeWatchHistory.findMany({ where: { watchedAt: { gte: startDate } } }),
      prisma.movieWatchHistory.findMany({ where: { watchedAt: { gte: startDate } } }),
    ])

    const episodesKept = dedupWatchActivityBySharedEmail(episodesRaw, sharedEmailUserIds, {
      itemKey: (r) => `${r.showId}::${r.videoId || ''}`,
      dateField: 'watchedAt',
      durationField: 'durationSeconds',
    })
    const moviesKept = dedupWatchActivityBySharedEmail(moviesRaw, sharedEmailUserIds, {
      itemKey: (r) => r.itemId,
      dateField: 'watchedAt',
      durationField: 'durationSeconds',
    })

    const keptIds = new Set([...episodesKept, ...moviesKept].map((r) => r.id))
    const dropped = [...episodesRaw, ...moviesRaw].filter((r) => !keptIds.has(r.id) && sharedEmailUserIds.has(r.userId))

    if (dropped.length === 0) {
      console.log(`No phantom duplicates found in the last ${days} day(s).`)
      return
    }

    console.log(`${dropped.length} phantom row(s) the fix drops:\n`)
    for (const row of dropped) {
      const name = row.showName || row.itemName || row.itemId
      const label = row.season != null ? `${name} S${row.season}E${row.episode}` : name
      const user = userMap.get(row.userId)
      console.log(`DROPPED  ${label}`)
      console.log(`  user=${user?.username || row.userId} (${user?.email || 'no email'})  watchedAt=${row.watchedAt.toISOString()}  duration=${row.durationSeconds ?? 'null'}s`)

      // Show who the fix kept for the same (item, day) instead, for
      // direct comparison.
      const dayKeyOf = (r, isEpisode) => {
        const id = isEpisode ? `${r.showId}::${r.videoId || ''}` : r.itemId
        const d = new Date(r.watchedAt)
        return `${id}::${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
      }
      const isEpisode = row.showId !== undefined
      const key = dayKeyOf(row, isEpisode)
      const keptPool = isEpisode ? episodesKept : moviesKept
      const winner = keptPool.find((r) => dayKeyOf(r, isEpisode) === key && sharedEmailUserIds.has(r.userId))
      if (winner) {
        const wUser = userMap.get(winner.userId)
        console.log(`  KEPT instead: user=${wUser?.username || winner.userId} (${wUser?.email || 'no email'})  watchedAt=${winner.watchedAt.toISOString()}  duration=${winner.durationSeconds ?? 'null'}s`)
      }
      console.log('')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
