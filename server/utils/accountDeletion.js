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
// Every table holding rows for one person (a userId column), in both
// schemas. A table added later belongs here too - test/accountDeletion.test.js
// reads the schemas and fails when one is missing.
const PERSON_TABLES = [
  'aioConfigSnapshot', 'dismissedContinueWatching', 'episodeWatchHistory', 'movieWatchHistory',
  'nuvioCollectionsSnapshot', 'nuvioHomeLayoutSnapshot', 'personPushSubscription', 'proxyDeviceClaim',
  'proxyUserIpAffinity', 'streamGateWrap', 'userSyncGuardState', 'watchActivity', 'watchCopyRun',
  'watchSession', 'watchSnapshot', 'watchStateCursor', 'watchStateEvent', 'watchSyncMove', 'watchSyncSetting',
  'userProviderCredential',
]

// Every table scoped to an account (an accountId column), children first;
// User and AppAccount go last. Checked against the schemas the same way.
const ACCOUNT_TABLES = [
  'addonHealthAlert', 'addonSnapshot', 'aioConfigSnapshot', 'automationRun', 'automationRule', 'customList',
  'dbSizeSample', 'dismissedContinueWatching', 'dismissedThemedCatalog', 'dismissedUpcomingEpisode', 'episodeAlert',
  'episodeWatchHistory', 'followedSubject', 'inviteRequest', 'jellyfinProfile', 'manualWatchOverride',
  'movieWatchHistory', 'mutedShow', 'notInterestedItem', 'notification', 'notificationDigestEntry',
  'nuvioCollectionsSnapshot', 'nuvioHomeLayoutSnapshot', 'nuvioProfileRoute', 'passkey', 'personPushSubscription',
  'profileMerge', 'proxyDeviceClaim', 'proxyStreamSession', 'proxyUserIpAffinity', 'pushSubscription',
  'showEpisodeAlertState', 'streamGateWrap', 'titleRating', 'titleReaction', 'trashItem', 'userSyncGuardState',
  'vaultEntry', 'watchActivity', 'watchCopyRun', 'watchSession', 'watchSnapshot', 'watchStateCursor',
  'watchStateEvent', 'watchSyncMove', 'watchSyncSetting', 'watchTogetherShow', 'watchlistItem',
  // Invitation already cascades from AppAccount, but clearing it explicitly
  // keeps this list self-contained/order-independent.
  'invitation',
  // Group/Addon last among the "structural" tables - GroupAddon has no
  // accountId of its own, it cascades automatically off these two.
  'group', 'addon',
]

// A table only one schema has (dbSizeSample is SQLite-only) is skipped.
const deletes = (prisma, tables, where) => tables.filter((t) => prisma[t]?.deleteMany).map((t) => prisma[t].deleteMany({ where }))

async function deleteAccountCascade(prisma, accountId) {
  const existing = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { id: true, uuid: true } });
  if (!existing) {
    const err = new Error('Account not found');
    err.notFound = true;
    throw err;
  }
  const where = { accountId };
  // Merged-in sign-ins carry only the person's id.
  const people = (await prisma.user.findMany({ where, select: { id: true } })).map((u) => u.id);
  await prisma.$transaction([
    ...deletes(prisma, ['userProviderCredential'], { userId: { in: people } }),
    ...deletes(prisma, ACCOUNT_TABLES, where),
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

  // Their household's own rows come off their AIOStreams while it can still be reached.
  await require('./aioProfileVariants').forgetOwnRows(prisma, require('./encryption').decrypt, userId)

  // Group membership lives as a JSON-string userIds array on Group, not a
  // relational FK - strip this user out of every group in their account
  // before deleting them, so no group is left pointing at a dangling id.
  await require('./helpers/database').withMembershipLock(existing.accountId, async () => {
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

  await prisma.$transaction([
    ...groupUpdates,
    ...deletes(prisma, PERSON_TABLES, { userId }),
    prisma.user.delete({ where: { id: userId } }),
  ])
  })
  await require('./jellyfinProfiles').forgetPersonHousehold(prisma, userId)
  return existing
}

/**
 * A person deleted from the Users page waits 30 days in the Trash with their
 * history kept (it reattaches when they're restored). Once that entry is
 * gone for good, so is what they left: called for each person whose Trash
 * entry expired or was emptied - and only if they weren't restored.
 */
async function purgePersonLeftovers(prisma, userId) {
  if (!userId) return
  const back = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null)
  if (back) return
  await prisma.$transaction(deletes(prisma, PERSON_TABLES, { userId }))
}

module.exports = { deleteAccountCascade, deleteUserCascade, purgePersonLeftovers, PERSON_TABLES, ACCOUNT_TABLES };
