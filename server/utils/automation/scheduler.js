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
          timeZone: timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
        }).formatToParts(now)
        const currentHour = Number(parts.find((p) => p.type === 'hour')?.value)
        const currentMinute = Number(parts.find((p) => p.type === 'minute')?.value)
        if (currentHour !== hour || currentMinute !== minute) continue

        // Once-per-day dedupe by local calendar date, not a fixed cooldown -
        // this tick runs every minute, so without this a rule would fire
        // repeatedly for the whole minute window on a slow/delayed tick.
        const todayStr = getAccountDateString(now, timezone)
        const lastRunStr = rule.lastRunAt ? getAccountDateString(rule.lastRunAt, timezone) : null
        if (lastRunStr === todayStr) continue

        await emitAutomationEvent(prisma, rule.accountId, 'time.daily', { hour, minute })
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
