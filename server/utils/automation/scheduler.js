// Ticks every minute checking for due `time.daily` automation rules - the
// one trigger type that fires on a schedule instead of in response to
// something happening elsewhere (see registry.js's own comment on why it's
// the only trigger with triggerConfigFields). Every other trigger type is
// emitted directly from wherever that thing happens; this file exists only
// because a schedule has no such "wherever" to hook into.

const { getAccountDateString, resolveAccountTimezone } = require('../dateUtils')
const { emitAutomationEvent } = require('./engine')

let tickTimer = null
const TICK_MS = 60 * 1000 // 1min - matches the minute-level precision "at HH:MM" needs
// Index = the value stored in triggerConfig.days, matching JS getDay()
// (0 = Sunday). Order must line up with Intl's 'short' weekday names.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

async function runAutomationScheduler(prisma) {
  try {
    const rules = await prisma.automationRule.findMany({
      where: { triggerType: 'time.daily', enabled: true },
    })
    if (rules.length === 0) return

    for (const rule of rules) {
      try {
        const config = parseJson(rule.triggerConfig, {})
        const hour = Number(config.hour)
        const minute = Number(config.minute)
        if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) continue

        const timezone = await resolveAccountTimezone(prisma, rule.accountId)
        const now = new Date()
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
        }).formatToParts(now)
        const currentHour = Number(parts.find((p) => p.type === 'hour')?.value)
        const currentMinute = Number(parts.find((p) => p.type === 'minute')?.value)
        if (currentHour !== hour || currentMinute !== minute) continue

        // Day-of-week filter. An absent or empty list means every day, which
        // is what every rule saved before this option existed has stored, so
        // those keep firing daily with no migration.
        //
        // Read off formatToParts rather than now.getDay(): getDay() gives the
        // SERVER's weekday, and near midnight that is a different day from the
        // account's own timezone. A rule set for Sunday 00:30 on a UTC-7
        // account would otherwise be judged against Saturday.
        const days = Array.isArray(config.days)
          ? config.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          : []
        const currentWeekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value)
        if (days.length > 0 && (currentWeekday === -1 || !days.includes(currentWeekday))) continue

        // Once-per-day dedupe by local calendar date, not a fixed cooldown -
        // this tick runs every minute, so without this a rule would fire
        // repeatedly for the whole minute window on a slow/delayed tick.
        const todayStr = getAccountDateString(now, timezone)
        const lastRunStr = rule.lastRunAt ? getAccountDateString(rule.lastRunAt, timezone) : null
        if (lastRunStr === todayStr) continue

        // Targeted at THIS rule: the tick has already decided this specific
          // rule is due, and a broadcast would run every other scheduled rule
          // on the account too, whatever time or days they were set to.
          await emitAutomationEvent(prisma, rule.accountId, 'time.daily', { hour, minute, weekday: currentWeekday }, { ruleId: rule.id })
      } catch (err) {
        console.warn(`[AutomationScheduler] Rule ${rule?.id} failed:`, err?.message || err)
      }
    }
  } catch (err) {
    console.warn('[AutomationScheduler] Tick failed:', err?.message || err)
  }
}

function scheduleAutomationTimeTriggers(prisma) {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  setTimeout(() => runAutomationScheduler(prisma), 30 * 1000) // staggered past other boot-time schedulers
  tickTimer = setInterval(() => runAutomationScheduler(prisma), TICK_MS)
  console.log('[AutomationScheduler] Scheduled every 1m for time.daily rules')
}

module.exports = { scheduleAutomationTimeTriggers, runAutomationScheduler }
