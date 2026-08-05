// Cascade-deletes an AppAccount and every row scoped to it. AppAccount's
// accountId is an application-level scope field, not an enforced FK (only
// Invitation has a real onDelete:Cascade relation back to AppAccount), so
// every accountId-scoped table needs clearing explicitly or it's left as
// orphaned data - this list is every model with an accountId field in the
// public (Postgres) schema as of this writing. Shared by Superadmin's
// operator-initiated delete and Settings' self-service delete - same
// irreversible operation either way, just a different caller/audit trail.
// Throws (with .notFound = true) if the account doesn't exist; callers
// decide how to report that.
async function deleteAccountCascade(prisma, accountId) {
  const existing = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { id: true, uuid: true } });
  if (!existing) {
    const err = new Error('Account not found');
    err.notFound = true;
    throw err;
  }
  const where = { accountId };
  await prisma.$transaction([
    prisma.addonHealthAlert.deleteMany({ where }),
    prisma.addonSnapshot.deleteMany({ where }),
    prisma.customList.deleteMany({ where }),
    prisma.dismissedContinueWatching.deleteMany({ where }),
    prisma.dismissedUpcomingEpisode.deleteMany({ where }),
    prisma.episodeAlert.deleteMany({ where }),
    prisma.episodeWatchHistory.deleteMany({ where }),
    prisma.inviteRequest.deleteMany({ where }),
    prisma.manualWatchOverride.deleteMany({ where }),
    prisma.movieWatchHistory.deleteMany({ where }),
    prisma.notInterestedItem.deleteMany({ where }),
    prisma.proxyStreamSession.deleteMany({ where }),
    prisma.pushSubscription.deleteMany({ where }),
    prisma.showEpisodeAlertState.deleteMany({ where }),
    prisma.userSyncGuardState.deleteMany({ where }),
    prisma.vaultEntry.deleteMany({ where }),
    prisma.watchActivity.deleteMany({ where }),
    prisma.watchSession.deleteMany({ where }),
    prisma.watchSnapshot.deleteMany({ where }),
    prisma.watchlistItem.deleteMany({ where }),
    // Invitation already cascades from AppAccount, but clearing it
    // explicitly here too keeps this list self-contained/order-independent.
    prisma.invitation.deleteMany({ where }),
    // Group/Addon last among the "structural" tables - GroupAddon has no
    // accountId of its own, it cascades automatically off these two.
    prisma.group.deleteMany({ where }),
    prisma.addon.deleteMany({ where }),
    prisma.user.deleteMany({ where }),
    prisma.appAccount.delete({ where: { id: accountId } }),
  ]);
  return existing;
}

// Cascade-deletes a single managed User and only the rows scoped to their
// own userId - NOT the shared account-level resources (Vault, Catalogs,
// Groups/Addons themselves) that deleteAccountCascade above wipes for the
// whole tenant. This is the self-service "delete my account" a managed
// User can trigger from their own User panel, distinct from an admin
// wiping their entire AppAccount. Every model below genuinely has a
// userId field (confirmed against both prisma schemas) - models that are
// account-wide/shared (WatchlistItem, NotInterestedItem,
// ManualWatchOverride, DismissedUpcomingEpisode, ShowEpisodeAlertState,
// Vault, CustomList, Notification, PushSubscription, etc.) are
// deliberately left untouched here.
async function deleteUserCascade(prisma, userId) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, accountId: true } })
  if (!existing) {
    const err = new Error('User not found')
    err.notFound = true
    throw err
  }

  // Group membership lives as a JSON-string userIds array on Group, not a
  // relational FK - strip this user out of every group in their account
  // before deleting them, so no group is left pointing at a dangling id.
  const groups = await prisma.group.findMany({
    where: { accountId: existing.accountId },
    select: { id: true, userIds: true }
  })
  const groupUpdates = []
  for (const group of groups) {
    let ids = []
    try { ids = group.userIds ? JSON.parse(group.userIds) : [] } catch { ids = [] }
    if (ids.includes(userId)) {
      groupUpdates.push(
        prisma.group.update({
          where: { id: group.id },
          data: { userIds: JSON.stringify(ids.filter((id) => id !== userId)) }
        })
      )
    }
  }

  const where = { userId }
  await prisma.$transaction([
    ...groupUpdates,
    prisma.watchSnapshot.deleteMany({ where }),
    prisma.watchActivity.deleteMany({ where }),
    prisma.episodeWatchHistory.deleteMany({ where }),
    prisma.movieWatchHistory.deleteMany({ where }),
    prisma.userSyncGuardState.deleteMany({ where }),
    prisma.watchSession.deleteMany({ where }),
    prisma.dismissedContinueWatching.deleteMany({ where }),
    prisma.proxyUserIpAffinity.deleteMany({ where }),
    prisma.userProviderCredential.deleteMany({ where }),
    prisma.user.delete({ where: { id: userId } }),
  ])
  return existing
}

module.exports = { deleteAccountCascade, deleteUserCascade };
