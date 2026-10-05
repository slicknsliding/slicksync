// A daily screen-time limit per person: "Mia: 90 minutes on school days".
// When their watching today reaches it, the household hears once - bell and
// push - and the "watch.budget_exceeded" automation trigger fires. Alert
// only: nothing is stopped.
//
// Minutes are counted exactly like Watch Time: today's WatchActivity rows,
// "today" being the account's own day (getAccountDateString - never the
// server's UTC day). WatchActivity is the record every pipeline writes, with
// merged viewings already kept to the longer of the two (max, never a sum),
// so nothing is counted twice. Stremio and Nuvio only report at pause or
// stop, so an alert can arrive late - never early.
//
// Limits live in the account settings (sync.screenTime[userId] =
// { minutes, days: [0-6], 0 = Sunday; empty = every day }) - no schema
// change. One alert per person per account day, keyed by that day.

const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')

const CHECK_INTERVAL_MS = 5 * 60 * 1000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_MINUTES = 24 * 60

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

async function readSync(prisma, accountId) {
  const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = account?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/** A limit as stored, cleaned; null for none. */
function cleanLimit(raw) {
  if (!raw || typeof raw !== 'object') return null
  const minutes = Math.round(Number(raw.minutes))
  if (!(minutes >= 1 && minutes <= MAX_MINUTES)) return null
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
  return { minutes, days }
}

/** The account's day and weekday right now. */
function accountToday(timezone, now = new Date()) {
  const date = getAccountDateString(now, timezone)
  const weekday = WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now))
  return { date, weekday }
}

/** Seconds watched today (the account's day), per person - Watch Time's own numbers. */
async function secondsToday(prisma, accountId, userIds, timezone, now = new Date()) {
  const dayStart = new Date(getAccountDateString(now, timezone))
  const rows = await prisma.watchActivity.groupBy({
    by: ['userId'],
    where: { accountId, userId: { in: userIds }, date: { gte: dayStart } },
    _sum: { watchTimeSeconds: true },
  })
  return new Map(rows.map((r) => [r.userId, Number(r._sum?.watchTimeSeconds) || 0]))
}

function appliesToday(limit, weekday) {
  return !limit.days.length || limit.days.includes(weekday)
}

/** The person page's view: their limit, and today so far. */
async function getLimit(prisma, accountId, userId) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { id: true } })
  if (!person) throw fail('User not found', 404)
  const { cfg } = await readSync(prisma, accountId)
  const limit = cleanLimit(cfg.screenTime?.[userId])
  const timezone = await resolveAccountTimezone(prisma, accountId)
  const today = accountToday(timezone)
  const seconds = (await secondsToday(prisma, accountId, [userId], timezone)).get(userId) || 0
  return { limit, todayMinutes: Math.floor(seconds / 60), appliesToday: limit ? appliesToday(limit, today.weekday) : false }
}

async function setLimit(prisma, accountId, userId, raw) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { id: true } })
  if (!person) throw fail('User not found', 404)
  const limit = raw == null ? null : cleanLimit(raw)
  if (raw != null && !limit) throw fail(`A limit is between 1 and ${MAX_MINUTES} minutes`)
  const { cfg, asString } = await readSync(prisma, accountId)
  const all = { ...(cfg.screenTime || {}) }
  if (limit) all[userId] = limit
  else delete all[userId]
  const next = { ...cfg, screenTime: all }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
  return getLimit(prisma, accountId, userId)
}

async function alreadySent(prisma, accountId, dedupeKey) {
  const row = await prisma.notification.findUnique({ where: { accountId_dedupeKey: { accountId, dedupeKey } }, select: { id: true } }).catch(() => null)
  return !!row
}

async function send(prisma, accountId, { title, body, url, dedupeKey }) {
  const { createNotification } = require('./notificationStore')
  await createNotification(prisma, accountId, { type: 'activity', title, body, url, dedupeKey })
  try {
    const { isPushEnabled, sendPushToAccount } = require('./pushNotifications')
    if (isPushEnabled()) await sendPushToAccount(prisma, accountId, { title, body, url })
  } catch { /* the bell row above is the record */ }
}

/** One look across every account with a limit set. Returns the alerts sent. */
async function checkScreenTime(prisma, { now = new Date(), emit } = {}) {
  const fire = emit || require('./automation/engine').emitAutomationEvent
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  let sent = 0
  for (const account of accounts) {
    let cfg = account.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    const limits = Object.entries(cfg?.screenTime || {}).map(([userId, raw]) => [userId, cleanLimit(raw)]).filter(([, l]) => l)
    if (!limits.length) continue
    try {
      const timezone = await resolveAccountTimezone(prisma, account.id)
      const today = accountToday(timezone, now)
      const due = limits.filter(([, l]) => appliesToday(l, today.weekday))
      if (!due.length) continue
      const people = await prisma.user.findMany({ where: { accountId: account.id, id: { in: due.map(([id]) => id) }, isActive: true }, select: { id: true, username: true } })
      const seconds = await secondsToday(prisma, account.id, people.map((p) => p.id), timezone, now)
      for (const person of people) {
        const limit = due.find(([id]) => id === person.id)[1]
        const watched = Math.floor((seconds.get(person.id) || 0) / 60)
        if (watched < limit.minutes) continue
        const dedupeKey = `screentime:${person.id}:${today.date}`
        if (await alreadySent(prisma, account.id, dedupeKey)) continue
        const name = person.username || 'Someone'
        await send(prisma, account.id, {
          title: `${name} reached today's ${limit.minutes}-minute limit`,
          body: `${name} has watched ${watched} minutes today.`,
          url: `/users/${person.id}`,
          dedupeKey,
        })
        await fire(prisma, account.id, 'watch.budget_exceeded', {
          username: person.username, userId: person.id, minutesWatched: watched, limitMinutes: limit.minutes,
        }).catch(() => {})
        sent++
      }
    } catch (e) {
      console.warn(`[ScreenTime] ${account.id}:`, e?.message)
    }
  }
  return sent
}

let timer = null
function scheduleScreenTime(prisma) {
  if (timer) clearInterval(timer)
  const run = () => checkScreenTime(prisma).catch((e) => console.warn('[ScreenTime] check failed:', e?.message))
  setTimeout(run, 90 * 1000)
  timer = setInterval(run, CHECK_INTERVAL_MS)
}

module.exports = { getLimit, setLimit, checkScreenTime, scheduleScreenTime, cleanLimit, accountToday, CHECK_INTERVAL_MS }
