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

module.exports = { deleteAccountCascade };
