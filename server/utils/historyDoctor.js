// Finds and repairs watch-history records that are provably wrong.
//
// This exists because it was needed for real: a cache-key collision wrote 7
// episodes from one provider's library onto a different provider's user
// (see libraryCache.js's own comment for the root cause, now fixed). Those
// rows were found and removed with a one-off script - which is exactly the
// kind of thing that should be a feature rather than something only the
// person holding a database shell can do.
//
// Design rules, because this touches irreplaceable data:
//   - Scanning NEVER writes. Repair is a separate, explicit call.
//   - Only findings that are provable from the data are reported. Nothing
//     here guesses at what someone "probably" meant to watch.
//   - Repair only ever deletes rows that are demonstrably redundant - a
//     duplicate whose original still exists, or a row referencing a user
//     that no longer exists. It never edits a row's values, and it never
//     removes anything that would lose watch history outright.

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Cross-provider duplicates: the same episode, at the exact same watchedAt,
 * present under two different users of DIFFERENT provider types, where one
 * copy was created measurably later. The later one is the copy.
 *
 * watchedAt equality is what makes this safe: two people genuinely watching
 * the same episode do not land on the identical millisecond. A match at that
 * precision means one row was written from the other's data.
 */
async function findCrossProviderDuplicates(prisma, accountId) {
  const users = await prisma.user.findMany({
    where: { accountId },
    select: { id: true, username: true, providerType: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))
  const findings = []

  for (const u of users) {
    // A profileLabel is written by the provider sync, so a labelled row under
    // a user whose provider doesn't use labels is the shape this bug made.
    const labelled = await prisma.episodeWatchHistory.findMany({
      where: { accountId, userId: u.id, profileLabel: { not: null } },
      select: {
        id: true, showId: true, showName: true, season: true, episode: true,
        profileLabel: true, watchedAt: true, createdAt: true,
      },
    })

    for (const row of labelled) {
      const origin = await prisma.episodeWatchHistory.findFirst({
        where: {
          accountId,
          showId: row.showId,
          season: row.season,
          episode: row.episode,
          watchedAt: row.watchedAt,
          userId: { not: u.id },
          createdAt: { lt: row.createdAt },
        },
        select: { id: true, userId: true, createdAt: true },
      })
      if (!origin) continue
      const originUser = userMap.get(origin.userId)
      // Same provider type means this is not the cross-provider bug - could
      // be two genuine accounts on one service, so leave it alone.
      if (!originUser || originUser.providerType === u.providerType) continue

      findings.push({
        id: row.id,
        kind: 'cross_provider_duplicate',
        summary: `${row.showName} S${row.season}E${row.episode} copied onto ${u.username} (${u.providerType})`,
        detail: `Identical to a row under ${originUser.username} (${originUser.providerType}) with the same watch time, created ${Math.max(1, Math.round((new Date(row.createdAt) - new Date(origin.createdAt)) / DAY_MS))} day(s) earlier.`,
      })
    }
  }
  return findings
}

/** Rows pointing at a user that no longer exists - invisible everywhere in
 * the UI, but still counted in totals. */
async function findOrphanedRows(prisma, accountId) {
  const userIds = new Set((await prisma.user.findMany({
    where: { accountId }, select: { id: true },
  })).map((u) => u.id))

  const findings = []
  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.findMany({ where: { accountId }, select: { id: true, userId: true, showName: true, season: true, episode: true } }),
    prisma.movieWatchHistory.findMany({ where: { accountId }, select: { id: true, userId: true, itemName: true } }),
  ])

  for (const r of episodes) {
    if (userIds.has(r.userId)) continue
    findings.push({
      id: r.id,
      kind: 'orphaned_episode',
      summary: `${r.showName} S${r.season}E${r.episode}`,
      detail: 'Belongs to a user that no longer exists, so it is counted in totals but shown nowhere.',
    })
  }
  for (const r of movies) {
    if (userIds.has(r.userId)) continue
    findings.push({
      id: r.id,
      kind: 'orphaned_movie',
      summary: r.itemName,
      detail: 'Belongs to a user that no longer exists, so it is counted in totals but shown nowhere.',
    })
  }
  return findings
}

/** Read-only. Returns everything found, grouped by kind. */
async function scanHistory(prisma, accountId) {
  const accountIdValue = accountId || 'default'
  const [duplicates, orphans] = await Promise.all([
    findCrossProviderDuplicates(prisma, accountIdValue),
    findOrphanedRows(prisma, accountIdValue),
  ])
  const findings = [...duplicates, ...orphans]
  return {
    findings,
    counts: {
      cross_provider_duplicate: duplicates.length,
      orphaned: orphans.length,
      total: findings.length,
    },
    scannedAt: new Date().toISOString(),
  }
}

/**
 * Deletes the rows a fresh scan identifies. Deliberately re-scans rather than
 * trusting ids posted by the client: a stale page could otherwise ask this to
 * delete rows that are no longer problems, and nothing about a row id proves
 * it was ever a finding.
 */
async function repairHistory(prisma, accountId, kinds) {
  const accountIdValue = accountId || 'default'
  const allowed = new Set(Array.isArray(kinds) && kinds.length ? kinds : ['cross_provider_duplicate', 'orphaned_episode', 'orphaned_movie'])
  const { findings } = await scanHistory(prisma, accountIdValue)
  const target = findings.filter((f) => allowed.has(f.kind))

  const episodeIds = target.filter((f) => f.kind === 'cross_provider_duplicate' || f.kind === 'orphaned_episode').map((f) => f.id)
  const movieIds = target.filter((f) => f.kind === 'orphaned_movie').map((f) => f.id)

  let removed = 0
  if (episodeIds.length) {
    removed += (await prisma.episodeWatchHistory.deleteMany({ where: { accountId: accountIdValue, id: { in: episodeIds } } })).count
  }
  if (movieIds.length) {
    removed += (await prisma.movieWatchHistory.deleteMany({ where: { accountId: accountIdValue, id: { in: movieIds } } })).count
  }
  return { removed, examined: findings.length }
}

module.exports = { scanHistory, repairHistory }
