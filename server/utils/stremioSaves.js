// What Stremio's saves to the account say about playback, with no addon.
//
// Measured on a real app (2026-11-02), reading the library every 15 seconds:
//
//  - while playing it saves every 90 seconds (stremio-core's development branch
//    says 180, so an app can differ, and a slower timer has to work too);
//  - pausing saves at once, within about a second of the player's clock;
//  - pressing play saves at once, under half a second past the pause;
//  - nothing saves while paused (about 15 minutes watched);
//  - a video that ends goes back to position 0;
//  - state.lastWatched stays at the moment the title was opened, through all of
//    the above. Only _mtime moves, and it is the exact save time.
//
// So a save's timing says what happened. Only a change of position counts as a
// save: _mtime alone also moves when a title is added or a library is copied,
// which is why the rest of tracking does not read it. Nothing here adds to
// watch time.
//
// Kept in memory. A restart forgets it and goes back to the library's freshness
// window until the next save, at most a timer's length later.

// Stremio's own numbers, seen at the end of a real episode: the position goes to
// 0 and state.video_id to the next episode, ten seconds apart or in one save.

// Moved less than this since the last save: play was just pressed.
const RESUME_MOVED_MS = 3000
// Anything this far after the last save is the timer, not a pause.
const TIMER_MIN_GAP_MS = 85 * 1000
// How far a position can differ from the time passed and still be plain playing.
const PLAYED_SLACK_MS = 10 * 1000
// With a timer seen, no save for this long means paused. Above a 180-second timer.
const SILENT_MS = 200 * 1000
// A device clock this far from ours is not used to time anything shown.
const CLOCK_TRUST_MS = 2 * 60 * 1000
// Back to 0 from this far in is the end of the video, not someone rewinding.
const ENDED_FROM_RATIO = 0.9
const REMEMBER_MS = 24 * 60 * 60 * 1000

const records = new Map() // `${userId}:${itemId}` -> record

const keyOf = (userId, itemId) => `${userId}:${itemId}`

function readItem(item) {
  const offset = Number(item?.state?.timeOffset ?? NaN)
  const mtime = Date.parse(item?._mtime || '')
  if (!Number.isFinite(offset) || !Number.isFinite(mtime)) return null
  const duration = Number(item?.state?.duration ?? NaN)
  return { offset, mtime, duration: Number.isFinite(duration) && duration > 0 ? duration : null, videoId: item?.state?.video_id || null }
}

/** Pause or play, from a save and the one before it. Pure. */
function classify(prev, cur) {
  const gap = cur.mtime - prev.mtime
  const moved = cur.offset - prev.offset
  if (cur.offset <= 0) {
    const fromEnd = prev.offset > 0 && (!cur.duration || prev.offset >= cur.duration * ENDED_FROM_RATIO)
    return { paused: false, ended: fromEnd, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
  }
  const played = Math.abs(moved - gap) <= PLAYED_SLACK_MS
  if (Math.abs(moved) < RESUME_MOVED_MS) return { paused: false, ended: false, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
  if (gap >= TIMER_MIN_GAP_MS) return { paused: false, ended: false, timerMs: prev.timerMs, timerSeen: prev.timerSeen || played }
  if (played) {
    if (prev.ended) return { paused: false, ended: false, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
    // It played on from a "pause" with no save for pressing play, so that was
    // this app's timer, shorter than the one measured.
    if (prev.paused) return { paused: false, ended: false, timerMs: gap, timerSeen: true }
    if (prev.timerMs && gap >= prev.timerMs - RESUME_MOVED_MS) return { paused: false, ended: false, timerMs: prev.timerMs, timerSeen: true }
    return { paused: true, ended: false, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
  }
  // A seek: says nothing about pause or play.
  return { paused: prev.paused, ended: prev.ended, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
}

/** Takes in a library item as it was just read. True when it holds a new save. */
function observe(userId, itemId, item, now = Date.now()) {
  const cur = readItem(item)
  if (!cur) return false
  const key = keyOf(userId, itemId)
  const prev = records.get(key)
  if (!prev) {
    // Whole libraries pass through here every minute; only what was touched
    // lately is worth remembering.
    if (now - cur.mtime > REMEMBER_MS) return false
    // A first sight is where things stood, not something that just happened.
    records.set(key, { ...cur, checkedAt: now, seenAt: null, paused: false, ended: false, timerMs: null, timerSeen: false })
    return false
  }
  prev.checkedAt = now
  if (cur.mtime === prev.mtime || (cur.offset === prev.offset && cur.videoId === prev.videoId)) return false
  // An episode that ends moves the title on to the next one at position 0 or 1,
  // whether or not anyone plays it, so that says nothing until the position moves.
  const next = cur.videoId !== prev.videoId
    ? { paused: false, ended: cur.offset <= 1, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
    : classify(prev, cur)
  records.set(key, { ...cur, ...next, checkedAt: now, seenAt: now })
  return true
}

/** When the last real save was made, by our clock where theirs is off, or null. */
function savedAt(record, now) {
  if (!record?.seenAt) return null
  return Math.abs(record.mtime - record.seenAt) <= CLOCK_TRUST_MS ? Math.min(record.mtime, now) : record.seenAt
}

/** The moment of this person's last real save of a title, or null. */
function lastSaveAt(userId, itemId, now = Date.now()) {
  return savedAt(records.get(keyOf(userId, itemId)), now)
}

/**
 * What the saves say about a viewing, or null when they say nothing yet (no
 * save seen, or another episode). No timer seen means an app whose saves can't
 * be read for this, so going quiet is not called a pause.
 */
function viewing(userId, itemId, videoId, now = Date.now()) {
  const record = records.get(keyOf(userId, itemId))
  const at = savedAt(record, now)
  if (at == null) return null
  if (videoId && record.videoId && videoId !== record.videoId) return null
  const quiet = record.timerSeen && record.checkedAt - record.seenAt > SILENT_MS
  return {
    positionMs: record.offset,
    savedAt: at,
    checkedAt: record.checkedAt,
    ended: record.ended,
    paused: !record.ended && (record.paused || quiet),
  }
}

function forget() { records.clear() }

module.exports = { observe, viewing, lastSaveAt, classify, forget, SILENT_MS }
