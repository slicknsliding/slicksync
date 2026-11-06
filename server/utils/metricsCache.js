// Simple in-memory cache for precomputed metrics, keyed by account + period
// This is populated periodically (every 5 minutes) by the activity monitor
// and read by both /users/metrics and /ext/metrics.json routes.

const metricsCache = new Map()
// A little longer than the 5-minute background rebuild, so an entry is
// replaced before it expires instead of expiring just before - which left a
// window every few minutes where a visit paid for a full rebuild itself.
const METRICS_TTL_MS = 7 * 60 * 1000

// Which periods anyone has actually looked at, and when. The background
// precompute rebuilds every period it is told to, whether or not a person
// has ever opened it - and the long ones are where the time goes: measured
// on two years of history, all nine periods cost 3.9 seconds per account
// per pass, of which the four longest were 3.6. Recording a read here lets
// that pass rebuild what is being used and leave the rest to be built on
// demand, which is what already happens on a cache miss anyway.
const lastRequested = new Map() // `${accountId}::${period}` -> timestamp

function noteRequested(accountId, period) {
  lastRequested.set(makeKey(accountId, period), Date.now())
}

/** Periods read for this account within the window, newest interest first. */
function recentlyRequestedPeriods(accountId, windowMs) {
  const prefix = `${accountId || 'default'}::`
  const cutoff = Date.now() - windowMs
  const hits = []
  for (const [key, at] of lastRequested) {
    if (!key.startsWith(prefix)) continue
    if (at < cutoff) { lastRequested.delete(key); continue }
    hits.push({ period: key.slice(prefix.length), at })
  }
  return hits.sort((a, b) => b.at - a.at).map((h) => h.period)
}

function makeKey(accountId, period) {
  return `${accountId || 'default'}::${period || '30d'}`
}

/**
 * Get cached metrics for an account and period.
 * Returns the cached object or null if not present.
 */
function getCachedMetrics(accountId, period) {
  const key = makeKey(accountId, period)
  // Counts as interest whether or not it hits - a miss is exactly the case
  // worth keeping warm next time.
  noteRequested(accountId, period)
  const entry = metricsCache.get(key)
  if (!entry) return null

  // Expire stale entries so metrics stay reasonably fresh
  const age = Date.now() - entry.updatedAt
  if (age > METRICS_TTL_MS) {
    metricsCache.delete(key)
    return null
  }

  return entry.data
}

/**
 * Set cached metrics for an account and period.
 */
function setCachedMetrics(accountId, period, data) {
  const key = makeKey(accountId, period)
  metricsCache.set(key, {
    data,
    updatedAt: Date.now()
  })
}

/** When the cached build was made, or null. Changes only when the feed is rebuilt. */
function getMetricsStamp(accountId, period) {
  const entry = metricsCache.get(makeKey(accountId, period))
  return entry && Date.now() - entry.updatedAt <= METRICS_TTL_MS ? entry.updatedAt : null
}

// Builds already under way, so several tabs opening the dashboard at once
// share one build instead of running one each.
const building = new Map()
function buildOnce(accountId, period, build) {
  const key = makeKey(accountId, period)
  if (building.has(key)) return building.get(key)
  const promise = Promise.resolve().then(build).finally(() => building.delete(key))
  building.set(key, promise)
  return promise
}

/**
 * Clear all cached metrics for a given account.
 */
function clearMetricsForAccount(accountId) {
  const prefix = `${accountId || 'default'}::`
  for (const key of metricsCache.keys()) {
    if (key.startsWith(prefix)) {
      metricsCache.delete(key)
    }
  }
}

module.exports = {
  getCachedMetrics,
  setCachedMetrics,
  buildOnce,
  getMetricsStamp,
  clearMetricsForAccount,
  noteRequested,
  recentlyRequestedPeriods
}











