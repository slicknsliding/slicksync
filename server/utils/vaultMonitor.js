// Periodically runs active-checks on vault entries and notifies (ntfy/Discord) when:
//   - an entry is within its notifyDaysBefore window of expiresAt (throttled to once/day)
//   - an automated check flips from ok -> error (throttled to once/day per entry)

const { runCheck } = require('./vaultCheckers')
const { postDiscord, postNtfy } = require('./notify')

let vaultTimer = null
const DEFAULT_INTERVAL_HOURS = 6
const isDebugMode = process.env.DEBUG === 'true' || process.env.DEBUG === '1'

function getNotifyConfig(cfg) {
  return {
    enabled: cfg?.vaultNotifyEnabled !== false,
    ntfyUrl: cfg?.vaultNtfyUrl || null,
    ntfyTopic: cfg?.vaultNtfyTopic || null,
    discordWebhookUrl: cfg?.vaultDiscordWebhookUrl || null,
  }
}

async function notify({ ntfyUrl, ntfyTopic, discordWebhookUrl }, { title, message, tags }) {
  if (ntfyUrl && ntfyTopic) {
    await postNtfy(ntfyUrl, ntfyTopic, { title, message, tags, priority: 'high' })
  }
  if (discordWebhookUrl) {
    await postDiscord(discordWebhookUrl, `**${title}**\n${message}`)
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
      const hasNotifyChannel = notifyCfg.enabled && ((notifyCfg.ntfyUrl && notifyCfg.ntfyTopic) || notifyCfg.discordWebhookUrl)

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
              })
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
            })
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
