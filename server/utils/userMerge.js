// Account merge: absorb a second provider's account (Stremio<->Nuvio, same
// real person) into an existing User row, rather than leaving them as two
// permanently separate entries. See prisma/schema.sqlite.prisma's
// UserProviderCredential model comment and the plan this was built from for
// the full "why a side table, not a bigger User row" reasoning.
//
// All exports take a Prisma client (or transaction client) as their first
// arg so mergeUsers/undoMerge can run their write path inside a single
// $transaction.
//
// Undo is a best-effort structural reversal, not a time machine: it splits
// the two accounts back apart and restores each side's original rows, but
// any NEW watching recorded on the merged account between the merge and the
// undo rides along with whichever row it landed on - there is no way to
// tell "this delta happened before/after the merge" after the fact.

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

/**
 * Is there anything to undo for this survivor, and can it actually be
 * reversed (vs. a pre-undo-support merge with no archive on file)?
 */
async function getUndoInfo(prisma, survivorId, { dataDir = path.join(process.cwd(), 'data') } = {}) {
  const credential = await prisma.userProviderCredential.findFirst({ where: { userId: survivorId } })
  if (!credential) return null
  // The donor's User row is gone by the time this is called (that's the
  // whole point of the merge) - its username only still exists in the
  // archive file, never in a live `user` query.
  const archiveFullPath = credential.mergeArchivePath
    ? path.join(dataDir, 'backup', 'merges', credential.mergeArchivePath)
    : null
  let donorUsername = null
  if (archiveFullPath && fs.existsSync(archiveFullPath)) {
    try {
      donorUsername = JSON.parse(fs.readFileSync(archiveFullPath, 'utf8')).donor?.username || null
    } catch { /* leave null - undoable still reflects the file existing */ }
  }
  return {
    providerType: credential.providerType,
    donorUsername,
    undoable: !!(credential.donorId && archiveFullPath && fs.existsSync(archiveFullPath)),
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
// natural key) via pickSurvivorRow instead of letting the unique constraint
// throw. Every donor row (win or lose) is recorded into `archive.donorRows`
// before anything is touched, and any survivor row that loses a collision
// is recorded into `archive.overwrittenSurvivorRows` before it's deleted -
// together these are exactly what undoMerge() needs to put both accounts
// back the way they were.
async function migrateTable(tx, modelName, survivorId, donorId, recencyField, findUniqueKey, { preferActive = false, archive }) {
  const donorRows = await tx[modelName].findMany({ where: { userId: donorId } })
  archive.donorRows[modelName] = donorRows
  for (const row of donorRows) {
    const existing = await tx[modelName].findFirst({ where: findUniqueKey(row) })
    if (!existing) {
      await tx[modelName].update({ where: { id: row.id }, data: { userId: survivorId } })
      continue
    }
    const winner = pickSurvivorRow(existing, row, recencyField, { preferActive })
    if (winner.id === row.id) {
      // The donor's row wins - archive + delete the survivor's existing one, then move the donor's row over.
      archive.overwrittenSurvivorRows[modelName] = archive.overwrittenSurvivorRows[modelName] || []
      archive.overwrittenSurvivorRows[modelName].push(existing)
      await tx[modelName].delete({ where: { id: existing.id } })
      await tx[modelName].update({ where: { id: row.id }, data: { userId: survivorId } })
    } else {
      // The survivor's existing row wins - just drop the donor's duplicate (already archived above).
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

  // Archive filename is decided up front so the UserProviderCredential row
  // can point at it from the moment it's created, inside the same
  // transaction - no second write needed to link them after the fact.
  const archiveDir = path.join(dataDir, 'backup', 'merges')
  fs.mkdirSync(archiveDir, { recursive: true })
  const archiveFilename = `${donorId}-${Date.now()}.json`
  const archivePath = path.join(archiveDir, archiveFilename)

  // Filled in by migrateTable/the dismissed/activity passes below as they
  // run, then written to disk once the transaction has actually committed -
  // this IS the recovery data undoMerge() reads back, not just a debug log.
  const archive = { donorRows: {}, overwrittenSurvivorRows: {}, donorGroupIds: [] }

  await prisma.$transaction(async (tx) => {
    // 1. Absorb the donor's credentials as a secondary provider on the survivor.
    await tx.userProviderCredential.create({
      data: {
        userId: survivorId,
        providerType: donorFull.providerType,
        stremioAuthKey: donorFull.stremioAuthKey,
        nuvioRefreshToken: donorFull.nuvioRefreshToken,
        nuvioUserId: donorFull.nuvioUserId,
        donorId,
        mergeArchivePath: archiveFilename,
      },
    })

    // 2. WatchActivity has no unique constraint - straight re-point, no collisions possible.
    const donorActivityRows = await tx.watchActivity.findMany({ where: { userId: donorId } })
    archive.donorRows.watchActivity = donorActivityRows
    await tx.watchActivity.updateMany({ where: { userId: donorId }, data: { userId: survivorId } })

    // 3. Collision-prone tables - one consistent "most recent wins" tie-break.
    await migrateTable(tx, 'movieWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId,
    }), { archive })
    await migrateTable(tx, 'episodeWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({
      userId: survivorId, accountId: row.accountId, videoId: row.videoId,
    }), { archive })
    await migrateTable(tx, 'watchSnapshot', survivorId, donorId, 'date', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId, date: row.date,
    }), { archive })
    await migrateTable(tx, 'watchSession', survivorId, donorId, 'startTime', (row) => ({
      userId: survivorId, accountId: row.accountId, itemId: row.itemId,
    }), { archive, preferActive: true })

    // 4. DismissedContinueWatching - union semantics, not pick-one: the fact
    // "this show is dismissed" survives either way, so on collision just
    // drop the donor's duplicate rather than picking a "winner". Survivor's
    // own row is never touched/deleted here, so nothing to archive for it.
    const dismissedRows = await tx.dismissedContinueWatching.findMany({ where: { userId: donorId } })
    archive.donorRows.dismissedContinueWatching = dismissedRows
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
    archive.donorGroupIds = donorGroups.map((g) => g.id)
    for (const group of donorGroups) {
      let ids = []
      try { ids = JSON.parse(group.userIds || '[]') } catch { ids = [] }
      const nextIds = ids.filter((id) => id !== donorId)
      if (nextIds.length !== ids.length) {
        await tx.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(nextIds) } })
      }
    }

    // 6. The donor row itself is retired - its full state is captured in
    // `donor` below, written to the archive file right after this commits.
    await tx.user.delete({ where: { id: donorId } })
  })

  // Written after the transaction commits (not before) since the archive
  // now includes the actual collision outcomes decided during the
  // transaction itself - there's no separate dry-run pass to keep in sync.
  fs.writeFileSync(archivePath, JSON.stringify({
    mergedAt: new Date().toISOString(),
    survivorId,
    donorId,
    donor: donorFull,
    ...archive,
  }, null, 2))

  return { ...preview, archivePath }
}

/**
 * Reverses a merge: recreates the donor User row (same id as before) and
 * every row it owned, restores any survivor row that was overwritten during
 * the merge's collision resolution, re-adds the donor to its original
 * group(s), and drops the survivor's absorbed UserProviderCredential.
 *
 * Best-effort, not a perfect time-reversal - see the module comment at the
 * top of this file for what that means in practice.
 */
async function undoMerge(prisma, survivorId, { dataDir = path.join(process.cwd(), 'data') } = {}) {
  const credential = await prisma.userProviderCredential.findFirst({ where: { userId: survivorId } })
  if (!credential) throw new Error('No merged account found on this user to undo')
  if (!credential.donorId || !credential.mergeArchivePath) {
    throw new Error('This merge predates undo support and has no archive to reverse it from')
  }

  const archiveFullPath = path.join(dataDir, 'backup', 'merges', credential.mergeArchivePath)
  if (!fs.existsSync(archiveFullPath)) {
    throw new Error('Merge archive file is missing on disk - cannot undo safely')
  }
  const archive = JSON.parse(fs.readFileSync(archiveFullPath, 'utf8'))
  const { donorId, donor, donorRows = {}, overwrittenSurvivorRows = {}, donorGroupIds = [] } = archive
  if (donorId !== credential.donorId) {
    throw new Error('Archive file does not match this account\'s recorded merge - refusing to undo')
  }

  const collidingUser = await prisma.user.findUnique({ where: { id: donorId } })
  if (collidingUser) {
    throw new Error('A user with the original donor id already exists - cannot undo safely')
  }

  await prisma.$transaction(async (tx) => {
    // 1. Recreate the donor's own User row exactly as it was.
    const { id: _donorId, ...donorFields } = donor
    await tx.user.create({ data: { id: donorId, ...donorFields } })

    // 2. Every donor-owned row from the collision-prone tables + dismissed:
    // still live under the survivor (it won its collision, or had none) ->
    // point it back; hard-deleted (it lost a collision) -> recreate it.
    const donorOwnedTables = ['movieWatchHistory', 'episodeWatchHistory', 'watchSnapshot', 'watchSession', 'dismissedContinueWatching']
    for (const modelName of donorOwnedTables) {
      for (const row of donorRows[modelName] || []) {
        const stillLive = await tx[modelName].findUnique({ where: { id: row.id } }).catch(() => null)
        if (stillLive) {
          await tx[modelName].update({ where: { id: row.id }, data: { userId: donorId } })
        } else {
          const { id: rowId, ...rowFields } = row
          await tx[modelName].create({ data: { id: rowId, ...rowFields, userId: donorId } })
        }
      }
    }

    // 3. Recreate any survivor row that was deleted as the losing side of a
    // collision during the merge - it's fully gone from the live tables, so
    // this is always a create, never an update.
    for (const modelName of Object.keys(overwrittenSurvivorRows)) {
      for (const row of overwrittenSurvivorRows[modelName]) {
        const stillLive = await tx[modelName].findUnique({ where: { id: row.id } }).catch(() => null)
        if (!stillLive) {
          await tx[modelName].create({ data: row })
        }
      }
    }

    // 4. WatchActivity - no collisions ever happened here, straight point-back.
    for (const row of donorRows.watchActivity || []) {
      await tx.watchActivity.updateMany({ where: { id: row.id }, data: { userId: donorId } })
    }

    // 5. Re-add the donor to whichever group(s) it originally belonged to.
    if (donorGroupIds.length) {
      const groups = await tx.group.findMany({ where: { id: { in: donorGroupIds } } })
      for (const group of groups) {
        let ids = []
        try { ids = JSON.parse(group.userIds || '[]') } catch { ids = [] }
        if (!ids.includes(donorId)) {
          await tx.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify([...ids, donorId]) } })
        }
      }
    }

    // 6. The survivor no longer has this provider absorbed.
    await tx.userProviderCredential.delete({ where: { id: credential.id } })
  })

  // Mark the archive consumed so it can't accidentally be replayed against
  // a second, unrelated merge that happens to reuse this same file later.
  try { fs.renameSync(archiveFullPath, `${archiveFullPath}.undone`) } catch { /* non-fatal - undo already committed */ }

  return { donorId, donorUsername: donor.username, donorProviderType: donor.providerType }
}

module.exports = { getMergeCandidate, getMergePreview, getUndoInfo, mergeUsers, undoMerge }
