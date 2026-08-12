// Seasonal addon auto-scheduling - flips Addon.isActive to match a
// year-agnostic recurring MM-DD window (e.g. a Halloween addon: active
// Oct 1 - Nov 1 every year, no need to remember to toggle it by hand).
// Same daily-tick pattern as catalogAutoRefresh.js. Manually toggling
// isActive outside the window still works in the moment - the next tick
// just corrects it back, since the schedule is the source of truth for a
// scheduled addon, same as autoRefresh already is for a Catalog.

const { resolveAccountTimezone, getAccountMonthDay } = require('./dateUtils')

let scheduleTimer = null
const INTERVAL_HOURS = 6 // more frequent than catalogAutoRefresh's 24h - a
  // window boundary should flip within hours of midnight, not up to a day late

function toMonthDay(month, day) {
  return month * 100 + day
}

/**
 * Is `{month, day}` inside the recurring window [start, end)? end is
 * exclusive - "enable Dec 1, disable Jan 1" means active through Dec 31,
 * off from Jan 1 onward. start > end (by MM-DD ordering) wraps the year
 * boundary (e.g. 12-01 -> 01-01 spans New Year's). start === end is an
 * empty window (never active) - a degenerate config, not a real schedule.
 */
function isWithinSeasonalWindow(month, day, startMonth, startDay, endMonth, endDay) {
  const current = toMonthDay(month, day)
  const start = toMonthDay(startMonth, startDay)
  const end = toMonthDay(endMonth, endDay)
  if (start === end) return false
  if (start < end) return current >= start && current < end
  return current >= start || current < end // wraps the year boundary
}

async function runAddonScheduler(prisma) {
  try {
    const addons = await prisma.addon.findMany({
      where: {
        scheduleEnabled: true,
        scheduleStartMonth: { not: null }, scheduleStartDay: { not: null },
        scheduleEndMonth: { not: null }, scheduleEndDay: { not: null },
      },
      select: { id: true, name: true, accountId: true, isActive: true, scheduleStartMonth: true, scheduleStartDay: true, scheduleEndMonth: true, scheduleEndDay: true },
    })
    if (addons.length === 0) return

    const timezoneByAccount = new Map()
    let flipped = 0
    for (const addon of addons) {
      try {
        const accountId = addon.accountId || 'default'
        if (!timezoneByAccount.has(accountId)) {
          timezoneByAccount.set(accountId, await resolveAccountTimezone(prisma, accountId))
        }
        const timezone = timezoneByAccount.get(accountId)
        const { month, day } = getAccountMonthDay(new Date(), timezone)
        const shouldBeActive = isWithinSeasonalWindow(month, day, addon.scheduleStartMonth, addon.scheduleStartDay, addon.scheduleEndMonth, addon.scheduleEndDay)

        if (shouldBeActive !== addon.isActive) {
          await prisma.addon.update({ where: { id: addon.id }, data: { isActive: shouldBeActive } })
          flipped++
          console.log(`[AddonScheduler] ${shouldBeActive ? 'Enabled' : 'Disabled'} "${addon.name}" (seasonal window)`)
        }
      } catch (err) {
        console.warn(`[AddonScheduler] Failed for addon ${addon.id} (${addon.name}):`, err?.message || err)
      }
    }
    if (flipped > 0) console.log(`[AddonScheduler] ${flipped}/${addons.length} scheduled addon(s) flipped`)
  } catch (err) {
    console.warn('[AddonScheduler] Run failed:', err?.message || err)
  }
}

function scheduleAddonScheduler(prisma) {
  if (scheduleTimer) {
    clearInterval(scheduleTimer)
    scheduleTimer = null
  }
  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000
  setTimeout(() => runAddonScheduler(prisma), 100 * 1000) // staggered past other boot-time schedulers
  scheduleTimer = setInterval(() => runAddonScheduler(prisma), intervalMs)
  console.log(`[AddonScheduler] Scheduled every ${INTERVAL_HOURS}h`)
}

module.exports = { scheduleAddonScheduler, runAddonScheduler, isWithinSeasonalWindow }
