// What SlickSync itself wrote into a person's Stremio or Nuvio library (Copy
// watch history, Keep in step). Such a write carries the source's real watch
// date and a new position, which the watch tracking would otherwise read as
// someone playing it right now.
//
// An item counts as ours only while it still looks exactly as we left it:
// Stremio's _mtime (every real save moves it), Nuvio's last-watched time and
// position (playback moves both). The first real playback afterwards makes it
// differ, so it is never held back. Dates in the history are untouched.
//
// Kept in memory: after a restart the next copy pass or the item's own age
// takes over, as for any other library item.

const REMEMBER_MS = 24 * 60 * 60 * 1000

const written = new Map() // `${userId}:${itemId}` -> { mtime?, lastWatched?, position?, at }

const keyOf = (userId, itemId) => `${userId}:${itemId}`
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v || ''))

/** own: [{ id, mtime }] (Stremio) or [{ id, lastWatched, position }] (Nuvio). */
function note(userId, own, now = Date.now()) {
  if (!userId || !Array.isArray(own)) return
  for (const [key, w] of written) if (now - w.at > REMEMBER_MS) written.delete(key)
  for (const o of own) {
    if (!o?.id) continue
    written.set(keyOf(userId, o.id), { mtime: o.mtime != null ? ms(o.mtime) : null, lastWatched: o.lastWatched != null ? ms(o.lastWatched) : null, position: o.position ?? null, at: now })
  }
}

/** True while the library item is exactly what SlickSync wrote. */
function isOwn(userId, itemId, item) {
  const w = written.get(keyOf(userId, itemId))
  if (!w) return false
  if (w.mtime != null) return ms(item?._mtime) === w.mtime
  return w.lastWatched != null && ms(item?.state?.lastWatched) === w.lastWatched && Math.round(Number(item?.state?.timeOffset)) === Math.round(Number(w.position))
}

function forget() { written.clear() }

module.exports = { note, isOwn, forget }
