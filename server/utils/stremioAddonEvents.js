// Stremio's own playback and library events, received as a SlickTrax addon.
//
// Recent Stremio tells every addon that declares the `player` and `library`
// resources what the person is doing (stremio-core, models/common/addon_events.rs):
//
//   GET /player/{type}/{videoId}/action=start|pause|stop&currentTime=<ms>&duration=<ms>.json
//   GET /library/{type}/{id}/action=libraryAdd|libraryRemove|watched|unwatched[&videoId=a,b].json
//
// "start" is sent when playback begins, resumes after a pause and after a seek
// while playing; "pause" on pause and seek-while-paused; "stop" when the player
// is closed or the video ends. The times are the player's real position and the
// video's real length, not estimates. Errors from the addon are ignored by
// Stremio, and only addons whose manifest matches the type and id prefix are
// asked.
//
// What this does and does not do follows CLAUDE.md "Watch tracking: two signals,
// one job each". These are a live signal, so they feed Now Playing and the
// instant "started watching" - nothing else:
//
//  - No WatchSession is written from here: sessionTracker closes any session
//    it cannot find in the provider library within a minute.
//  - No WatchActivity either. Stremio's library already records Stremio viewing
//    (the native poll turns its overallTimeWatched into watch time); adding the
//    player's time on top would count every minute twice. AIOStreams' Watch
//    State writes WatchActivity only because its Jellyfin clients have no
//    library to read.
//  - The playback position lives in the same WatchStateCursor AIOStreams'
//    Watch State uses, read back by watchState.liveViewings().
//  - A library event only asks for the person's library to be read now
//    (debounced); the read is the ordinary native one and is the record.

const watchState = require('./watchState')

// Full resource objects (not bare names) so they carry their own types and id
// prefixes: Stremio only asks an addon about a type and id it declares.
const EVENT_RESOURCES = ['player', 'library'].map((name) => ({ name, types: ['movie', 'series'], idPrefixes: ['tt'] }))

// Playback events.
const PLAYER_ACTIONS = new Set(['start', 'pause', 'stop'])
// Library events.
const LIBRARY_ACTIONS = new Set(['libraryAdd', 'libraryRemove', 'watched', 'unwatched'])

// A burst of marks (a whole season marked watched is sent in chunks) makes one read.
const LIBRARY_READ_DELAY_MS = 5000
const timing = { readDelayMs: LIBRARY_READ_DELAY_MS } // adjustable by tests

// Same limits liveViewings() applies to a cursor, so a viewing is "the same
// one" here exactly while Now Playing would still show it.
const LIVE_GRACE_MS = 10 * 60 * 1000
const LIVE_MAX_NO_DURATION_MS = 4 * 60 * 60 * 1000
const STALE_CURSOR_MS = 2 * 24 * 60 * 60 * 1000
const INT_MAX = 2147483647

// What the player events last said about a person's title, in memory:
//  'live'  - Stremio's own events are feeding Now Playing for it, so its real
//            position replaces the library's lagging checkpoint;
//  'ended' - Stremio said it stopped, so the library's "still active" echo of
//            it (held for ~18 minutes) must not keep it on Now Playing.
// Lost on a restart, which only goes back to the library-only behaviour.
const LIVE_MARK_MS = 6 * 60 * 60 * 1000
const ENDED_MARK_MS = 25 * 60 * 1000
const marks = new Map() // `${userId}:${itemId}` -> { state, until }

function setMark(userId, itemId, state) {
  const now = Date.now()
  if (marks.size > 1000) for (const [k, m] of marks) if (m.until <= now) marks.delete(k)
  marks.set(`${userId}:${itemId}`, { state, until: now + (state === 'live' ? LIVE_MARK_MS : ENDED_MARK_MS) })
}

/** 'live', 'ended' or null: what Stremio's player events last said about this title for this person. */
function stremioMark(userId, itemId) {
  const key = `${userId}:${itemId}`
  const m = marks.get(key)
  if (!m) return null
  if (m.until <= Date.now()) { marks.delete(key); return null }
  return m.state
}

// ---------------------------------------------------------------------------
// Parsing

/** `action=start&currentTime=1000&duration=5000` (Express has already decoded the path). */
function parseExtra(extra) {
  const params = new URLSearchParams(String(extra || ''))
  const ms = (name) => {
    const n = Math.round(Number(params.get(name)))
    return Number.isFinite(n) && n > 0 ? Math.min(n, INT_MAX) : 0
  }
  return {
    action: params.get('action') || null,
    currentTime: ms('currentTime'),
    duration: ms('duration'),
    videoIds: (params.get('videoId') || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

/**
 * The title a player event is about. The path id is the VIDEO id: `tt1` for a
 * film, `tt1:2:3` for season 2 episode 3. Only IMDb ids are accepted (the
 * manifest asks for no others).
 */
function parseVideo(type, videoId) {
  const parts = String(videoId || '').split(':')
  const itemId = parts[0]
  if (!/^tt\d+$/.test(itemId)) return null
  if (type === 'movie') return { itemId, itemType: 'movie', videoId: itemId, season: null, episode: null }
  if (type !== 'series') return null
  const season = Number(parts[1])
  const episode = Number(parts[2])
  if (parts.length < 3 || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) return null
  return { itemId, itemType: 'series', videoId: `${itemId}:${season}:${episode}`, season, episode }
}

// ---------------------------------------------------------------------------
// Player

function emitNowPlaying(accountId) {
  try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch { /* optional */ }
}

/** Is a remembered cursor still a viewing Now Playing would show? */
function stillOneViewing(cursor, now) {
  if (!cursor) return false
  if (!cursor.startAt) return now - new Date(cursor.updatedAt).getTime() <= watchState.PAUSED_KEEP_MS
  const remaining = cursor.durationMs
    ? Math.max(0, cursor.durationMs - (cursor.startPositionMs || 0)) + LIVE_GRACE_MS
    : LIVE_MAX_NO_DURATION_MS
  return now <= new Date(cursor.startAt).getTime() + remaining
}

/**
 * Apply one player event for a person. Returns what it did ('start', 'pause',
 * 'stop') or null when the request was not a playback event for a title this
 * can use - which is still answered 200, since Stremio ignores the answer.
 */
async function applyPlayerEvent(prisma, user, type, videoIdParam, extra) {
  const ev = parseExtra(extra)
  if (!PLAYER_ACTIONS.has(ev.action)) return null
  const video = parseVideo(type, videoIdParam)
  if (!video) return null

  const accountId = user.accountId || 'default'
  const where = { accountId_userId_videoId: { accountId, userId: user.id, videoId: video.videoId } }
  const now = Date.now()
  let before = await prisma.watchStateCursor.findUnique({ where })

  if (ev.action === 'stop') {
    if (before) await prisma.watchStateCursor.delete({ where }).catch(() => {})
    setMark(user.id, video.itemId, 'ended')
    emitNowPlaying(accountId)
    return 'stop'
  }

  // A cursor from a viewing that was never stopped (the app was killed) is not
  // this one: start afresh, so the card's start time and the announcement are right.
  if (before && !stillOneViewing(before, now)) {
    await prisma.watchStateCursor.delete({ where }).catch(() => {})
    before = null
  }
  prisma.watchStateCursor.deleteMany({ where: { userId: user.id, updatedAt: { lt: new Date(now - STALE_CURSOR_MS) } } }).catch(() => {})

  const playing = ev.action === 'start'
  const live = {
    itemId: video.itemId,
    itemType: video.itemType,
    // The player's own position, kept on a pause too so the paused card shows it.
    startPositionMs: ev.currentTime,
    startAt: playing ? new Date(now) : null,
    durationMs: ev.duration > 0 ? ev.duration : before?.durationMs ?? null,
    season: video.season ?? before?.season ?? null,
    episode: video.episode ?? before?.episode ?? null,
  }
  await prisma.watchStateCursor.upsert({
    where,
    create: { accountId, userId: user.id, videoId: video.videoId, ...live },
    update: live,
  })
  setMark(user.id, video.itemId, 'live')

  // Naming the title can take a metadata lookup, which Stremio is not kept
  // waiting for. Only a fresh start is announced (a resume or a seek is the
  // same viewing); announceStart claims through startNotifyDedupe, so the proxy,
  // a Jellyfin session and the library read cannot announce it again.
  if (!before || !before.itemName) {
    setImmediate(() => {
      watchState.announceStart(prisma, user, where, { itemId: video.itemId, itemType: video.itemType, videoId: video.videoId, season: video.season, episode: video.episode }, playing && !before)
        .catch((e) => console.warn('[StremioEvents] start follow-up failed:', e?.message))
    })
  } else {
    emitNowPlaying(accountId)
  }
  return ev.action
}

// ---------------------------------------------------------------------------
// Library

/** The library action of a request, or null for one this does not know. */
function parseLibraryAction(extra) {
  const { action } = parseExtra(extra)
  return LIBRARY_ACTIONS.has(action) ? action : null
}

const pendingReads = new Map() // userId -> timer

function defaultRead(user) {
  return require('./activityMonitor').checkActivityForUser(user.accountId || 'default', user.id)
}

/**
 * Read this person's library soon, once for however many events arrive in the
 * next few seconds. That read is the ordinary native one (activityMonitor
 * checkActivityForUser) and is what records anything; the event itself is
 * only the reason to look now rather than at the next minute's tick.
 * `opts.delayMs` and `opts.read` exist for tests.
 */
function scheduleLibraryRead(user, opts = {}) {
  if (pendingReads.has(user.id)) return false
  const read = opts.read || defaultRead
  const timer = setTimeout(() => {
    pendingReads.delete(user.id)
    Promise.resolve()
      .then(() => read(user))
      .catch((e) => console.warn('[StremioEvents] library read failed:', e?.message))
  }, opts.delayMs ?? timing.readDelayMs)
  if (typeof timer.unref === 'function') timer.unref()
  pendingReads.set(user.id, timer)
  return true
}

/**
 * The same events arriving at the stream gate (utils/streamGate.js), where
 * `resourcePath` is still as sent: `player/series/tt1%3A2%3A3/action=start...json`.
 */
async function applyEventPath(prisma, user, resourcePath) {
  let parts
  try { parts = String(resourcePath).split('/').map(decodeURIComponent) } catch { return null }
  if (parts.length !== 4 || !parts[3].endsWith('.json')) return null
  const [resource, type, id] = parts
  const extra = parts[3].slice(0, -'.json'.length)
  if (resource === 'player') return applyPlayerEvent(prisma, user, type, id, extra)
  if (resource === 'library' && parseLibraryAction(extra)) scheduleLibraryRead(user)
  return null
}

module.exports = {
  EVENT_RESOURCES,
  applyEventPath,
  PLAYER_ACTIONS,
  LIBRARY_ACTIONS,
  LIBRARY_READ_DELAY_MS,
  timing,
  stremioMark,
  parseExtra,
  parseVideo,
  parseLibraryAction,
  applyPlayerEvent,
  scheduleLibraryRead,
  // For tests.
  _resetForTests() { marks.clear(); for (const t of pendingReads.values()) clearTimeout(t); pendingReads.clear() },
}
