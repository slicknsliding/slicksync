// Now Playing: the title's runtime and the episode's name, and - when the app
// hasn't said where playback is (Nuvio until someone pauses, the AIOStreams
// proxy, which only sees the stream start) - an estimate of how far in, from
// when it started. Shown on the cards only: nothing here is ever saved, so
// watch history and watch time still come from what the apps report.
//
// Runtime comes from the metadata lookups notify.js already caches. Building
// Now Playing waits a second at most for a title not looked up yet
// (prepareEstimates), so the bar shows on the first refresh; a slower lookup
// carries on and the next refresh (8 s later) has it.

const { minutesOf } = require('./discoverFacets')

const FOUND_TTL_MS = 6 * 60 * 60 * 1000
const MISSING_TTL_MS = 10 * 60 * 1000
// An estimate stops short of the end: past it the guess is clearly wrong
// (a pause, a rewind), so the card shows no estimate rather than a full bar.
const STOP_RATIO = 0.97

const found = new Map() // key -> { at, runtimeMs, episodeTitle }
const looking = new Map() // key -> the lookup under way

const keyOf = (item, videoId) => `${item.id}|${item.type || ''}|${videoId || ''}`

function lookUp(item, videoId, fetchMetadata) {
  const key = keyOf(item, videoId)
  const hit = found.get(key)
  const fresh = hit && (Date.now() - hit.at) < (hit.runtimeMs || hit.episodeTitle ? FOUND_TTL_MS : MISSING_TTL_MS)
  if (fresh) return hit
  if (!looking.has(key)) {
    const type = item.type === 'movie' ? 'movie' : 'series'
    const lookup = Promise.resolve()
      .then(() => fetchMetadata(item.id, type, videoId || (item.season && item.episode ? `${String(item.id).split(':')[0]}:${item.season}:${item.episode}` : null)))
      .then((meta) => {
        const minutes = minutesOf({ runtime: meta?.runtime })
        found.set(key, { at: Date.now(), runtimeMs: minutes ? minutes * 60000 : null, episodeTitle: meta?.episode?.title || null })
      })
      .catch(() => found.set(key, { at: Date.now(), runtimeMs: null, episodeTitle: null }))
      .finally(() => looking.delete(key))
    looking.set(key, lookup)
  }
  return hit || null
}

/**
 * Starts the lookups the rows still need and waits for them, `waitMs` at most,
 * all at once - so a title someone just started has its bar straight away.
 */
async function prepareEstimates(rows, waitMs = 1000, fetchMetadata = require('./notify').fetchMetadata) {
  const pending = []
  for (const row of rows || []) {
    const item = row?.item
    if (!item?.id || item.titlePending) continue
    if (lookUp(item, row.videoId, fetchMetadata)) continue
    const lookup = looking.get(keyOf(item, row.videoId))
    if (lookup) pending.push(lookup)
  }
  if (!pending.length) return
  let timer
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs) }),
  ])
  clearTimeout(timer)
}

/**
 * Adds what's known to one Now Playing row, in place. `startedAt` is when the
 * stream began (ms). Never overrides a real position or length: the app's own
 * numbers always win, and an estimate is marked (`positionEstimated`,
 * `durationEstimated`) so the card can say so.
 */
function addEstimate(row, startedAt, now = Date.now(), fetchMetadata = require('./notify').fetchMetadata) {
  const item = row?.item
  // Only a title we're sure of: a stream still being identified gets nothing.
  if (!item?.id || item.titlePending) return row
  const meta = lookUp(item, row.videoId, fetchMetadata)
  if (!meta) return row
  if (meta.episodeTitle && item.type !== 'movie' && !item.episodeTitle) item.episodeTitle = meta.episodeTitle
  if (Number(row.totalDuration) > 0 || !meta.runtimeMs) return row
  const runtime = meta.runtimeMs
  if (typeof row.lastPosition === 'number') {
    // A real position without a length (some Jellyfin servers): only the length is a guess.
    if (row.lastPosition < runtime) {
      row.totalDuration = runtime
      row.durationEstimated = true
    }
    return row
  }
  if (row.paused || typeof startedAt !== 'number') return row
  const elapsed = now - startedAt
  if (elapsed <= 0 || elapsed >= runtime * STOP_RATIO) return row
  row.totalDuration = runtime
  row.lastPosition = elapsed
  row.positionAt = now
  row.durationEstimated = true
  row.positionEstimated = true
  return row
}

module.exports = { addEstimate, prepareEstimates, _forget: () => { found.clear(); looking.clear() } }
