// Reminds an account to export a fresh Disaster Recovery Kit when the last
// one is old (or was never made).
//
// Why this exists rather than an automated off-site kit: the Recovery Kit
// is the ONLY artifact that carries Vault secrets, and scheduling it would
// mean continuously copying every credential to a third-party bucket, plus
// storing its passphrase on the server for the automation to use - which
// then either dies with the server (making the off-site copy undecryptable
// and the whole thing pointless) or has to be kept elsewhere by hand
// anyway. Off-site backups (utils/backupTargets.js) deliberately carry
// config only, no secrets.
//
// The real failure mode isn't that making a kit is hard - it's that people
// make one on day one, add credentials for a year, and never make another.
// A nudge fixes that without moving a single secret anywhere.
//
// Opt-in, off by default, same as every other notifyOn* toggle: it rides
// notifyPushForType, which checks the account's own flag and writes the
// bell entry as well as sending push.

const { notifyPushForType } = require('./pushNotifications')

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const STALE_AFTER_DAYS = 60
// Don't re-nag daily once it's already stale - one reminder per this
// window is enough to be useful without becoming noise people mute.
const RENOTIFY_GAP_DAYS = 14

let timer = null

function daysSince(iso) {
  if (!iso) return Infinity
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return Infinity
  return (Date.now() - t) / 86400000
}

async function runRecoveryKitCheck(prisma) {
  try {
    const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
    for (const acc of accounts) {
      let cfg = acc.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
      if (!cfg || typeof cfg !== 'object') continue
      if (cfg.notifyOnRecoveryKitStale !== true) continue

      const age = daysSince(cfg.lastRecoveryKitExportAt)
      if (age < STALE_AFTER_DAYS) continue
      if (daysSince(cfg.lastRecoveryKitReminderAt) < RENOTIFY_GAP_DAYS) continue

      // An account with nothing in the Vault has nothing this kit would
      // rescue that a normal backup doesn't already cover - reminding them
      // would be pure noise.
      const vaultCount = await prisma.vaultEntry.count({ where: { accountId: acc.id } }).catch(() => 0)
      if (vaultCount === 0) continue

      const never = age === Infinity
      await notifyPushForType(prisma, acc.id, 'notifyOnRecoveryKitStale', {
        title: never ? 'No Recovery Kit yet' : 'Recovery Kit is out of date',
        body: never
          ? `Your ${vaultCount} Vault credential${vaultCount === 1 ? '' : 's'} can't be restored if this server is lost. Export a Recovery Kit and keep it somewhere else.`
          : `The last Recovery Kit is ${Math.floor(age)} days old, and the Vault has ${vaultCount} credential${vaultCount === 1 ? '' : 's'}. Export a fresh one so a restore isn't missing anything.`,
        url: '/tasks',
      })

      const nextCfg = { ...cfg, lastRecoveryKitReminderAt: new Date().toISOString() }
      try {
        await prisma.appAccount.update({ where: { id: acc.id }, data: { sync: nextCfg } })
      } catch {
        await prisma.appAccount.update({ where: { id: acc.id }, data: { sync: JSON.stringify(nextCfg) } })
      }
    }
  } catch (err) {
    console.error('[RecoveryKitReminder] Run failed:', err?.message)
  }
}

function scheduleRecoveryKitReminder(prisma) {
  if (timer) { clearInterval(timer); timer = null }
  // Well past the other boot-time schedulers, same staggering pattern the
  // rest of them use.
  setTimeout(() => runRecoveryKitCheck(prisma), 180 * 1000)
  timer = setInterval(() => runRecoveryKitCheck(prisma), CHECK_INTERVAL_MS)
}

function clearRecoveryKitReminder() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { scheduleRecoveryKitReminder, clearRecoveryKitReminder, runRecoveryKitCheck }
