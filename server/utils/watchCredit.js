/*
 * HOW MUCH VIEWING A MOVE OF THE PLAYBACK POSITION IS WORTH.
 *
 * A provider reports where playback stands, not time spent. Adding up every
 * forward move counted two things that are not viewing (confirmed real case:
 * 56m on the card for a film that had 28 minutes played that day):
 *
 *   - a skip ahead: the last six minutes of credits jumped in one move;
 *   - ground already covered: a second device, open and paused at an older
 *     spot, saved that spot, and the climb back to where the film really
 *     stood was counted as 22 minutes of watching.
 *
 * So a move is worth only what lies past the furthest point this viewing has
 * reached, and never more than the real time since the position last moved.
 * The same two rules the per-day record follows (metricsProcessor.js).
 *
 * The furthest point and the time of the last move are kept here, per open
 * session. After a restart they are not known: the furthest point falls back
 * to the session's last position, and one move goes uncapped.
 */
const SLACK_SECONDS = 60
const open = new Map() // sessionId -> { savedAt: ms, highest: ms of position }

const ms = (value) => (value == null || Number.isNaN(Number(value)) ? null : Number(value))

/** A session was opened (or reopened) at `position`, saved at `savedAtMs`. */
function begin(sessionId, { position, savedAtMs, alreadyReached = null }) {
  const at = ms(position)
  const reached = ms(alreadyReached)
  open.set(sessionId, {
    savedAt: ms(savedAtMs),
    highest: Math.max(at ?? 0, reached ?? 0),
  })
}

/**
 * Seconds of viewing for a session whose position is now `currentPosition`.
 * session: { id, startTime, startPosition, lastPosition } as last written.
 * savedAtMs: when the provider says the position was saved, if it says.
 */
function credit(session, currentPosition, savedAtMs, nowMs = Date.now()) {
  const current = ms(currentPosition)
  const previous = ms(session.lastPosition) ?? ms(session.startPosition)
  if (current === null || previous === null) return 0

  const known = open.get(session.id)
  const highest = Math.max(previous, known?.highest ?? previous)
  let seconds = Math.max(0, Math.floor((current - highest) / 1000))

  // When the previous position was saved. Not known after a restart unless
  // the position has not moved since the session opened.
  let previousAt = known?.savedAt ?? null
  if (previousAt === null && !known && (ms(session.lastPosition) === null || ms(session.lastPosition) === ms(session.startPosition))) {
    previousAt = session.startTime instanceof Date ? session.startTime.getTime() : null
  }
  // The provider's own save time when it is usable, else now: some providers
  // keep the time a title was opened and never move it.
  const saved = ms(savedAtMs)
  const at = saved !== null && saved <= nowMs && (previousAt === null || saved > previousAt) ? saved : nowMs
  if (previousAt !== null) {
    seconds = Math.min(seconds, Math.max(0, Math.floor((at - previousAt) / 1000)) + SLACK_SECONDS)
  }

  if (current !== previous) {
    open.set(session.id, { savedAt: at, highest: Math.max(highest, current) })
  } else if (!known) {
    // First look after a restart, nothing moved: keep the provider's own
    // save time if it gave one, never "now" - the position is older than that.
    open.set(session.id, { savedAt: previousAt ?? (saved !== null && saved <= nowMs ? saved : null), highest })
  }
  return seconds
}

function end(sessionId) {
  open.delete(sessionId)
}

module.exports = { begin, credit, end, SLACK_SECONDS, forgetForTests: () => open.clear() }
