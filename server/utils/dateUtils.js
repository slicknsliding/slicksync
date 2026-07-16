// Shared "what calendar day is it right now" helper.
//
// Date.prototype.toISOString() is always UTC, with no way to opt out - every
// spot that used `new Date().toISOString().split('T')[0]` to decide "today"
// was actually asking "what's today in UTC", not "what's today for the
// person using this app". Background pollers (metricsProcessor.js,
// proxyStreamMonitor.js) have no per-request viewer context to auto-detect
// a browser timezone from - they run on a timer, not in response to a page
// load - so "today" has to be a stored, admin-configurable setting instead
// (AppAccount.sync.accountTimezone, set from the Settings page), not
// something inferred per-request. Client-side displays that DO have a
// browser (the Activity feed's Today/Yesterday headers) already use the
// viewer's local time natively and need no equivalent fix.
const DEFAULT_TIMEZONE = process.env.ACCOUNT_TIMEZONE || 'America/Los_Angeles'

const formatterCache = new Map()

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      // Invalid/unrecognized IANA zone name - fall back rather than throw,
      // since this runs deep inside background pollers with no user to
      // show a validation error to.
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Returns the YYYY-MM-DD calendar-day string for `date` (default: now) in
 * `timeZone` (default: DEFAULT_TIMEZONE), for use as a stable day-bucket key
 * (e.g. WatchActivity.date, EpisodeWatchHistory grouping).
 * @param {Date} [date]
 * @param {string} [timeZone]
 * @returns {string}
 */
function getAccountDateString(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return formatterFor(timeZone).format(date)
}

// Short-lived per-account cache so a poll cycle that touches many
// users/items doesn't hit the DB for the same account's timezone setting
// over and over - the setting changes rarely (an admin editing Settings),
// so a little staleness here is fine.
const timezoneCache = new Map() // accountId -> { value, expiresAt }
const TIMEZONE_CACHE_MS = 60 * 1000

/**
 * Resolves the configured timezone for an account (AppAccount.sync.
 * accountTimezone), falling back to DEFAULT_TIMEZONE if unset/invalid.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} accountId
 * @returns {Promise<string>}
 */
async function resolveAccountTimezone(prisma, accountId) {
  const id = accountId || 'default'
  const cached = timezoneCache.get(id)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value = DEFAULT_TIMEZONE
  try {
    const account = await prisma.appAccount.findFirst({ where: { id }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (cfg && typeof cfg.accountTimezone === 'string' && cfg.accountTimezone.trim()) {
      value = cfg.accountTimezone.trim()
    }
  } catch {
    // DB unavailable or malformed config - use the default rather than
    // blocking whatever background job called this.
  }

  timezoneCache.set(id, { value, expiresAt: Date.now() + TIMEZONE_CACHE_MS })
  return value
}

module.exports = { getAccountDateString, resolveAccountTimezone, DEFAULT_TIMEZONE }
