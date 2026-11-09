// What Stremio's saves to the account say about playback, with no addon.
//
// Measured on a real app (2026-11-02), reading the library every 15 seconds:
//
//  - while playing it saves every 90 seconds (stremio-core's development branch
//    says 180, so an app can differ, and a slower timer has to work too);
//  - pausing saves at once, within about a second of the player's clock;
//  - pressing play saves at once, under half a second past the pause;
//  - nothing saves while paused (about 15 minutes watched);
//  - closing a video past 90% of it (stremio-core's CREDITS_THRESHOLD_COEF) puts
//    the position back to 0, and so does marking it watched - nothing else does,
//    so 0 is always the end, however far in the save before it was;
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
const REMEMBER_MS = 24 * 60 * 60 * 1000
// Opening a title saves at once with state.lastWatched set to that same moment;
// a save this close to lastWatched is the opening one.
const OPEN_MATCH_MS = 5 * 1000

const ownWrites = require('./ownWrites')

const records = new Map() // `${userId}:${itemId}` -> record

// Nothing else removes a record, so one not looked at for REMEMBER_MS goes.
const SWEEP_EVERY_MS = 10 * 60 * 1000
let lastSweep = 0
function sweep(now) {
  if (now - lastSweep < SWEEP_EVERY_MS) return
  lastSweep = now
  for (const [key, record] of records) {
    if (now - record.checkedAt > REMEMBER_MS) records.delete(key)
  }
}

const keyOf = (userId, itemId) => `${userId}:${itemId}`

function readItem(item) {
  const offset = Number(item?.state?.timeOffset ?? NaN)
  const mtime = Date.parse(item?._mtime || '')
  if (!Number.isFinite(offset) || !Number.isFinite(mtime)) return null
  return { offset, mtime, videoId: item?.state?.video_id || null, openedAt: Date.parse(item?.state?.lastWatched || '') }
}

/** Pause or play, from a save and the one before it. Pure. */
function classify(prev, cur) {
  const gap = cur.mtime - prev.mtime
  const moved = cur.offset - prev.offset
  if (cur.offset <= 1) return { paused: false, ended: true, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
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

/**
 * The save made by opening the title (or another episode of it) a moment ago:
 * playback starts there. Without this a first sight only set the baseline, and
 * an episode opened at 0 read as one that had ended, so a stream someone had
 * just started showed as stopped until the timer's first save, 90 s in.
 */
function justOpened(cur, prev, now) {
  if (!Number.isFinite(cur.openedAt) || Math.abs(cur.mtime - cur.openedAt) > OPEN_MATCH_MS) return false
  if (now - cur.mtime > SILENT_MS) return false
  return !prev || !(cur.openedAt <= prev.openedAt)
}

/** Takes in a library item as it was just read. True when it holds a new save. */
function observe(userId, itemId, item, now = Date.now()) {
  sweep(now)
  const cur = readItem(item)
  if (!cur) return false
  const key = keyOf(userId, itemId)
  const prev = records.get(key)
  if (!prev) {
    // Whole libraries pass through here every minute; only what was touched
    // lately is worth remembering.
    if (now - cur.mtime > REMEMBER_MS) return false
    // A first sight is where things stood, not something that just happened -
    // unless it is the save from opening it just now.
    const opened = justOpened(cur, null, now) && !ownWrites.isOwn(userId, itemId, item)
    records.set(key, { ...cur, checkedAt: now, seenAt: opened ? now : null, paused: false, ended: false, timerMs: null, timerSeen: false })
    return opened
  }
  prev.checkedAt = now
  // SlickSync's own write (a copy) is not a save: the baseline moves to it so
  // the next real save is measured from there, and nothing is seen.
  if (ownWrites.isOwn(userId, itemId, item)) {
    records.set(key, { ...prev, ...cur, checkedAt: now })
    return false
  }
  if (cur.mtime === prev.mtime || (cur.offset === prev.offset && cur.videoId === prev.videoId)) return false
  // An episode that ends moves the title on to the next one at position 0 or 1,
  // whether or not anyone plays it, so that says nothing until the position moves.
  const next = justOpened(cur, prev, now)
    ? { paused: false, ended: false, timerMs: prev.timerMs, timerSeen: prev.timerSeen }
    : cur.videoId !== prev.videoId
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

function forget() { records.clear(); lastSweep = 0 }

module.exports = { observe, viewing, lastSaveAt, classify, forget, SILENT_MS }
