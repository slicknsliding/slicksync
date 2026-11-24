/*
 * NO MORE VIEWING THAN THE TIME SINCE THE STREAM OPENED.
 *
 * Nuvio reports where playback stands when it pauses, seeks, ends or exits,
 * and never that play was pressed. The first save of a sitting therefore has
 * nothing to be measured from: open a film left at 59:00, skip to 80:00 and
 * pause, and the 21 minutes skipped looked like 21 minutes watched.
 *
 * AIOStreams knows when the stream opened. A jump in a title's position is
 * worth no more than the time since its stream first opened after the
 * position was last saved.
 *
 * "First opened", not "the stream open now": some players read in bursts and
 * AIOStreams closes the stream in between (confirmed real case: an hour of
 * viewing as fourteen 12-second streams five minutes apart). The start of the
 * latest one would have cut that hour to a minute. AIOStreams' own history
 * has every opening, so the earliest one since the last save is used.
 *
 * Measured to now, not to the save's own time: that time comes from the
 * device, and a device clock a few minutes off must not shorten anything.
 *
 * Never guessed: no stream found for the title and person, no history, or a
 * history that does not reach back far enough, and the figure is left as it
 * was.
 */
const { sameTitle } = require('./titleMatch')

const SLACK_SECONDS = 60
// Smaller jumps are not worth a look: the slack alone covers them.
const WORTH_CHECKING_SECONDS = 180
// A stream last read this soon after the previous save is that sitting's own
// tail (AIOStreams keeps reading a moment after the app saved), not a new one.
const TAIL_MS = 2 * 60 * 1000
// How far back a title with no earlier save is looked for.
const NEW_TITLE_LOOKBACK_MS = 24 * 60 * 60 * 1000

const key = (user, target) => `${user}\n${target}`

function rowIsFor(row, title, series) {
  return [row.displayName || row.filename, row.metadataName].some((name) => name && sameTitle(name, title, { series }))
}

/**
 * When a stream of `title` for one of `userIds` was first open after
 * `afterMs`, in ms, or null when that is not known.
 */
async function firstOpenedAfter(prisma, { accountId, userIds, title, series = false, users, afterMs, nowMs }, deps = {}) {
  if (!title || !Array.isArray(users) || users.length === 0 || !Number.isFinite(afterMs) || !(nowMs > afterMs)) return null
  // Required here, not at the top: proxyStreamMonitor requires sessionTracker.
  const monitor = require('./proxyStreamMonitor')
  const fetchHistory = deps.fetchHistory || monitor.fetchStreamHistory

  const rows = await prisma.proxyStreamSession.findMany({
    where: { accountId, lastSeenAt: { gte: new Date(afterMs) } },
    select: { aiostreamsUser: true, url: true, displayName: true, filename: true, metadataName: true, startTime: true, lastSeenAt: true },
  })
  const mine = rows.filter((row) => {
    if (!rowIsFor(row, title, series)) return false
    const person = monitor.resolveUserForActiveConnection(users, row.aiostreamsUser)
    return !!person && userIds.includes(person.id)
  })
  if (mine.length === 0) return null

  const history = await fetchHistory(accountId)
  if (!history) return null
  // More openings than were returned, and the ones returned do not reach back
  // to the last save: an earlier opening may be missing.
  const oldest = history.entries.reduce((min, e) => Math.min(min, e.startedAt), Infinity)
  if (history.total > history.entries.length && oldest > afterMs) return null

  const wanted = new Set(mine.map((row) => key(row.aiostreamsUser, row.url)))
  const openings = [
    // The stream as SlickSync last saw it: one still open may not be in the history yet.
    ...mine.map((row) => ({ startedAt: row.startTime.getTime(), lastSeenAt: row.lastSeenAt.getTime() })),
    ...history.entries.filter((e) => wanted.has(key(e.aiostreamsUser, e.targetKey))),
  ].filter((o) => o.lastSeenAt > afterMs + TAIL_MS && o.startedAt <= nowMs)
  if (openings.length === 0) return null
  return Math.min(...openings.map((o) => Math.max(o.startedAt, afterMs)))
}

/**
 * `seconds` of viewing, or fewer when the title's stream has not been open
 * that long. afterMs: when the position was last saved; null for a title with
 * no earlier save.
 */
async function limitToStreamStart(prisma, seconds, { afterMs = null, nowMs = Date.now(), ...rest }, deps = {}) {
  if (!(seconds > WORTH_CHECKING_SECONDS)) return seconds
  try {
    const after = afterMs === null ? nowMs - NEW_TITLE_LOOKBACK_MS : afterMs
    const openedAt = await firstOpenedAfter(prisma, { ...rest, afterMs: after, nowMs }, deps)
    if (openedAt === null) return seconds
    return Math.min(seconds, Math.max(0, Math.floor((nowMs - openedAt) / 1000)) + SLACK_SECONDS)
  } catch (error) {
    console.warn('[StreamStart] Lookup failed:', error.message)
    return seconds
  }
}

module.exports = { limitToStreamStart, firstOpenedAfter, SLACK_SECONDS, WORTH_CHECKING_SECONDS }
