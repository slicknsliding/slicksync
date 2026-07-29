// Notification digest mode: an opt-in, per-account alternative to instant
// notifications. When AppAccount.sync.notifyDigestEnabled is true, the four
// existing notify call sites (episode alerts, sync, vault, addon health)
// queue a short summary line here instead of sending immediately. A
// periodic poller batches everything since the last send into ONE message
// on the chosen cadence (daily/weekly) and delivers that instead.
//
// Push (native web-push) + the in-app notification bell are the PRIMARY
// channels here - a digest still sends push even with no Discord webhook
// configured at all. Discord is secondary: posted too, but only if a
// webhook is actually set. This mirrors the broader priority going forward
// (push/bell first, Discord as an optional extra), not just this feature.
//
// When digest mode is off (the default), none of this runs - every call
// site's existing instant-send behavior is completely unchanged.

const { postDiscord } = require('./notify')
const { sendPushToAccount } = require('./pushNotifications')

const CATEGORY_LABELS = {
  episode: '📺 New Episodes',
  sync: '🔄 Syncs',
  vault: '🔐 Vault',
  addon_health: '🧩 Addon Health',
}

const MAX_LINES_PER_CATEGORY = 10

function parseSyncConfig(rawSync) {
  let cfg = rawSync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return cfg || {}
}

async function isDigestEnabled(prisma, accountId) {
  try {
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    return parseSyncConfig(account?.sync)?.notifyDigestEnabled === true
  } catch {
    return false
  }
}

/** Called instead of an instant send when digest mode is on. */
async function queueDigestEntry(prisma, accountId, category, summary) {
  try {
    await prisma.notificationDigestEntry.create({ data: { accountId, category, summary } })
  } catch (e) {
    console.warn('[NotificationDigest] Failed to queue entry:', e?.message)
  }
}

/** Persists AppAccount.sync the same dual-shape way syncScheduler.js does (Postgres Json column vs SQLite String). */
async function persistSyncConfig(prisma, accountId, nextCfg) {
  try {
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: nextCfg } })
  } catch {
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(nextCfg) } }).catch(() => {})
  }
}

/** Checks every account; sends + clears the digest for any that are due. */
async function sendDueDigests(prisma) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  for (const account of accounts) {
    try {
      const cfg = parseSyncConfig(account.sync)
      if (cfg.notifyDigestEnabled !== true) continue

      const frequency = cfg.notifyDigestFrequency === 'weekly' ? 'weekly' : 'daily'
      const intervalMs = (frequency === 'weekly' ? 7 : 1) * 24 * 60 * 60 * 1000
      const lastSentAt = cfg.notifyDigestLastSentAt ? new Date(cfg.notifyDigestLastSentAt) : null
      if (lastSentAt && Date.now() - lastSentAt.getTime() < intervalMs) continue

      const entries = await prisma.notificationDigestEntry.findMany({
        where: { accountId: account.id, ...(lastSentAt ? { createdAt: { gt: lastSentAt } } : {}) },
        orderBy: { createdAt: 'asc' },
      })

      // Nothing happened this period - still advance lastSentAt below so the
      // next check doesn't re-scan the same empty window, but don't send a
      // pointless "nothing happened" notification.
      if (entries.length > 0) {
        const byCategory = new Map()
        for (const e of entries) {
          if (!byCategory.has(e.category)) byCategory.set(e.category, [])
          byCategory.get(e.category).push(e.summary)
        }
        const cadenceLabel = frequency === 'weekly' ? 'Weekly' : 'Daily'

        // Push + bell (primary) - one condensed line, Discord gets the full
        // per-item breakdown since it has room for it.
        const pushSummary = [...byCategory.entries()]
          .map(([category, summaries]) => `${summaries.length} ${(CATEGORY_LABELS[category] || category).replace(/^\S+\s/, '')}`)
          .join(' · ')
        await sendPushToAccount(prisma, account.id, {
          title: `SlickSync ${cadenceLabel} Digest`,
          body: pushSummary,
          icon: '/android-chrome-192x192.png',
          url: '/activity',
        }).catch(() => {})

        // Discord (secondary) - only if a webhook is actually configured.
        if (cfg.webhookUrl) {
          const lines = [`**SlickSync ${cadenceLabel} Digest**`]
          for (const [category, summaries] of byCategory) {
            lines.push(`\n**${CATEGORY_LABELS[category] || category}** (${summaries.length})`)
            for (const s of summaries.slice(0, MAX_LINES_PER_CATEGORY)) lines.push(`• ${s}`)
            if (summaries.length > MAX_LINES_PER_CATEGORY) lines.push(`…and ${summaries.length - MAX_LINES_PER_CATEGORY} more`)
          }
          await postDiscord(cfg.webhookUrl, lines.join('\n')).catch(() => {})
        }

        await prisma.notificationDigestEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } })
      }

      await persistSyncConfig(prisma, account.id, { ...cfg, notifyDigestLastSentAt: new Date().toISOString() })
    } catch (e) {
      console.warn(`[NotificationDigest] Failed processing account ${account.id}:`, e?.message)
    }
  }
}

const POLL_INTERVAL_MS = 60 * 60 * 1000 // hourly - cheap, the interval math above gates the actual send
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000

function scheduleNotificationDigest(prisma) {
  const run = () => sendDueDigests(prisma).catch((e) => console.warn('[NotificationDigest] Poll failed:', e?.message))
  setTimeout(run, FIRST_RUN_DELAY_MS)
  setInterval(run, POLL_INTERVAL_MS)
}

module.exports = { isDigestEnabled, queueDigestEntry, sendDueDigests, scheduleNotificationDigest }
