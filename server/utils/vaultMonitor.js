// Periodically runs active-checks on vault entries and notifies (ntfy/Discord) when:
//   - an entry is within its notifyDaysBefore window of expiresAt (throttled to once/day)
//   - an automated check flips from ok -> error (throttled to once/day per entry)

const { runCheck } = require('./vaultCheckers')
const { postDiscord } = require('./notify')
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

async function notify({ discordWebhookUrl }, { title, message, entryId }, ctx) {
  if (discordWebhookUrl) {
    const fixNowUrl = entryId ? getFixNowUrl(entryId) : null
    const text = fixNowUrl ? `**${title}**\n${message}\n\nFix now: ${fixNowUrl}` : `**${title}**\n${message}`
    await postDiscord(discordWebhookUrl, text)
  }
  // Mirror to phone push (self-gates on notifyOnVault). Independent of Discord,
  // so vault alerts reach an installed PWA even with no webhook configured.
  if (ctx?.prisma && ctx?.accountId) {
    await notifyPushForType(ctx.prisma, ctx.accountId, 'notifyOnVault', {
      title,
      body: message,
      icon: '/android-chrome-192x192.png',
      url: entryId ? `/vault?edit=${entryId}` : '/vault',
    })
  }
}

function wasNotifiedToday(lastNotifiedAt) {
  if (!lastNotifiedAt) return false
  const now = new Date()
  const last = new Date(lastNotifiedAt)
  return now.toDateString() === last.toDateString()
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

            // Notify on ok -> error transition (not on first-ever check, and throttled to once/day)
            if (wasOk && !nowOk && hasNotifyChannel && !wasNotifiedToday(entry.lastNotifiedAt)) {
              await notify(notifyCfg, {
                title: `⚠️ ${entry.name} check failed`,
                message: `${entry.provider || entry.category}: ${result.message || 'Check failed'}`,
                tags: ['warning'],
                entryId: entry.id,
              }, { prisma, accountId: account.id })
              await prisma.vaultEntry.update({ where: { id: entry.id }, data: { lastNotifiedAt: new Date() } })
            }
          } catch (err) {
            console.error(`[VaultMonitor] Check failed for entry ${entry.id}:`, err.message)
          }
        }

        // 2) Expiry warning, independent of the check above
        if (entry.expiresAt && hasNotifyChannel) {
          const msUntilExpiry = new Date(entry.expiresAt).getTime() - Date.now()
          const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24)
          const withinWindow = daysUntilExpiry <= (entry.notifyDaysBefore ?? 3)

          if (withinWindow && !wasNotifiedToday(entry.lastNotifiedAt)) {
            const daysText = daysUntilExpiry < 0
              ? `expired ${Math.abs(Math.round(daysUntilExpiry))} day(s) ago`
              : `expires in ${Math.round(daysUntilExpiry)} day(s)`
            await notify(notifyCfg, {
              title: `⏰ ${entry.name} ${daysUntilExpiry < 0 ? 'has expired' : 'expiring soon'}`,
              message: `${entry.provider || entry.category}: ${daysText}`,
              tags: ['hourglass'],
              entryId: entry.id,
            }, { prisma, accountId: account.id })
            await prisma.vaultEntry.update({ where: { id: entry.id }, data: { lastNotifiedAt: new Date() } })
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

module.exports = { scheduleVaultMonitor, runVaultChecks }
