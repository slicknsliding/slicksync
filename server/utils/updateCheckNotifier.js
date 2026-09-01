// Proactively notifies (push + bell) every account with notifyOnUpdateAvailable
// enabled when a newer stable (main-promoted, non-beta) SlickSync release is
// published - the same running-vs-latest comparison the Health page's own
// Version card already does on-demand (getVersionStatus, cached 6h against
// GitHub's releases/latest API), just pushed instead of only surfacing on a
// page visit. Opt-in, off by default, same as the other notifyOn* toggles.
//
// One notification per newly-published version per account, not per check -
// tracked via AppAccount.sync.lastNotifiedUpdateVersion so re-checking every
// interval while the same update sits unapplied doesn't re-fire it every
// cycle. All accounts on one instance share the same running APP_VERSION
// (one container), so the version comparison itself only needs to happen
// once per run, not once per account.
const { getVersionStatus } = require('./versionCheck')
const { notifyPushForType } = require('./pushNotifications')

const DEFAULT_INTERVAL_HOURS = 6
let updateCheckTimer = null

async function runUpdateCheck(prisma) {
  try {
    const { running, latestRelease, updateAvailable } = await getVersionStatus()
    if (!updateAvailable || !latestRelease) return

    const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
    for (const acc of accounts) {
      let cfg = acc.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
      if (!cfg || typeof cfg !== 'object' || cfg.notifyOnUpdateAvailable !== true) continue
      if (cfg.lastNotifiedUpdateVersion === latestRelease) continue

      await notifyPushForType(prisma, acc.id, 'notifyOnUpdateAvailable', {
        title: 'SlickSync update available',
        body: `${latestRelease} is out - you're on ${running}.`,
        url: '/metrics?tab=health',
      })

      // Also emitted as an automation event so a rule can act on it (e.g.
      // webhook into a deploy channel). Sits inside the same
      // once-per-version guard above, so it fires once per new release
      // rather than on every check.
      try {
        const { emitAutomationEvent } = require('./automation/engine')
        await emitAutomationEvent(prisma, acc.id, 'update.available', {
          latestVersion: latestRelease,
          runningVersion: running,
        })
      } catch { /* automation must never break the update check */ }

      const nextCfg = { ...cfg, lastNotifiedUpdateVersion: latestRelease }
      try {
        await prisma.appAccount.update({ where: { id: acc.id }, data: { sync: nextCfg } })
      } catch {
        await prisma.appAccount.update({ where: { id: acc.id }, data: { sync: JSON.stringify(nextCfg) } })
      }
    }
  } catch (err) {
    console.error('[UpdateCheck] Run failed:', err.message)
  }
}

function scheduleUpdateCheckNotifier(prisma) {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
  const intervalMs = DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000
  // Run once shortly after boot, then on the interval - mirrors
  // scheduleVaultMonitor's own startup pattern.
  setTimeout(() => runUpdateCheck(prisma), 60 * 1000)
  updateCheckTimer = setInterval(() => runUpdateCheck(prisma), intervalMs)
  console.log(`[UpdateCheck] Scheduled every ${DEFAULT_INTERVAL_HOURS}h`)
}

module.exports = { scheduleUpdateCheckNotifier, runUpdateCheck }
