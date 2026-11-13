// Periodically runs active-checks on vault entries and notifies (bell, push and Discord) when:
//   - an entry is within its notifyDaysBefore window of expiresAt (throttled to once/day)
//   - an automated check flips from ok -> error (throttled to once/day per entry)

const { runCheck } = require('./vaultCheckers')
const { postDiscord } = require('./notify')
const { updateAccountSyncKey } = require('./accountSyncKey')
const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')
const { notifyPushForType } = require('./pushNotifications')

let vaultTimer = null
const DEFAULT_INTERVAL_HOURS = 6
const isDebugMode = process.env.DEBUG === 'true' || process.env.DEBUG === '1'

// Vault alerts now ride on the account's single Discord webhook (the one in
// the Settings > Notifications card), gated by its own `notifyOnVault`
// toggle - the same shape as notifyOnActivity/notifyOnSync/notifyOnInvite.
// This replaced a separate Vault-only notification config (vaultNtfyUrl /
// vaultDiscordWebhookUrl / vaultCheckIntervalHours / vaultNotifyEnabled) so
// there's one place to set up notifications, not two.
function getNotifyConfig(cfg) {
  return {
    enabled: cfg?.notifyOnVault === true,
    discordWebhookUrl: cfg?.webhookUrl || null,
  }
}

// Discord needs an absolute URL to render a clickable link; the push payload's
// `url` is just consumed by the service worker so a relative path is fine
// there. PUBLIC_APP_URL is optional - without it we still send the alert,
// just without the "Fix now" line, rather than posting a broken link.
function getFixNowUrl(entryId) {
  const base = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '')
  if (!base) return null
  return `${base}/vault?edit=${entryId}`
}

async function notify({ discordWebhookUrl }, { title, message, entryId, actionLabel = 'Fix now' }, ctx) {
  const { isDigestEnabled, queueDigestEntry } = require('./notificationDigest')
  const digestOn = ctx?.prisma && ctx?.accountId && await isDigestEnabled(ctx.prisma, ctx.accountId)

  if (digestOn) {
    // Queued regardless of whether Discord is even configured - the digest
    // poller decides which channels (push, Discord, or both) to deliver
    // through. Push + bell are the primary channels; Discord is secondary.
    await queueDigestEntry(ctx.prisma, ctx.accountId, 'vault', `${title}: ${message}`)
    return
  }

  if (discordWebhookUrl) {
    const fixNowUrl = entryId ? getFixNowUrl(entryId) : null
    const text = fixNowUrl ? `**${title}**\n${message}\n\n${actionLabel}: ${fixNowUrl}` : `**${title}**\n${message}`
    await postDiscord(discordWebhookUrl, text)
  }
  // Mirror to phone push (self-gates on notifyOnVault). Independent of Discord,
  // so vault alerts reach an installed PWA even with no webhook configured.
  if (ctx?.prisma && ctx?.accountId) {
    await notifyPushForType(ctx.prisma, ctx.accountId, 'notifyOnVault', {
      title,
      body: message,
      icon: '/android-chrome-192x192.png',
      // Deliberately the plain list page, not `?edit=${entryId}` - that
      // deep-links straight into the edit modal with no transition, which
      // read as a confusing surprise popup rather than a helpful shortcut
      // (confirmed real feedback). Landing on the list still gets you to
      // the right place; the entry itself is easy to spot since it's the
      // one showing the failure.
      url: '/vault',
    })
  }
}

// Per-entry alert bookkeeping lives in the account settings (`vaultAlertState`,
// keyed by entry id) rather than on VaultEntry, so no schema change is needed
// and the two alert kinds can't suppress each other:
//   checkFailedDay - account-local day the check-failure alert last went out
//   expiryWarnDay  - account-local day the pre-expiry warning last went out
//   expiredFor     - the expiresAt value an "expired" alert was already sent
//                    for (sent once; a new expiry date makes it eligible again)
// Days are compared as whole strings (never sliced - the format differs by
// runtime).
function readAlertState(cfg, entryId) {
  const all = cfg && typeof cfg.vaultAlertState === 'object' && cfg.vaultAlertState ? cfg.vaultAlertState : {}
  return all[entryId] || {}
}

async function patchAlertState(prisma, accountId, entryId, patch) {
  try {
    await updateAccountSyncKey(prisma, accountId, 'vaultAlertState', (cur) => {
      const all = cur && typeof cur === 'object' ? { ...cur } : {}
      all[entryId] = { ...(all[entryId] || {}), ...patch }
      return all
    })
  } catch (e) { console.warn('[VaultMonitor] could not save alert state:', e?.message) }
}

async function accountDay(prisma, accountId) {
  const tz = await resolveAccountTimezone(prisma, accountId)
  return getAccountDateString(new Date(), tz)
}

// The ok -> error edge: notification (throttled once a day) plus the
// automation events. Shared by the scheduled monitor and the Test button -
// the Test route overwrites lastCheckStatus, so without calling this too the
// monitor would never see the edge and a failure found by a manual Test would
// never alert. Callers decide the edge (previous status ok, now not ok).
async function raiseCheckFailed({ prisma, accountId, cfg, entry, result }) {
  const notifyCfg = getNotifyConfig(cfg)
  const today = await accountDay(prisma, accountId)
  if (notifyCfg.enabled && readAlertState(cfg, entry.id).checkFailedDay !== today) {
    await notify(notifyCfg, {
      title: `⚠️ ${entry.name} check failed`,
      message: `${entry.provider || entry.category}: ${result.message || 'Check failed'}`,
      tags: ['warning'],
      entryId: entry.id,
    }, { prisma, accountId })
    await patchAlertState(prisma, accountId, entry.id, { checkFailedDay: today })
  }

  // Automation rules fire on the raw ok -> error edge, deliberately NOT gated
  // on the notify toggle: a rule whose action is "move these users to the free
  // group" must still run on an instance with no Discord webhook configured.
  try {
    const { emitAutomationEvent } = require('./automation/engine')
    // Resolve the backup once, so both events agree on whether a usable spare
    // actually exists - "has a backup" must mean a real, active, working
    // entry, not merely a non-null id pointing at something deleted or broken.
    let backup = null
    if (entry.backupEntryId) {
      backup = await prisma.vaultEntry.findFirst({
        where: { id: entry.backupEntryId, accountId, isActive: true },
      }).catch(() => null)
      if (backup && ['failed', 'error', 'expired'].includes(String(backup.lastCheckStatus || '').toLowerCase())) {
        backup = null
      }
    }

    await emitAutomationEvent(prisma, accountId, 'vault.check_failed', {
      entryName: entry.name,
      entryId: entry.id,
      category: entry.category,
      message: result.message || 'Check failed',
      hasBackup: !!backup,
      backupName: backup ? backup.name : '',
    })

    if (backup) {
      await emitAutomationEvent(prisma, accountId, 'vault.failover_activated', {
        entryName: entry.name,
        entryId: entry.id,
        category: entry.category,
        backupName: backup.name,
        backupId: backup.id,
        message: result.message || 'Check failed',
      })
    }
  } catch { /* emit never throws; guarding the require itself */ }
}

async function runVaultChecks({ prisma, decrypt, getAccountId }) {
  try {
    const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })

    for (const account of accounts) {
      let cfg = account.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
      cfg = cfg || {}
      const notifyCfg = getNotifyConfig(cfg)
      // Toggle alone is enough — Discord is skipped downstream when there's no
      // webhook, but phone push can still fire.
      const hasNotifyChannel = notifyCfg.enabled

      const entries = await prisma.vaultEntry.findMany({
        where: { accountId: account.id, isActive: true },
      })

      for (const entry of entries) {
        const mockReq = { appAccountId: account.id }

        // 1) Run the automated check, if configured
        if (entry.testType && entry.testType !== 'manual') {
          try {
            const secret = decrypt(entry.encryptedSecret, mockReq)
            const config = entry.testConfig ? JSON.parse(entry.testConfig) : {}
            config.identifier = entry.provider || config.identifier
            const result = await runCheck(entry.testType, secret, config)

            const wasOk = entry.lastCheckStatus === 'ok'
            const nowOk = result.ok === true

            const updateData = {
              lastCheckedAt: new Date(),
              lastCheckStatus: result.ok === null ? 'unknown' : (nowOk ? 'ok' : 'error'),
              lastCheckMessage: result.message || null,
            }
            if (result.expiresAt instanceof Date && !isNaN(result.expiresAt)) {
              updateData.expiresAt = result.expiresAt
            }
            await prisma.vaultEntry.update({ where: { id: entry.id }, data: updateData })

            // Promotion round trip: this entry is the BACKUP half of an
            // automatic promotion (it holds the demoted original secret),
            // and it just passed - swap the secrets back, clear the stamp,
            // rewrite addons carrying the interim key, and say so.
            try {
              const promos = (cfg && cfg.vaultPromotions) || {}
              const primaryId = Object.keys(promos).find((pid) => promos[pid]?.backupId === entry.id)
              if (nowOk && primaryId) {
                const primaryEntry = await prisma.vaultEntry.findFirst({ where: { id: primaryId, accountId: account.id } })
                if (primaryEntry) {
                  let interimPlain = null
                  let recoveredPlain = null
                  try { interimPlain = decrypt(primaryEntry.encryptedSecret, mockReq) } catch {}
                  try { recoveredPlain = decrypt(entry.encryptedSecret, mockReq) } catch {}
                  await prisma.$transaction([
                    prisma.vaultEntry.update({ where: { id: primaryEntry.id }, data: { encryptedSecret: entry.encryptedSecret, lastCheckStatus: 'ok', lastCheckMessage: 'Original key recovered - restored as primary' } }),
                    prisma.vaultEntry.update({ where: { id: entry.id }, data: { encryptedSecret: primaryEntry.encryptedSecret, lastCheckStatus: 'unknown', lastCheckMessage: 'Back to being the backup' } }),
                  ])
                  // Fresh read: only the vaultPromotions key is ours to change.
                  await updateAccountSyncKey(prisma, account.id, 'vaultPromotions', (cur) => {
                    const next = { ...(cur || {}) }
                    delete next[primaryId]
                    return next
                  })
                  if (interimPlain && recoveredPlain && interimPlain !== recoveredPlain) {
                    try {
                      const { propagateSecretRotation } = require('./keyRotation')
                      const { encrypt: enc2, decrypt: dec2, getDecryptedManifestUrl } = require('./encryption')
                      const { manifestUrlHmac } = require('./hashing')
                      await propagateSecretRotation(prisma, mockReq, { encrypt: enc2, decrypt: dec2, getDecryptedManifestUrl, manifestUrlHmac }, {
                        accountId: account.id, oldSecret: interimPlain, newSecret: recoveredPlain,
                      })
                    } catch (e) { console.warn('[VaultMonitor] swap-back rotation failed:', e?.message) }
                  }
                  try {
                    const { createNotification } = require('./notificationStore')
                    await createNotification(prisma, account.id, {
                      type: 'vault',
                      title: `"${primaryEntry.name}" recovered - promoted back to primary`,
                      body: 'The original credential passed its check again, so the automatic promotion was reversed - it is the primary once more, and the spare went back to being the backup.',
                      dedupeKey: `vaultswapback-${primaryEntry.id}-${new Date().toDateString()}`,
                    })
                  } catch {}
                }
              }
            } catch (e) { console.warn('[VaultMonitor] promotion round-trip failed:', e?.message) }

            // ok -> error edge: alert + automation events (see raiseCheckFailed).
            if (wasOk && !nowOk) {
              await raiseCheckFailed({ prisma, accountId: account.id, cfg, entry, result })
            }
          } catch (err) {
            console.error(`[VaultMonitor] Check failed for entry ${entry.id}:`, err.message)
          }
        }

        // 2) Expiry warning, independent of the check above.
        // hasNotifyChannel is NOT part of this outer gate (it used to be) so
        // automation rules still fire on an instance with no notification
        // channel configured - the notify() call below keeps its own gate, and
        // alert state is only written when something actually happened, so
        // an instance with neither channels nor rules behaves exactly as before.
        if (entry.expiresAt) {
          const msUntilExpiry = new Date(entry.expiresAt).getTime() - Date.now()
          const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24)
          const withinWindow = daysUntilExpiry <= (entry.notifyDaysBefore ?? 3)
          const isSnoozed = entry.snoozedUntil && new Date(entry.snoozedUntil) > new Date()

          const expired = daysUntilExpiry < 0
          const expiresKey = new Date(entry.expiresAt).toISOString()
          const state = readAlertState(cfg, entry.id)
          const today = await accountDay(prisma, account.id)
          // Expired: announce once per expiry date (not daily forever).
          // Approaching: at most once a day.
          const alreadySent = expired ? state.expiredFor === expiresKey : state.expiryWarnDay === today

          if (withinWindow && !isSnoozed && !alreadySent) {
            let didNotify = false
            if (hasNotifyChannel) {
              const daysText = expired
                ? `expired ${Math.abs(Math.round(daysUntilExpiry))} day(s) ago`
                : `expires in ${Math.round(daysUntilExpiry)} day(s)`
              await notify(notifyCfg, {
                title: `⏰ ${entry.name} ${expired ? 'has expired' : 'expiring soon'}`,
                message: `${entry.provider || entry.category}: ${daysText}`,
                tags: ['hourglass'],
                entryId: entry.id,
                actionLabel: 'Rotate now',
              }, { prisma, accountId: account.id })
              didNotify = true
            }

            // This condition stays true on every pass until the credential is
            // rotated, so the rule relies on the same once-a-day / once-ever
            // bookkeeping as the notification - otherwise a 6h monitor would
            // fire it four times a day.
            let didFire = false
            try {
              const { emitAutomationEvent } = require('./automation/engine')
              const { fired } = await emitAutomationEvent(prisma, account.id, 'vault.expiring', {
                entryName: entry.name,
                entryId: entry.id,
                category: entry.category,
                daysLeft: Math.round(daysUntilExpiry),
              })
              didFire = fired > 0
            } catch { /* emit never throws; guarding the require itself */ }

            if (didNotify || didFire) {
              await patchAlertState(prisma, account.id, entry.id, expired ? { expiredFor: expiresKey } : { expiryWarnDay: today })
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[VaultMonitor] Run failed:', err.message)
  }
}

function scheduleVaultMonitor({ prisma, decrypt, getAccountId }) {
  if (vaultTimer) {
    clearInterval(vaultTimer)
    vaultTimer = null
  }

  const intervalHours = isDebugMode ? (1 / 60) : DEFAULT_INTERVAL_HOURS // debug: every minute
  const intervalMs = intervalHours * 60 * 60 * 1000

  // Run once shortly after boot, then on the interval
  setTimeout(() => runVaultChecks({ prisma, decrypt, getAccountId }), 30 * 1000)
  vaultTimer = setInterval(() => runVaultChecks({ prisma, decrypt, getAccountId }), intervalMs)
  console.log(`[VaultMonitor] Scheduled every ${intervalHours}h`)
}

module.exports = { scheduleVaultMonitor, runVaultChecks, raiseCheckFailed }
