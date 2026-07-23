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

const monthFormatterCache = new Map()

function monthFormatterFor(timeZone) {
  let formatter = monthFormatterCache.get(timeZone)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit' })
    }
    monthFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Returns the YYYY-MM calendar-month string for `date` in `timeZone` - the
 * month equivalent of getAccountDateString, for the poster-mosaic monthly
 * digest ("has this account already gotten this month's recap"). Built from
 * formatToParts rather than trusting the formatter's own string ordering,
 * since Intl's locale-formatted output isn't guaranteed YYYY-MM shaped even
 * with 'en-CA'.
 * @param {Date} [date]
 * @param {string} [timeZone]
 * @returns {string}
 */
function getAccountMonthString(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = monthFormatterFor(timeZone).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  return `${parts.year}-${parts.month}`
}

/**
 * Converts a wall-clock date/time as experienced in `timeZone` into the
 * actual UTC instant it represents. Standard "guess, then correct by the
 * observed offset" double-conversion - there's no timezone-database library
 * in this project's server dependencies, and this needs no more precision
 * than "which side of midnight" for a monthly digest.
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(guess)).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  )
  return new Date(guess + (guess - asIfUtc))
}

/**
 * Start (inclusive) and end (exclusive) UTC instants for calendar month
 * `yearMonth` ("YYYY-MM") as experienced in `timeZone` - for querying
 * MovieWatchHistory/EpisodeWatchHistory.watchedAt by "which account-local
 * month did this happen in", the same account-timezone rule day-bucketing
 * already follows.
 * @param {string} yearMonth
 * @param {string} [timeZone]
 * @returns {{ start: Date, end: Date }}
 */
function monthBoundsInTimezone(yearMonth, timeZone = DEFAULT_TIMEZONE) {
  const [y, m] = yearMonth.split('-').map(Number)
  const start = zonedWallTimeToUtc(y, m, 1, 0, 0, 0, timeZone)
  const nextYear = m === 12 ? y + 1 : y
  const nextMonth = m === 12 ? 1 : m + 1
  const end = zonedWallTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, timeZone)
  return { start, end }
}

/**
 * The "YYYY-MM" immediately before `yearMonth` - used to find "the month
 * that just finished" relative to the account's current month.
 * @param {string} yearMonth
 * @returns {string}
 */
function previousMonthString(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number)
  const prevYear = m === 1 ? y - 1 : y
  const prevMonth = m === 1 ? 12 : m - 1
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`
}

module.exports = {
  getAccountDateString,
  resolveAccountTimezone,
  DEFAULT_TIMEZONE,
  getAccountMonthString,
  monthBoundsInTimezone,
  previousMonthString,
}
