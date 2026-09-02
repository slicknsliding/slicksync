// Deleting something puts it in the Trash first, so a mistake costs one
// click instead of being permanent.
//
// WHY AN ARCHIVE, NOT A `deletedAt` COLUMN
// Soft-delete columns are the obvious approach and the wrong one here.
// There are ~358 existing read queries against users/addons/catalogs/groups;
// every one would need a "not deleted" filter, and a single missed filter
// silently resurrects deleted records - a failure mode that is quiet,
// data-shaped, and easy to ship. Soft-deleted rows also keep occupying their
// unique names (username, [name, accountId]), so re-creating something with
// the same name would fail with a constraint error for no visible reason.
//
// Archiving sidesteps both: the original row is genuinely deleted, so no
// existing query can be wrong and names free up immediately. Restore replays
// the archived payload. This mirrors what the account-merge undo already
// does (utils/userMerge.js archives full rows before merging, and replays
// them to reverse it).
//
// SCOPE - grown from catalogs+addons to the full destructive set: users,
// groups, group memberships, vault entries, graveyard wipes and history
// imports. The original exclusion of users assumed deleting one cascaded
// into its history; in reality the delete route removes only the User row
// and group memberships - watch history has no FK and is keyed by userId
// string, so restoring the row under its ORIGINAL id reattaches everything.
// That makes a faithful user restore cheap, provided the id is preserved
// (a restore that can't reuse the id refuses instead of half-restoring).

const RETENTION_DAYS = 30

/** Everything needed to rebuild an addon, including its group assignments. */
async function buildAddonPayload(prisma, accountId, addonId) {
  const addon = await prisma.addon.findFirst({ where: { id: addonId, accountId } })
  if (!addon) return null
  const groupAddons = await prisma.groupAddon.findMany({
    where: { addonId },
    select: { groupId: true, isEnabled: true },
  }).catch(() => [])
  return { addon, groupAddons }
}

async function buildCatalogPayload(prisma, accountId, listId) {
  // Self-contained: items live inline on the row (itemsJson), so the row
  // alone is a complete restore.
  const list = await prisma.customList.findFirst({ where: { id: listId, accountId } })
  return list ? { list } : null
}

/**
 * Archives then deletes. Returns the TrashItem so a caller can offer an
 * immediate "Undo" without a second lookup.
 *
 * The archive is written BEFORE the delete: if archiving fails the delete
 * does not happen, which is the safe way round.
 */
async function archiveAndDelete(prisma, accountId, kind, id) {
  const accountIdValue = accountId || 'default'

  if (kind === 'catalog') {
    const payload = await buildCatalogPayload(prisma, accountIdValue, id)
    if (!payload) throw new Error('Catalog not found')
    const trash = await prisma.trashItem.create({
      data: {
        accountId: accountIdValue,
        kind: 'catalog',
        label: payload.list.name || 'Untitled catalog',
        payload: JSON.stringify(payload),
      },
    })
    await prisma.customList.delete({ where: { id } })
    return trash
  }

  if (kind === 'addon') {
    const payload = await buildAddonPayload(prisma, accountIdValue, id)
    if (!payload) throw new Error('Addon not found')
    const trash = await prisma.trashItem.create({
      data: {
        accountId: accountIdValue,
        kind: 'addon',
        label: payload.addon.name || 'Untitled addon',
        payload: JSON.stringify(payload),
      },
    })
    await prisma.addon.delete({ where: { id } })
    return trash
  }

  throw new Error(`Unsupported trash kind: ${kind}`)
}

/**
 * Archives WITHOUT deleting, for callers that own their own delete path -
 * the addon route deletes through a transaction that also tears down
 * relations, and replacing that with a plain delete here would leave those
 * behind. Those callers archive first, then run their existing delete.
 */
async function archive(prisma, accountId, kind, id) {
  const accountIdValue = accountId || 'default'
  const payload = kind === 'addon'
    ? await buildAddonPayload(prisma, accountIdValue, id)
    : kind === 'catalog'
      ? await buildCatalogPayload(prisma, accountIdValue, id)
      : null
  if (!payload) throw new Error(`Nothing to archive for ${kind} ${id}`)

  const label = kind === 'addon'
    ? (payload.addon.name || 'Untitled addon')
    : (payload.list.name || 'Untitled catalog')

  return prisma.trashItem.create({
    data: { accountId: accountIdValue, kind, label, payload: JSON.stringify(payload) },
  })
}

async function listTrash(prisma, accountId) {
  const items = await prisma.trashItem.findMany({
    where: { accountId: accountId || 'default' },
    orderBy: { deletedAt: 'desc' },
    select: { id: true, kind: true, label: true, deletedAt: true },
  })
  return items.map((i) => ({
    ...i,
    // Surfaced so the UI can say how long is left rather than making people
    // work out the retention window themselves.
    expiresInDays: Math.max(0, RETENTION_DAYS - Math.floor((Date.now() - new Date(i.deletedAt).getTime()) / 86400000)),
  }))
}

/**
 * Rebuilds the archived record. Keeps the ORIGINAL id where it is still
 * free, so anything else referencing it (a group assignment, a share code
 * someone already holds) keeps working after a restore.
 */
async function restoreTrashItem(prisma, accountId, trashId) {
  const accountIdValue = accountId || 'default'
  const item = await prisma.trashItem.findFirst({ where: { id: trashId, accountId: accountIdValue } })
  if (!item) throw new Error('Nothing to restore')

  const payload = JSON.parse(item.payload)

  if (item.kind === 'catalog') {
    const { list } = payload
    const existing = await prisma.customList.findUnique({ where: { id: list.id } }).catch(() => null)
    // Something already took the id back - restore under a fresh one rather
    // than failing or overwriting whatever is there now.
    const data = existing ? { ...list, id: undefined } : list
    await prisma.customList.create({ data })
    await prisma.trashItem.delete({ where: { id: trashId } })
    return { kind: 'catalog', label: item.label }
  }

  if (item.kind === 'addon') {
    const { addon, groupAddons } = payload
    const existing = await prisma.addon.findUnique({ where: { id: addon.id } }).catch(() => null)
    const created = await prisma.addon.create({ data: existing ? { ...addon, id: undefined } : addon })
    // Re-attach group assignments, skipping any whose group has since been
    // deleted - best-effort, because a missing group must not block getting
    // the addon itself back.
    for (const ga of (groupAddons || [])) {
      await prisma.groupAddon.create({
        data: { groupId: ga.groupId, addonId: created.id, isEnabled: ga.isEnabled },
      }).catch(() => {})
    }
    await prisma.trashItem.delete({ where: { id: trashId } })
    return { kind: 'addon', label: item.label }
  }

  const extended = await restoreExtendedKind(prisma, accountIdValue, item, payload)
  if (extended) {
    await prisma.trashItem.delete({ where: { id: trashId } })
    return extended
  }

  throw new Error(`Unsupported trash kind: ${item.kind}`)
}

async function purgeTrashItem(prisma, accountId, trashId) {
  await prisma.trashItem.deleteMany({ where: { id: trashId, accountId: accountId || 'default' } })
}

/** Drops anything past the retention window. Safe to call repeatedly. */
async function purgeExpiredTrash(prisma) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
  try {
    const res = await prisma.trashItem.deleteMany({ where: { deletedAt: { lt: cutoff } } })
    if (res.count > 0) console.log(`[Trash] Purged ${res.count} expired item(s)`)
  } catch (e) {
    console.error('[Trash] Purge failed:', e?.message)
  }
}

// ---------------------------------------------------------------------------
// The destructive dozen - archive builders for everything beyond addon/catalog.
// Each is called by its owning route BEFORE the destructive write, mirroring
// archive(): if archiving fails, the delete does not happen.

/**
 * User deletion. The route removes only the User row and its group
 * memberships (history has no FK - it reattaches by userId when the row
 * comes back under the same id), so the payload is small: the row, the
 * merged-provider credential rows, and which groups held the user.
 */
async function archiveUserDelete(prisma, accountId, userId) {
  const accountIdValue = accountId || 'default'
  const user = await prisma.user.findFirst({ where: { id: userId, accountId: accountIdValue } })
  if (!user) throw new Error('User not found')
  const credentials = await prisma.userProviderCredential.findMany({ where: { userId } }).catch(() => [])
  const groups = await prisma.group.findMany({
    where: { accountId: accountIdValue, userIds: { contains: userId } },
    select: { id: true },
  }).catch(() => [])
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'user',
      label: user.username || user.email || 'Unnamed user',
      payload: JSON.stringify({ user, credentials, groupIds: groups.map((g) => g.id) }),
    },
  })
}

async function archiveGroupDelete(prisma, accountId, groupId) {
  const accountIdValue = accountId || 'default'
  const group = await prisma.group.findFirst({ where: { id: groupId, accountId: accountIdValue } })
  if (!group) throw new Error('Group not found')
  const groupAddons = await prisma.groupAddon.findMany({
    where: { groupId },
    select: { addonId: true, isEnabled: true },
  }).catch(() => [])
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'group',
      label: group.name || 'Untitled group',
      payload: JSON.stringify({ group, groupAddons }),
    },
  })
}

/** Removing one user from one group - the smallest undoable act. */
async function archiveMembershipRemoval(prisma, accountId, groupId, userId) {
  const accountIdValue = accountId || 'default'
  const [group, user] = await Promise.all([
    prisma.group.findFirst({ where: { id: groupId, accountId: accountIdValue }, select: { id: true, name: true } }),
    prisma.user.findFirst({ where: { id: userId, accountId: accountIdValue }, select: { id: true, username: true } }),
  ])
  if (!group) throw new Error('Group not found')
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'membership',
      label: `${user?.username || userId} removed from ${group.name}`,
      payload: JSON.stringify({ groupId, userId }),
    },
  })
}

async function archiveVaultDelete(prisma, accountId, entryId) {
  const accountIdValue = accountId || 'default'
  const entry = await prisma.vaultEntry.findFirst({ where: { id: entryId, accountId: accountIdValue } })
  if (!entry) throw new Error('Vault entry not found')
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'vault',
      label: entry.name || 'Untitled entry',
      // Secrets stay encrypted exactly as stored - the archive never holds
      // plaintext, and restore writes the ciphertext back untouched.
      payload: JSON.stringify({ entry }),
    },
  })
}

/** Graveyard wipe - the episode rows and burial about to be erased. */
async function archiveGraveyardWipe(prisma, accountId, userId, showId) {
  const accountIdValue = accountId || 'default'
  const episodes = await prisma.episodeWatchHistory.findMany({
    where: { accountId: accountIdValue, userId, showId },
  })
  const dismissals = await prisma.dismissedContinueWatching.findMany({
    where: { accountId: accountIdValue, userId, showId },
  }).catch(() => [])
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { username: true } }).catch(() => null)
  const showName = episodes[0]?.showName || showId
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'wipe',
      label: `${showName} wiped for ${user?.username || userId}`,
      payload: JSON.stringify({ userId, showId, episodes, dismissals }),
    },
  })
}

/**
 * Watch-history import - the inverse entry. Unlike every other kind this
 * records what was CREATED, and "restoring" it deletes exactly those rows.
 * The import route computes createdItemIds/createdRatingIds by diffing
 * against what existed before the run, so an undo never touches rows that
 * predate the import (the import itself never overwrites them either).
 */
async function archiveHistoryImport(prisma, accountId, userId, { createdItemIds, createdRatingIds, source }) {
  const accountIdValue = accountId || 'default'
  if (!Array.isArray(createdItemIds) || createdItemIds.length === 0) return null
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { username: true } }).catch(() => null)
  return prisma.trashItem.create({
    data: {
      accountId: accountIdValue,
      kind: 'import',
      label: `${createdItemIds.length} title${createdItemIds.length === 1 ? '' : 's'} imported for ${user?.username || userId}${source ? ` (${source})` : ''}`,
      payload: JSON.stringify({ userId, createdItemIds, createdRatingIds: createdRatingIds || [] }),
    },
  })
}

/** Restore cases for the extended kinds - called from restoreTrashItem. */
async function restoreExtendedKind(prisma, accountIdValue, item, payload) {
  if (item.kind === 'user') {
    const { user, credentials, groupIds } = payload
    const idTaken = await prisma.user.findUnique({ where: { id: user.id } }).catch(() => null)
    if (idTaken) {
      // The id is what reattaches watch history, sessions and reactions - a
      // restore under a fresh id would look complete while silently orphaning
      // all of it. Refuse instead.
      throw new Error('A user with this internal id already exists - cannot restore without detaching their history')
    }
    try {
      await prisma.user.create({ data: user })
    } catch (e) {
      if (e?.code === 'P2002') {
        // Name/email taken by a newer user - restore under a marked name.
        await prisma.user.create({ data: { ...user, username: `${user.username} (restored)`, email: user.email ? `restored-${user.email}` : user.email } })
      } else throw e
    }
    for (const cred of (credentials || [])) {
      await prisma.userProviderCredential.create({ data: cred }).catch(() => {})
    }
    for (const gid of (groupIds || [])) {
      try {
        const g = await prisma.group.findFirst({ where: { id: gid, accountId: accountIdValue }, select: { userIds: true } })
        if (!g) continue
        const ids = JSON.parse(g.userIds || '[]')
        if (!ids.includes(user.id)) {
          await prisma.group.update({ where: { id: gid }, data: { userIds: JSON.stringify([...ids, user.id]) } })
        }
      } catch { /* a vanished group must not block the user coming back */ }
    }
    return { kind: 'user', label: item.label }
  }

  if (item.kind === 'userstate') {
    // A per-user restore's undo: put the archived row state back IN PLACE
    // (the row exists - this kind is only written while it does) and set
    // group membership to exactly what it was.
    const { user, groupIds } = payload
    const existingRow = await prisma.user.findUnique({ where: { id: user.id } }).catch(() => null)
    if (!existingRow) throw new Error('That user no longer exists - restore them from their own Trash entry instead')
    const { id, accountId: _a, ...fields } = user
    await prisma.user.update({ where: { id: user.id }, data: fields })
    const wanted = new Set(groupIds || [])
    const groups = await prisma.group.findMany({ where: { accountId: accountIdValue } })
    for (const g of groups) {
      let ids = []
      try { ids = JSON.parse(g.userIds || '[]') } catch {}
      const isMember = ids.includes(user.id)
      const shouldBe = wanted.has(g.id)
      if (shouldBe && !isMember) {
        await prisma.group.update({ where: { id: g.id }, data: { userIds: JSON.stringify([...ids, user.id]) } }).catch(() => {})
      } else if (!shouldBe && isMember) {
        await prisma.group.update({ where: { id: g.id }, data: { userIds: JSON.stringify(ids.filter((i) => i !== user.id)) } }).catch(() => {})
      }
    }
    return { kind: 'userstate', label: item.label }
  }

  if (item.kind === 'group') {
    const { group, groupAddons } = payload
    const existing = await prisma.group.findUnique({ where: { id: group.id } }).catch(() => null)
    const created = await prisma.group.create({ data: existing ? { ...group, id: undefined } : group })
    for (const ga of (groupAddons || [])) {
      await prisma.groupAddon.create({
        data: { groupId: created.id, addonId: ga.addonId, isEnabled: ga.isEnabled },
      }).catch(() => {}) // an addon deleted since must not block the group
    }
    return { kind: 'group', label: item.label }
  }

  if (item.kind === 'membership') {
    const { groupId, userId } = payload
    const [group, user] = await Promise.all([
      prisma.group.findFirst({ where: { id: groupId, accountId: accountIdValue }, select: { userIds: true } }),
      prisma.user.findFirst({ where: { id: userId, accountId: accountIdValue }, select: { id: true } }),
    ])
    if (!group) throw new Error('That group no longer exists')
    if (!user) throw new Error('That user no longer exists')
    const ids = JSON.parse(group.userIds || '[]')
    if (!ids.includes(userId)) {
      await prisma.group.update({ where: { id: groupId }, data: { userIds: JSON.stringify([...ids, userId]) } })
    }
    return { kind: 'membership', label: item.label }
  }

  if (item.kind === 'vault') {
    const { entry } = payload
    const idTaken = await prisma.vaultEntry.findUnique({ where: { id: entry.id } }).catch(() => null)
    const data = idTaken ? { ...entry, id: undefined } : { ...entry }
    // The backup link is a real relation - if the partner entry was deleted
    // in the meantime, restoring the pointer would fail the whole create.
    if (data.backupEntryId) {
      const partner = await prisma.vaultEntry.findUnique({ where: { id: data.backupEntryId } }).catch(() => null)
      if (!partner) data.backupEntryId = null
    }
    await prisma.vaultEntry.create({ data })
    return { kind: 'vault', label: item.label }
  }

  if (item.kind === 'wipe') {
    const { episodes, dismissals } = payload
    let restored = 0
    for (const ep of (episodes || [])) {
      try { await prisma.episodeWatchHistory.create({ data: ep }); restored++ } catch { /* re-watched since - keep the newer row */ }
    }
    for (const d of (dismissals || [])) {
      // The burial comes back too: the show returns to the graveyard, not to
      // Continue Watching - undoing a wipe shouldn't also dig the show up.
      await prisma.dismissedContinueWatching.create({ data: d }).catch(() => {})
    }
    return { kind: 'wipe', label: item.label, restoredEpisodes: restored }
  }

  if (item.kind === 'import') {
    const { userId, createdItemIds, createdRatingIds } = payload
    const del = await prisma.movieWatchHistory.deleteMany({
      where: { accountId: accountIdValue, userId, itemId: { in: createdItemIds || [] } },
    })
    if (Array.isArray(createdRatingIds) && createdRatingIds.length > 0) {
      await prisma.titleRating.deleteMany({
        where: { accountId: accountIdValue, season: 0, itemId: { in: createdRatingIds } },
      }).catch(() => {})
    }
    return { kind: 'import', label: item.label, deletedRows: del.count }
  }

  return null
}

module.exports = {
  archive,
  archiveAndDelete,
  archiveUserDelete,
  archiveGroupDelete,
  archiveMembershipRemoval,
  archiveVaultDelete,
  archiveGraveyardWipe,
  archiveHistoryImport,
  listTrash,
  restoreTrashItem,
  purgeTrashItem,
  purgeExpiredTrash,
  RETENTION_DAYS,
}
