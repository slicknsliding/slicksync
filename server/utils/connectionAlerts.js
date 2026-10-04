/**
 * Bell + push when a person's provider connection breaks and stays broken,
 * and again when it heals.
 *
 * The activity monitor already records the failure on the person
 * (providerConnectionError, shown as a badge on People) - but nobody was
 * told, so a sign-in could sit broken for days with only a badge to find.
 *
 * - A sign-in that was rejected ("Reconnect needed") is told about at once:
 *   it will not fix itself.
 * - Anything else (server down, timeout) is told about only once it has
 *   lasted SETTLE_MS, so a blip between two polls stays quiet.
 * - One alert per outage: the dedupe key is the outage's start time, which
 *   recordConnectionError keeps fixed until the connection recovers.
 * - "Connected again" only follows an outage that was actually announced.
 *
 * On by default (notifyOnConnectionHealth !== false), like key health: a
 * broken sign-in silently stops watch tracking for that person, so finding
 * out should not be something to discover and opt into first.
 */

const SETTLE_MS = 15 * 60 * 1000
const ICON = '/android-chrome-192x192.png'

function outageKey(userId, since) {
  return `connection-${userId}-${new Date(since).getTime()}`
}

function providerLabel(user) {
  if (user.providerType === 'nuvio') return 'Nuvio'
  if (user.providerType === 'jellyfin') {
    if (user.jellyfinServerKind === 'aiostreams') return 'AIOStreams'
    if (user.jellyfinServerKind === 'aiometadata') return 'AIOMetadata'
    return 'Jellyfin'
  }
  return 'Stremio'
}

async function readConfig(prisma, accountId) {
  const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = account?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return cfg && typeof cfg === 'object' ? cfg : {}
}

async function alreadySent(prisma, accountId, dedupeKey) {
  const row = await prisma.notification.findUnique({
    where: { accountId_dedupeKey: { accountId, dedupeKey } },
    select: { id: true },
  }).catch(() => null)
  return !!row
}

async function send(prisma, accountId, { title, body, dedupeKey }) {
  const { createNotification } = require('./notificationStore')
  await createNotification(prisma, accountId, { type: 'sync', title, body, url: '/users', dedupeKey })

  // Digest on: it goes in the digest instead of an immediate push, the
  // same as addon health. The bell row above is written either way.
  try {
    const { isDigestEnabled, queueDigestEntry } = require('./notificationDigest')
    if (await isDigestEnabled(prisma, accountId)) {
      await queueDigestEntry(prisma, accountId, 'connection', `${title} — ${body}`)
      return
    }
  } catch {}
  try {
    const { isPushEnabled, sendPushToAccount } = require('./pushNotifications')
    if (isPushEnabled()) await sendPushToAccount(prisma, accountId, { title, body, icon: ICON, url: '/users' })
  } catch {}
}

/**
 * After a failed live fetch. `user` is the person as read at the start of
 * the pass (so its providerConnectionError is the state BEFORE this
 * failure); `since` is when this outage started; `message` is what was
 * recorded, with its "Reconnect needed: " / "Connection issue: " prefix.
 */
async function onConnectionFailed(prisma, accountId, user, message, since, now = Date.now()) {
  try {
    if (!accountId || !user?.id || !since || user.__recordAs) return false
    const needsReconnect = /^Reconnect needed:/i.test(message || '')
    const lastedLongEnough = !!user.providerConnectionError && now - new Date(since).getTime() >= SETTLE_MS
    if (!needsReconnect && !lastedLongEnough) return false

    const dedupeKey = outageKey(user.id, since)
    if (await alreadySent(prisma, accountId, dedupeKey)) return false
    const cfg = await readConfig(prisma, accountId)
    if (cfg.notifyOnConnectionHealth === false) return false

    const name = user.username || 'Someone'
    const label = providerLabel(user)
    const detail = String(message || '').replace(/^(Reconnect needed|Connection issue):\s*/i, '').slice(0, 200)
    await send(prisma, accountId, needsReconnect
      ? {
          title: `${name} needs to reconnect ${label}`,
          body: `Their ${label} sign-in stopped working, so their watching isn't being tracked. Reconnect them from Users.`,
          dedupeKey,
        }
      : {
          title: `Can't reach ${name}'s ${label}`,
          body: `It has been failing for over ${Math.round(SETTLE_MS / 60000)} minutes${detail ? ` (${detail})` : ''}. Their watching isn't being tracked until it's back.`,
          dedupeKey,
        })
    return true
  } catch (e) {
    console.warn('[ConnectionAlerts] failure alert failed:', e?.message)
    return false
  }
}

/** After a successful live fetch for a person who had a recorded failure. */
async function onConnectionRecovered(prisma, accountId, user) {
  try {
    if (!accountId || !user?.id || !user.providerConnectionErrorAt || user.__recordAs) return false
    const failedKey = outageKey(user.id, user.providerConnectionErrorAt)
    // Nothing was announced (a blip, or alerts were off) - nothing to undo.
    if (!(await alreadySent(prisma, accountId, failedKey))) return false
    const dedupeKey = `${failedKey}-ok`
    if (await alreadySent(prisma, accountId, dedupeKey)) return false
    const cfg = await readConfig(prisma, accountId)
    if (cfg.notifyOnConnectionHealth === false) return false

    const name = user.username || 'Someone'
    await send(prisma, accountId, {
      title: `${name}'s ${providerLabel(user)} is connected again`,
      body: 'Their watching is being tracked again.',
      dedupeKey,
    })
    return true
  } catch (e) {
    console.warn('[ConnectionAlerts] recovery alert failed:', e?.message)
    return false
  }
}

module.exports = { onConnectionFailed, onConnectionRecovered, outageKey, SETTLE_MS }
