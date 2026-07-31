/**
 * Sync Guardian: catches a user's account silently reverting to Unsynced
 * after SlickSync successfully synced it - something OUTSIDE SlickSync
 * (a live Stremio/Nuvio client still logged into the same account, re-
 * uploading its own addon set) overwrote what was just pushed.
 *
 * Not a theory - confirmed live on 2026-07-30: a diagnostic monitor caught
 * SLICK STREMIO's account go Synced -> Synced -> Synced -> reverted within a
 * single 15-minute window, with SlickSync's own scheduled auto-sync OFF the
 * entire time (so nothing in SlickSync itself could have written the addon
 * that came back). This module turns that one-off diagnostic into a standing
 * feature: periodically re-check every connected, grouped user's live sync
 * status, and raise a self-healing notification the moment a previously-
 * synced user goes unsynced without SlickSync having done anything.
 *
 * Deliberately its OWN scheduler, not folded into activityMonitor's 1-minute
 * loop - each check makes a live provider API call per user
 * (getUserSyncStatus -> getUserAddons), and activityMonitor already makes one
 * of those per user per minute for library metrics. Doubling that cadence
 * isn't worth it for a signal that only needs to catch drift within minutes,
 * not seconds - see CHECK_INTERVAL_MS.
 *
 * False-positive guards:
 *  - Never fires on a user's FIRST observation (no wasSynced baseline yet) -
 *    a user that has simply never been synced is an existing, normal state
 *    the Users page already shows, not a drift event.
 *  - Skips users with no credentials or no group membership - nothing to
 *    drift from.
 *  - Skips an 'error'/'connect' status (can't tell what's true right now, so
 *    don't guess) rather than treating a transient API hiccup as a revert.
 *  - Self-heals exactly like watchSyncMismatch's mismatch notification: the
 *    standing "drift" bell notification is deleted the moment the user is
 *    confirmed synced again (whether via a manual resync or the drift
 *    resolving itself).
 */
const { createNotification } = require('./notificationStore')

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let timer = null

async function checkAccount(prisma, accountId, deps) {
  const { getAccountId, decrypt, parseAddonIds, parseProtectedAddons, getDecryptedManifestUrl, canonicalizeManifestUrl, StremioAPIClient, createProvider } = deps
  const { createGetUserSyncStatus } = require('./sync')
  const { notifyPushForType } = require('./pushNotifications')
  const getUserSyncStatus = createGetUserSyncStatus({
    prisma, getAccountId, decrypt, parseAddonIds, parseProtectedAddons,
    getDecryptedManifestUrl, canonicalizeManifestUrl, StremioAPIClient, createProvider,
  })
  const req = { appAccountId: accountId, headers: {}, body: {} }

  const users = await prisma.user.findMany({
    where: { accountId, isActive: true },
    select: { id: true, username: true, stremioAuthKey: true, nuvioRefreshToken: true, nuvioUserId: true },
  })
  if (users.length === 0) return

  const groups = await prisma.group.findMany({ where: { accountId }, select: { userIds: true } })
  const groupedUserIds = new Set()
  for (const g of groups) {
    let ids = []
    try { ids = JSON.parse(g.userIds || '[]') } catch {}
    for (const id of ids) groupedUserIds.add(id)
  }

  for (const user of users) {
    const hasCredentials = !!(user.stremioAuthKey || (user.nuvioRefreshToken && user.nuvioUserId))
    if (!hasCredentials || !groupedUserIds.has(user.id)) continue

    let status
    try {
      status = await getUserSyncStatus(user.id, {}, req)
    } catch {
      continue
    }
    if (!status || status.status === 'error' || status.status === 'connect') continue

    const dedupeKey = `sync-guardian-${user.id}`
    const state = await prisma.userSyncGuardState
      .findUnique({ where: { accountId_userId: { accountId, userId: user.id } } })
      .catch(() => null)

    if (state && state.wasSynced === true && status.isSynced === false) {
      await createNotification(prisma, accountId, {
        type: 'sync',
        title: 'Addons changed outside SlickSync',
        body: `${user.username}'s addons no longer match its group - something outside SlickSync (likely another signed-in Stremio/Nuvio session) changed them. Resync to restore.`,
        url: `/users/${user.id}`,
        dedupeKey,
      })
      try {
        await notifyPushForType(prisma, accountId, 'notifyOnSync', {
          title: 'Sync drift detected',
          body: `${user.username} reverted to Unsynced outside SlickSync`,
          icon: '/android-chrome-192x192.png',
          url: `/users/${user.id}`,
        })
      } catch {}
    } else if (status.isSynced === true) {
      // Self-heal: confirmed synced again - clear any standing drift alert.
      await prisma.notification.deleteMany({ where: { accountId, dedupeKey } }).catch(() => {})
    }

    await prisma.userSyncGuardState.upsert({
      where: { accountId_userId: { accountId, userId: user.id } },
      create: { accountId, userId: user.id, wasSynced: status.isSynced, lastCheckedAt: new Date() },
      update: { wasSynced: status.isSynced, lastCheckedAt: new Date() },
    })
  }
}

function scheduleSyncGuardian(prisma, deps, accountId) {
  if (timer) { clearInterval(timer); timer = null }
  const run = () => {
    checkAccount(prisma, accountId, deps).catch((e) => console.warn('[SyncGuardian] check failed:', e?.message))
  }
  run()
  timer = setInterval(run, CHECK_INTERVAL_MS)
}

function clearSyncGuardian() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { scheduleSyncGuardian, clearSyncGuardian, checkAccount }
