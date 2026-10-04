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

function forgetUser(userId) {
  byUser.delete(userId)
  for (const key of startedAt.keys()) if (key.startsWith(`${userId}|`)) startedAt.delete(key)
}

module.exports = { recordLive, liveViewings, drainStarts, announceStarts, forgetUser, STALE_MS }
