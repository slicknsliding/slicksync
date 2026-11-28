// Date math for Vault entries that renew on a schedule (monthly or yearly).
//
// Everything is in UTC and keeps the day of the month the date started on:
// Jan 31 monthly goes Feb 28, then Mar 31 again (each step is counted from the
// original date, so a short month never drags the later ones down with it).

const DAY_MS = 24 * 60 * 60 * 1000

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** `date` moved forward by whole calendar months, same day of month, clamped to the month's last day. */
function addMonths(date, months) {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months
  const year = Math.floor(total / 12)
  const month = total - year * 12
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month))
  return new Date(Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
}

function monthsPerCycle(cycle) {
  return cycle === 'yearly' ? 12 : cycle === 'monthly' ? 1 : null
}

/**
 * The first renewal date after `now`: `expiresAt` plus whole months (monthly)
 * or years (yearly), as many as it takes. A date already in the future is
 * returned as it is.
 */
function nextRenewal(expiresAt, cycle, now = new Date()) {
  const step = monthsPerCycle(cycle)
  if (!step) throw new Error('cycle must be monthly or yearly')
  const start = new Date(expiresAt)
  if (isNaN(start.getTime())) throw new Error('expiresAt must be a valid date')
  if (start.getTime() > now.getTime()) return start
  // Start close to the answer (a date years behind would otherwise loop for a
  // long time), then walk the last steps exactly.
  const behindMonths = Math.floor((now.getTime() - start.getTime()) / (31 * DAY_MS))
  let k = Math.max(1, Math.floor(behindMonths / step) - 1)
  let next = addMonths(start, k * step)
  while (next.getTime() <= now.getTime()) {
    k += 1
    next = addMonths(start, k * step)
  }
  return next
}

/** One period after the later of `expiresAt` and `now` - what "I renewed it" means. */
function renewedFrom(expiresAt, cycle, now = new Date()) {
  const step = monthsPerCycle(cycle)
  if (!step) throw new Error('cycle must be monthly or yearly')
  const current = new Date(expiresAt)
  const base = current.getTime() > now.getTime() ? current : now
  return addMonths(base, step)
}

module.exports = { nextRenewal, renewedFrom, addMonths }
