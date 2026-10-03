// How an account wants viewing judged: where "finished" starts, and how long
// a started show sits untouched before it is offered on the Unfinished shelf.
// Stored on AppAccount.sync.watchTracking, read through a short cache the
// way the account timezone is, since the history poller asks every minute.

const DEFAULTS = Object.freeze({ finishedPercent: 90, unfinishedAfterDays: 45 })
const LIMITS = Object.freeze({
  finishedPercent: [70, 99],
  unfinishedAfterDays: [7, 365],
})
const CACHE_MS = 60 * 1000
const cache = new Map() // accountId -> { value, expiresAt }

function clamp(value, [lo, hi], fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** The stored block, cleaned up, with defaults for anything missing. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    finishedPercent: clamp(r.finishedPercent, LIMITS.finishedPercent, DEFAULTS.finishedPercent),
    unfinishedAfterDays: clamp(r.unfinishedAfterDays, LIMITS.unfinishedAfterDays, DEFAULTS.unfinishedAfterDays),
  }
}

async function getWatchSettings(prisma, accountId) {
  const id = accountId || 'default'
  const hit = cache.get(id)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  let value = { ...DEFAULTS }
  try {
    const account = await prisma.appAccount.findFirst({ where: { id }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    value = normalize(cfg?.watchTracking)
  } catch {
    // A failed read uses the defaults rather than stalling the poller.
  }
  cache.set(id, { value, expiresAt: Date.now() + CACHE_MS })
  return value
}

function clearWatchSettings(accountId) {
  cache.delete(accountId || 'default')
}

module.exports = { getWatchSettings, clearWatchSettings, normalize, DEFAULTS, LIMITS }
