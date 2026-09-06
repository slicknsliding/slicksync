/**
 * Poster pre-warming.
 *
 * The moment the server hands a page its list of titles, it knows exactly
 * which posters that page is about to ask for. Producing them right then,
 * in the background, means the browser's requests a beat later are disk
 * reads instead of fetches and encodes - the grid fills at once rather
 * than poster by poster. Sizes match what the cards actually request: 342
 * for desktop and the pass-through case, 185 for phones.
 *
 * Strictly best-effort and deliberately gentle: two at a time, a bounded
 * queue, and a source+width that was queued in the last ten minutes is not
 * queued again, so a page that re-fetches its data every few seconds does
 * not turn into a fetch storm against the poster CDN.
 */
const { warm } = require('./imageCacheCore')

const WIDTHS = [342, 185]
const CONCURRENCY = 2
const MAX_QUEUE = 400
const RECENT_TTL_MS = 10 * 60 * 1000

const queue = []
const recent = new Map()
let active = 0

function eligible(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && !/\.(gif|svg)(\?|$)/i.test(url)
}

function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()
    active += 1
    warm(job.url, job.w)
      .catch(() => { /* optimisation only - a miss just costs the request a fetch */ })
      .finally(() => { active -= 1; pump() })
  }
}

/**
 * Queue the posters of a list of items (anything with a `poster` string,
 * or plain URL strings) for warming.
 */
function warmPosters(items, { widths = WIDTHS } = {}) {
  if (!Array.isArray(items) || items.length === 0) return 0
  const now = Date.now()
  let queued = 0
  for (const item of items) {
    const url = typeof item === 'string' ? item : item?.poster
    if (!eligible(url)) continue
    for (const w of widths) {
      const k = `${url}|${w}`
      const seen = recent.get(k)
      if (seen && now - seen < RECENT_TTL_MS) continue
      recent.set(k, now)
      if (queue.length >= MAX_QUEUE) break
      queue.push({ url, w })
      queued += 1
    }
  }
  if (recent.size > 5000) {
    for (const [k, t] of recent) if (now - t > RECENT_TTL_MS) recent.delete(k)
  }
  if (queued > 0) pump()
  return queued
}

module.exports = { warmPosters }
