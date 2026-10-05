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
 * - A Jellyfin-compatible server (Jellyfin, AIOStreams, AIOMetadata) that is
 *   down for everyone signed in to it is ONE outage, not one per person:
 *   when everyone on that server is failing with a connection issue and the
 *   server doesn't answer its public /System/Info/Public either, a single
 *   "Can't reach <server>" goes out, and a single "back up" when it returns.
 *   A rejected sign-in stays per person - only that person can fix it.
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

// A server outage is keyed by the server and the start of the outage, like a
// person's; recovery finds it by the server prefix since each person on the
// server noticed the outage a poll apart.
function serverOutagePrefix(serverKey) {
  return `connection-server-${serverKey}-`
}

function isConnectionIssue(message) {
  return /^Connection issue:/i.test(message || '')
}

function serverKeyOf(person) {
  return require('./jellyfinServerCollections').serverKeyOf(person)
}

/** Whether the server answers its public, no-sign-in info route. */
async function serverAnswers(url) {
  try {
    const { jfRequest } = require('../providers/jellyfinAuth')
    const info = await jfRequest(url, '/System/Info/Public', { timeoutMs: 5000 })
    return !!info && typeof info === 'object'
  } catch {
    return false
  }
}

/**
 * Everyone on `user`'s Jellyfin-compatible server, when ALL of them are
 * failing with a connection issue right now - else null. Reads the rows the
 * pass has already written, so a person this pass hasn't reached yet counts
 * by the failure recorded on the previous pass.
 */
async function everyoneOnServerFailing(prisma, accountId, user) {
  if (user.providerType !== 'jellyfin' || !user.jellyfinServerUrl) return null
  const key = serverKeyOf(user)
  if (!key) return null
  const people = (await prisma.user.findMany({
    where: { accountId, isActive: true, providerType: 'jellyfin', jellyfinToken: { not: null } },
    select: { id: true, username: true, jellyfinServerUrl: true, jellyfinServerId: true, jellyfinServerKind: true, providerConnectionError: true, providerConnectionErrorAt: true },
  })).filter((p) => serverKeyOf(p) === key)
  if (!people.some((p) => p.id === user.id)) return null
  if (!people.every((p) => isConnectionIssue(p.providerConnectionError) && p.providerConnectionErrorAt)) return null
  return { key, people }
}

function serverName(user) {
  try {
    const { displayServer } = require('../providers/jellyfinAuth')
    return displayServer(user.jellyfinServerUrl) || user.jellyfinServerUrl
  } catch {
    return user.jellyfinServerUrl
  }
}

function names(people) {
  const list = people.map((p) => p.username || 'Someone')
  if (list.length <= 3) return list.join(', ').replace(/, ([^,]*)$/, ' and $1')
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} others`
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
 * `probe` checks whether a server answers (tests pass their own).
 */
async function onConnectionFailed(prisma, accountId, user, message, since, now = Date.now(), { probe = serverAnswers } = {}) {
  try {
    if (!accountId || !user?.id || !since || user.__recordAs) return false
    const needsReconnect = /^Reconnect needed:/i.test(message || '')
    const lastedLongEnough = !!user.providerConnectionError && now - new Date(since).getTime() >= SETTLE_MS
    if (!needsReconnect && !lastedLongEnough) return false

    const dedupeKey = outageKey(user.id, since)
    if (await alreadySent(prisma, accountId, dedupeKey)) return false
    const cfg = await readConfig(prisma, accountId)
    if (cfg.notifyOnConnectionHealth === false) return false

    // The whole server down: one alert for everyone on it.
    if (!needsReconnect) {
      const server = await everyoneOnServerFailing(prisma, accountId, user).catch(() => null)
      if (server) {
        const prefix = serverOutagePrefix(server.key)
        if (await openServerOutage(prisma, accountId, prefix)) return false
        if (!(await probe(user.jellyfinServerUrl))) {
          const start = Math.min(...server.people.map((p) => new Date(p.providerConnectionErrorAt).getTime()))
          const label = providerLabel(user)
          await send(prisma, accountId, {
            title: `Can't reach the ${label} server ${serverName(user)}`,
            body: `It has been down for over ${Math.round(SETTLE_MS / 60000)} minutes. Watching isn't being tracked for ${names(server.people)} until it's back.`,
            dedupeKey: `${prefix}${start}`,
          })
          return true
        }
        // It answers - so it isn't the server; each person is told as before.
      }
    }

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

// The newest announced outage of this server that has no "back up" yet, or null.
async function openServerOutage(prisma, accountId, prefix) {
  const row = await prisma.notification.findFirst({
    where: { accountId, dedupeKey: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
    select: { dedupeKey: true },
  }).catch(() => null)
  if (!row || row.dedupeKey.endsWith('-ok')) return null
  return row.dedupeKey
}

/** After a successful live fetch for a person who had a recorded failure. */
async function onConnectionRecovered(prisma, accountId, user) {
  try {
    if (!accountId || !user?.id || !user.providerConnectionErrorAt || user.__recordAs) return false

    // The first person back on a server that was announced down says the
    // server is back; everyone after them stays quiet.
    if (user.providerType === 'jellyfin' && user.jellyfinServerUrl) {
      const key = serverKeyOf(user)
      const open = key ? await openServerOutage(prisma, accountId, serverOutagePrefix(key)) : null
      if (open) {
        const cfg = await readConfig(prisma, accountId)
        if (cfg.notifyOnConnectionHealth === false) return false
        await send(prisma, accountId, {
          title: `The ${providerLabel(user)} server ${serverName(user)} is back`,
          body: 'Watching is being tracked again for everyone on it.',
          dedupeKey: `${open}-ok`,
        })
        return true
      }
    }

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

module.exports = { onConnectionFailed, onConnectionRecovered, outageKey, serverOutagePrefix, SETTLE_MS }
