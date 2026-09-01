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
// SCOPE - deliberately catalogs and addons only.
// Deleting a user cascades into watch history, sessions, provider
// credentials, group memberships and more; faithfully restoring that is a
// substantial job in its own right - it is essentially what merge-undo does,
// and that needed a dedicated implementation. Half-restoring a user would be
// worse than not offering it, so user deletion is left alone rather than
// given an undo that quietly loses history.

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

module.exports = {
  archive,
  archiveAndDelete,
  listTrash,
  restoreTrashItem,
  purgeTrashItem,
  purgeExpiredTrash,
  RETENTION_DAYS,
}
