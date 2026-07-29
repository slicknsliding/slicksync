// Account merge: absorb a second provider's account (Stremio<->Nuvio, same
// real person) into an existing User row, rather than leaving them as two
// permanently separate entries. See prisma/schema.sqlite.prisma's
// UserProviderCredential model comment and the plan this was built from for
// the full "why a side table, not a bigger User row" reasoning.
//
// All exports take a Prisma client (or transaction client) as their first
// arg so mergeUsers can run its write path inside a single $transaction.

const fs = require('fs')
const path = require('path')

/**
 * Does `userId` have an unmerged same-email, different-providerType sibling
 * it could absorb? Email match is a suggestion signal only, never automatic -
 * a shared household inbox belonging to two different real people is common
 * enough that blind email-matching would wrongly suggest merging them.
 * Mirrors watchDedup.js's own case-insensitive-in-JS email comparison, since
 * SQLite's default TEXT collation is case-sensitive and Prisma's
 * `mode: 'insensitive'` filter is Postgres-only.
 *
 * @returns {Promise<{id, username, providerType, avatarUrl, colorIndex, email} | null>}
 */
async function getMergeCandidate(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, providerType: true, accountId: true },
  })
  if (!user || !user.email) return null

  // Already absorbed a secondary provider - nothing left to suggest for it.
  const alreadyHasSecondary = await prisma.userProviderCredential.findFirst({ where: { userId: user.id } })
  if (alreadyHasSecondary) return null

  const email = user.email.trim().toLowerCase()
  const others = await prisma.user.findMany({
    where: { accountId: user.accountId, id: { not: user.id }, providerType: { not: user.providerType } },
    select: { id: true, username: true, providerType: true, avatarUrl: true, colorIndex: true, email: true },
  })
  const candidate = others.find((o) => (o.email || '').trim().toLowerCase() === email)
  if (!candidate) return null

  // The candidate itself must be a clean standalone donor - not already
  // someone else's absorbed secondary.
  const candidateHasSecondary = await prisma.userProviderCredential.findFirst({ where: { userId: candidate.id } })
  if (candidateHasSecondary) return null

  return candidate
}

/**
 * Counts + warnings for the merge confirmation modal, before anything is
 * actually touched.
 */
async function getMergePreview(prisma, survivorId, donorId) {
  const [survivor, donor] = await Promise.all([
    prisma.user.findUnique({ where: { id: survivorId }, select: { id: true, username: true, providerType: true, accountId: true } }),
    prisma.user.findUnique({ where: { id: donorId }, select: { id: true, username: true, providerType: true, accountId: true } }),
  ])
  if (!survivor) throw new Error('Survivor user not found')
  if (!donor) throw new Error('Donor user not found')
  if (survivor.providerType === donor.providerType) {
    throw new Error('Both accounts use the same provider - merge is for pairing two different providers')
  }

  const [movieCount, episodeCount, sessionCount, snapshotCount, survivorGroup, donorGroup] = await Promise.all([
    prisma.movieWatchHistory.count({ where: { userId: donorId } }),
    prisma.episodeWatchHistory.count({ where: { userId: donorId } }),
    prisma.watchSession.count({ where: { userId: donorId } }),
    prisma.watchSnapshot.count({ where: { userId: donorId } }),
    prisma.group.findFirst({ where: { accountId: survivor.accountId, userIds: { contains: survivorId } }, select: { id: true, name: true } }),
    prisma.group.findFirst({ where: { accountId: survivor.accountId, userIds: { contains: donorId } }, select: { id: true, name: true } }),
  ])

  return {
    survivor: { id: survivor.id, username: survivor.username, providerType: survivor.providerType },
    donor: { id: donor.id, username: donor.username, providerType: donor.providerType },
    movieCount,
    episodeCount,
    sessionCount,
    snapshotCount,
    survivorGroupName: survivorGroup?.name || null,
    donorGroupName: donorGroup?.name || null,
    // The merge deliberately does NOT auto-add the survivor to the donor's
    // group - that would silently change which addons the absorbed provider
    // receives. Surfaced here so the admin can decide via normal group
    // management afterward instead.
    groupsDiffer: !!(donorGroup && (!survivorGroup || donorGroup.id !== survivorGroup.id)),
  }
}

// One consistent tie-break across every collision-prone table: keep
// whichever row is more recent. WatchSession additionally prefers an
// isActive row over a finished one (a live session is a stronger signal
// than an old completed one, regardless of which started more recently).
function pickSurvivorRow(existing, incoming, recencyField, { preferActive = false } = {}) {
  if (preferActive && existing.isActive !== incoming.isActive) {
    return existing.isActive ? existing : incoming
  }
  const existingTime = new Date(existing[recencyField]).getTime()
  const incomingTime = new Date(incoming[recencyField]).getTime()
  return incomingTime >= existingTime ? incoming : existing
}

// Re-points every donor row in a table to the survivor's userId, resolving
// a per-row collision (both accounts already have a row for the same
// unique key) via pickSurvivorRow instead of letting the unique constraint
// throw. `findUniqueKey` returns the args object identifying an existing
// survivor row with the same natural key as a given donor row.
async function migrateTable(tx, modelName, survivorId, donorId, recencyField, findUniqueKey, { preferActive = false } = {}) {
  const donorRows = await tx[modelName].findMany({ where: { userId: donorId } })
  for (const row of donorRows) {
    const existing = await tx[modelName].findFirst({ where: findUniqueKey(row) })
    if (!existing) {
      await tx[modelName].update({ where: { id: row.id }, data: { userId: survivorId } })
      continue
    }
    const winner = pickSurvivorRow(existing, row, recencyField, { preferActive })
    if (winner.id === row.id) {
      // The donor's row wins - delete the survivor's existing one, then move the donor's row over.
      await tx[modelName].delete({ where: { id: existing.id } })
      await tx[modelName].update({ where: { id: row.id }, data: { userId: survivorId } })
    } else {
      // The survivor's existing row wins - just drop the donor's duplicate.
      await tx[modelName].delete({ where: { id: row.id } })
    }
  }
}

/**
 * Runs the actual merge in one transaction. Returns a summary for logging/
 * the API response. Throws (aborting the transaction) on any validation
 * failure - nothing partial is left behind either way.
 */
async function mergeUsers(prisma, survivorId, donorId, { dataDir = path.join(process.cwd(), 'data') } = {}) {
  const preview = await getMergePreview(prisma, survivorId, donorId)

  const donorFull = await prisma.user.findUnique({ where: { id: donorId } })
  if (!donorFull) throw new Error('Donor user not found')

  const existingSecondary = await prisma.userProviderCredential.findUnique({
    where: { userId_providerType: { userId: survivorId, providerType: donorFull.providerType } },
  })
  if (existingSecondary) throw new Error(`Survivor already has a ${donorFull.providerType} account absorbed`)

  // Archive the donor's full pre-merge state before anything is touched -
  // the recovery path given this SQLite deploy has no real migration/
  // rollback tooling. Same convention as Vault's own backup export
  // (data/backup/vault/) - a plain JSON snapshot on disk, not a DB table,
  // so a bad merge can still be manually inspected/reversed after the fact.
  const archiveDir = path.join(dataDir, 'backup', 'merges')
  fs.mkdirSync(archiveDir, { recursive: true })
  const archivePath = path.join(archiveDir, `${donorId}-${Date.now()}.json`)
  fs.writeFileSync(archivePath, JSON.stringify({ mergedAt: new Date().toISOString(), survivorId, donor: donorFull }, null, 2))

  await prisma.$transaction(async (tx) => {
    // 1. Absorb the donor's credentials as a secondary provider on the survivor.
    await tx.userProviderCredential.create({
      data: {
        userId: survivorId,
        providerType: donorFull.providerType,
        stremioAuthKey: donorFull.stremioAuthKey,
        nuvioRefreshToken: donorFull.nuvioRefreshToken,
        nuvioUserId: donorFull.nuvioUserId,
      },
    })

    // 2. WatchActivity has no unique constraint - straight re-point, no collisions possible.
    await tx.watchActivity.updateMany({ where: { userId: donorId }, data: { userId: survivorId } })

    // 3. Collision-prone tables - one consistent "most recent wins" tie-break.
    await migrateTable(tx, 'movieWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId,
    }))
    await migrateTable(tx, 'episodeWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({
      userId: survivorId, accountId: row.accountId, videoId: row.videoId,
    }))
    await migrateTable(tx, 'watchSnapshot', survivorId, donorId, 'date', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId, date: row.date,
    }))
    await migrateTable(tx, 'watchSession', survivorId, donorId, 'startTime', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId,
    }), { preferActive: true })

    // 4. DismissedContinueWatching - union semantics, not pick-one: the fact
    // "this show is dismissed" survives either way, so on collision just
    // drop the donor's duplicate rather than picking a "winner".
    const dismissedRows = await tx.dismissedContinueWatching.findMany({ where: { userId: donorId } })
    for (const row of dismissedRows) {
      const existing = await tx.dismissedContinueWatching.findFirst({
        where: { userId: survivorId, accountId: row.accountId, showId: row.showId },
      })
      if (existing) {
        await tx.dismissedContinueWatching.delete({ where: { id: row.id } })
      } else {
        await tx.dismissedContinueWatching.update({ where: { id: row.id }, data: { userId: survivorId } })
      }
    }

    // 5. Remove the donor from whatever group it belonged to - deliberately
    // NOT adding the survivor to that group too, see getMergePreview's
    // groupsDiffer comment.
    const donorGroups = await tx.group.findMany({ where: { accountId: donorFull.accountId, userIds: { contains: donorId } } })
    for (const group of donorGroups) {
      let ids = []
      try { ids = JSON.parse(group.userIds || '[]') } catch { ids = [] }
      const nextIds = ids.filter((id) => id !== donorId)
      if (nextIds.length !== ids.length) {
        await tx.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(nextIds) } })
      }
    }

    // 6. The donor row itself is retired - its state already lives in the
    // archive file written above.
    await tx.user.delete({ where: { id: donorId } })
  })

  return { ...preview, archivePath }
}

module.exports = { getMergeCandidate, getMergePreview, mergeUsers }
