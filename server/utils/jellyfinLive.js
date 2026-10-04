// What people signed in to a Jellyfin-compatible server are playing right now.
//
// The Jellyfin provider reads the server's own sessions list on every library
// read (the activity monitor's one-minute pass), already turned into
// SlickSync's ids, and leaves the result here. Now Playing reads it the same
// way it reads utils/watchState.js liveViewings(); the activity monitor
// announces the viewings that are new since the last pass.
//
// Kept in memory only: a viewing is "now", and after a restart the next pass
// fills it again within a minute.

// A pass is every minute; a viewing not seen again within this long is over.
const STALE_MS = 150 * 1000

const byUser = new Map() // slicksync userId -> { at, viewings: [...] }
const startedAt = new Map() // `${userId}|${videoKey}` -> ms the viewing was first seen
const pendingStarts = [] // { userId, viewing } not yet announced

function videoKey(v) {
  return v.videoId || v.itemId
}

function recordLive(userId, viewings) {
  if (!userId) return
  const now = Date.now()
  const previous = byUser.get(userId)
  const previousKeys = new Set((previous && now - previous.at < STALE_MS ? previous.viewings : []).map(videoKey))
  for (const v of viewings) {
    const key = `${userId}|${videoKey(v)}`
    if (!startedAt.has(key)) startedAt.set(key, now)
    if (!previousKeys.has(videoKey(v)) && !v.paused) pendingStarts.push({ userId, viewing: v, at: now })
  }
  // Forget start times of viewings that ended, so a rewatch tomorrow is new.
  const live = new Set(viewings.map((v) => `${userId}|${videoKey(v)}`))
  for (const key of startedAt.keys()) {
    if (key.startsWith(`${userId}|`) && !live.has(key)) startedAt.delete(key)
  }
  byUser.set(userId, { at: now, viewings })
}

/** The same shape as watchState.liveViewings(), for Now Playing. */
function liveViewings(userIds = null) {
  const now = Date.now()
  const out = []
  for (const [userId, entry] of byUser) {
    if (userIds && !userIds.includes(userId)) continue
    if (now - entry.at > STALE_MS) continue
    for (const v of entry.viewings) {
      out.push({
        userId,
        itemId: v.itemId,
        itemType: v.itemType,
        videoId: v.videoId,
        itemName: v.itemName,
        poster: v.poster,
        season: v.season ?? null,
        episode: v.episode ?? null,
        startedAt: new Date(startedAt.get(`${userId}|${videoKey(v)}`) || entry.at),
        // Where it was at the last pass, moved on by the time since unless paused.
        positionMs: v.paused ? v.positionMs : Math.min(v.positionMs + (now - entry.at), v.durationMs || Infinity),
        durationMs: v.durationMs,
        paused: v.paused === true,
        device: v.device ? { name: v.device.name || null, client: v.device.client || null } : null,
      })
    }
  }
  return out
}

/** Viewings that started since the last call, for the "started watching" notification. */
function drainStarts() {
  // A start nobody announced within a few passes is no longer news.
  const cutoff = Date.now() - 5 * 60 * 1000
  return pendingStarts.splice(0, pendingStarts.length).filter((s) => s.at >= cutoff)
}

/**
 * Announce the viewings of this account's people that started since the last
 * pass, and refresh open Now Playing panels when anything changed.
 */
async function announceStarts(prisma, accountId, users) {
  const byId = new Map(users.map((u) => [u.id, u]))
  const mine = []
  const others = []
  for (const start of drainStarts()) (byId.has(start.userId) ? mine : others).push(start)
  pendingStarts.push(...others)
  if (mine.length === 0) return
  try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch { /* optional */ }
  const { announceViewingStart } = require('./startNotifyDedupe')
  for (const { userId, viewing } of mine) {
    const user = byId.get(userId)
    await announceViewingStart(prisma, { ...user, accountId: user.accountId || accountId }, {
      itemId: viewing.itemId,
      itemType: viewing.itemType,
      videoId: viewing.videoId,
      season: viewing.season,
      episode: viewing.episode,
      title: viewing.itemName,
      poster: viewing.poster,
    }).catch((e) => console.warn('[JellyfinLive] start announcement failed:', e?.message))
  }
}

// --- New devices -------------------------------------------------------------
// The devices each person has been seen playing on, kept with the account's
// settings (sync.jellyfinDevices[userId]). A device not seen before raises the
// same "new device" notification the AIOStreams proxy does - the first time a
// person is seen at all, what they're on is just remembered, so turning this
// on doesn't announce every device anyone already uses.
const MAX_DEVICES = 50

async function noteDevices(prisma, accountId, users) {
  const now = Date.now()
  const seenNow = []
  for (const u of users) {
    const entry = byUser.get(u.id)
    if (!entry || now - entry.at > STALE_MS) continue
    for (const v of entry.viewings) {
      if (v.device && (v.device.id || v.device.name)) seenNow.push({ user: u, device: v.device })
    }
  }
  if (!seenNow.length) return
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  if (!cfg || typeof cfg !== 'object') cfg = {}
  const all = cfg.jellyfinDevices && typeof cfg.jellyfinDevices === 'object' ? cfg.jellyfinDevices : {}
  const announce = []
  let changed = false
  for (const { user, device } of seenNow) {
    const key = String(device.id || device.name)
    const list = Array.isArray(all[user.id]) ? all[user.id] : null
    if (list && list.some((d) => d.key === key)) continue
    const first = !list
    all[user.id] = [...(list || []), { key, name: device.name || null, client: device.client || null, firstSeen: new Date(now).toISOString() }].slice(-MAX_DEVICES)
    changed = true
    if (!first) announce.push({ user, device })
  }
  if (!changed) return
  const next = { ...cfg, jellyfinDevices: all }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
  for (const { user, device } of announce) {
    try {
      const what = [device.name, device.client].filter(Boolean).join(' · ') || 'a device'
      await require('./pushNotifications').notifyPushForType(prisma, accountId, 'notifyOnNewDevice', {
        title: '📱 New device',
        body: `${user.username || 'Someone'} started watching on ${what}, which they haven't used before - worth checking if that's expected.`,
        icon: '/android-chrome-192x192.png',
        url: `/users/${user.id}`,
      })
    } catch {}
  }
}

function forgetUser(userId) {
  byUser.delete(userId)
  for (const key of startedAt.keys()) if (key.startsWith(`${userId}|`)) startedAt.delete(key)
}

module.exports = { recordLive, liveViewings, drainStarts, announceStarts, noteDevices, forgetUser, STALE_MS }
