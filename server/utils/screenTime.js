// A daily screen-time limit per person: "Mia: 90 minutes on school days".
// When their watching today reaches it, the household hears once - bell and
// push - and the "watch.budget_exceeded" automation trigger fires.
//
// A limit can also pause their streaming until midnight or a chosen time
// (onReach: 'pause', resumeAt - off unless chosen for that person):
// - Stremio and Nuvio: the addons that play streams come off their account.
//   The pause is applied where the desired addon list is worked out
//   (utils/sync.js getDesiredAddons), so every sync keeps them off until it
//   ends, and the Sync Guardian removes one put back by hand. Catalogs,
//   Continue Watching and their own protected addons stay.
// - A real Jellyfin server: their access schedule (Jellyfin's own parental
//   "allowed between" hours) is set to no hours at all, and put back after.
//   Not switching the account off: Jellyfin signs a disabled account out
//   everywhere - their TVs and SlickSync's own sign-in - so every pause
//   would end in a reconnect (tested). Under a schedule every request is
//   refused while their sign-ins survive; the activity monitor doesn't take
//   those refusals for a broken connection while they're paused.
// - AIOStreams and AIOMetadata have no way to switch one person off, so a
//   limit there can only alert.
// What is already playing carries on; the next thing they try won't.
//
// Minutes are counted exactly like Watch Time: today's WatchActivity rows,
// "today" being the account's own day (getAccountDateString - never the
// server's UTC day). WatchActivity is the record every pipeline writes, with
// merged viewings already kept to the longer of the two (max, never a sum),
// so nothing is counted twice. Stremio and Nuvio only report at pause or
// stop, so an alert (and a pause) can arrive late - never early.
//
// Limits live in the account settings (sync.screenTime[userId] =
// { minutes, days: [0-6], 0 = Sunday; empty = every day, onReach? }) and
// pauses beside them (sync.screenTimePauses[userId] = { until, at, day,
// jellyfinSchedules? } or { resumedOn } after "Resume now") - no schema
// change. One alert per person per account day, keyed by that day.

const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')

// Every minute, so a pause ends within a minute of its "back on at" time.
// A check is a settings read and one grouped count per account with limits.
const CHECK_INTERVAL_MS = 60 * 1000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_MINUTES = 24 * 60
const PAUSES = 'screenTimePauses'

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

/** Change one person's entry under a settings key, on a fresh read. */
async function patchEntry(prisma, accountId, key, userId, value) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const all = { ...(cfg[key] || {}) }
  if (value) all[userId] = value
  else delete all[userId]
  const next = { ...cfg, [key]: all }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
}

/** A limit as stored, cleaned; null for none. */
function cleanLimit(raw) {
  if (!raw || typeof raw !== 'object') return null
  const minutes = Math.round(Number(raw.minutes))
  if (!(minutes >= 1 && minutes <= MAX_MINUTES)) return null
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
  // Alerting is the default and isn't stored; only a pause is, with the time
  // it ends when that isn't midnight.
  if (raw.onReach !== 'pause') return { minutes, days }
  const resumeAt = cleanTime(raw.resumeAt)
  return resumeAt && resumeAt !== '00:00' ? { minutes, days, onReach: 'pause', resumeAt } : { minutes, days, onReach: 'pause' }
}

/** "HH:MM" on a 24-hour clock, or null. */
function cleanTime(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

/** "midnight", or "7:00 AM" - how a pause's end is put in messages. */
function backOnLabel(resumeAt) {
  if (!resumeAt || resumeAt === '00:00') return 'midnight'
  const [h, m] = resumeAt.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The account's day and weekday right now. */
function accountToday(timezone, now = new Date()) {
  const date = getAccountDateString(now, timezone)
  const weekday = WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now))
  return { date, weekday }
}

/** Minutes past midnight on the account's clock at `when`. */
function wallMinutes(timezone, when) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(when)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0)
  return get('hour') * 60 + get('minute')
}

/**
 * The next moment the account's clock reads `hhmm` ("07:00"; midnight by
 * default) - when a pause ends. Worked out on the wall clock, then nudged
 * until the clock really reads that: a clock change in between moves it by
 * up to an hour.
 */
function nextAccountTime(timezone, now = new Date(), hhmm = '00:00') {
  const [h, m] = (cleanTime(hhmm) || '00:00').split(':').map(Number)
  const target = h * 60 + m
  const secondsIn = new Date(now.getTime()).getUTCSeconds() * 1000 + now.getMilliseconds()
  let ahead = target - wallMinutes(timezone, now)
  if (ahead <= 0) ahead += 24 * 60
  let at = new Date(now.getTime() - secondsIn + ahead * 60 * 1000)
  for (let i = 0; i < 4; i++) {
    let off = target - wallMinutes(timezone, at)
    if (off === 0) break
    if (off > 720) off -= 1440
    if (off < -720) off += 1440
    at = new Date(at.getTime() + off * 60 * 1000)
  }
  return at
}

const nextAccountMidnight = (timezone, now = new Date()) => nextAccountTime(timezone, now, '00:00')

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

// Whether a pause's time is still running - when the check should end it.
const activePause = (entry, now = Date.now()) => !!entry?.until && Date.parse(entry.until) > now
// Whether a pause is still in force: from when it is applied until the check
// has actually lifted it, which can be a little after its time. Everything
// that acts on a pause reads this one, so nothing treats them as back before
// the block really comes off - the sync's filter, the activity monitor's
// "expected refusal", and the person page.
const pauseInForce = (entry) => !!entry?.until

/** True while this person's streaming is paused - read by every sync. */
async function isStreamingPaused(prisma, accountId, userId) {
  const { cfg } = await readSync(prisma, accountId)
  return pauseInForce(cfg[PAUSES]?.[userId])
}

/** Whether an addon plays streams (its manifest offers the "stream" resource). */
function servesStreams(addon) {
  let manifest = addon?.manifest
  if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest) } catch { return false } }
  const resources = Array.isArray(manifest?.resources) ? manifest.resources : []
  return resources.some((r) => (typeof r === 'string' ? r : r?.name) === 'stream')
}

// ---------------------------------------------------------------------------
// What a pause does for each kind of person

function pauseKind(person) {
  if (person.providerType !== 'jellyfin') return 'addons'
  return !person.jellyfinServerKind || person.jellyfinServerKind === 'jellyfin' ? 'jellyfin' : null
}

/** Their normal sync, the way an automation's "Sync users" runs one. */
async function syncPerson(prisma, accountId, userId) {
  const { syncUserAddons } = require('../routes/users')
  const { decrypt } = require('./encryption')
  const { cfg } = await readSync(prisma, accountId)
  const unsafe = typeof cfg.safe === 'boolean' ? !cfg.safe : !!cfg.unsafe
  const useCustomFields = typeof cfg.useCustomFields === 'boolean' ? cfg.useCustomFields : (typeof cfg.useCustomNames === 'boolean' ? cfg.useCustomNames : true)
  const result = await syncUserAddons(prisma, userId, [], unsafe, { appAccountId: accountId, headers: {} }, decrypt, () => accountId, useCustomFields)
  if (!result?.success) throw new Error(result?.error || 'The sync failed')
}

// Allowed for no hours on any day (0 to 0) - how a Jellyfin pause blocks.
const BLOCKING_SCHEDULE = [{ DayOfWeek: 'Everyday', StartHour: 0, EndHour: 0 }]
const isBlockingSchedule = (list) => Array.isArray(list) && list.length === 1
  && list[0]?.DayOfWeek === 'Everyday' && Number(list[0]?.StartHour) === 0 && Number(list[0]?.EndHour) === 0

/**
 * Block (or unblock) them on a real Jellyfin server through its access
 * schedule. Blocking returns the schedule it replaced, to put back later -
 * or null when they were already blocked like this, so nothing is restored.
 * Unblocking puts `restore` back, but only over our own block: a schedule
 * an administrator set on the server meanwhile is theirs, and stays.
 */
async function setJellyfinBlocked(prisma, accountId, userId, blocked, { decrypt, restore = [] } = {}) {
  const ctx = await require('./jellyfinParental').adminContext(prisma, decrypt || require('./encryption').decrypt, accountId, userId)
  if (!ctx.available || !ctx.session) throw new Error('Pausing needs an administrator’s sign-in on their Jellyfin server')
  const { call } = require('./jellyfinServerCollections')
  const path = `/Users/${ctx.person.jellyfinUserId}`
  const policy = (await call(ctx.session, path))?.Policy
  if (!policy) throw new Error('The server did not say how this account is set up')
  const current = Array.isArray(policy.AccessSchedules) ? policy.AccessSchedules : []
  if (blocked) {
    if (isBlockingSchedule(current)) return null
    await call(ctx.session, `${path}/Policy`, { method: 'POST', body: { ...policy, AccessSchedules: BLOCKING_SCHEDULE } })
    return current.map(({ DayOfWeek, StartHour, EndHour }) => ({ DayOfWeek, StartHour, EndHour }))
  }
  if (!isBlockingSchedule(current)) return null
  await call(ctx.session, `${path}/Policy`, { method: 'POST', body: { ...policy, AccessSchedules: restore || [] } })
  return null
}

const defaultDeps = { syncPerson, setJellyfinBlocked }

/** Whether a pause can work for them, and why not. */
async function canPause(prisma, accountId, person, deps = {}) {
  const kind = pauseKind(person)
  if (!kind) return { ok: false, code: 'not-supported', reason: 'AIOStreams can’t switch one person off, so here a limit can only alert.' }
  if (kind === 'addons') {
    let groups = 1
    try { groups = await prisma.group.count({ where: { accountId, userIds: { contains: person.id } } }) } catch { /* offer it; the sync will say */ }
    return groups ? { ok: true } : { ok: false, code: 'no-group', reason: 'Put them in a group first - a pause takes the group’s stream addons off their account.' }
  }
  const ctx = await (deps.adminContext || require('./jellyfinParental').adminContext)(prisma, deps.decrypt || require('./encryption').decrypt, accountId, person.id).catch(() => null)
  return ctx?.available && ctx.session ? { ok: true } : { ok: false, code: 'needs-admin', reason: 'Pausing needs an administrator’s sign-in on their Jellyfin server.' }
}

/** Pause their streaming until `until`. */
async function pausePerson(prisma, accountId, person, until, deps = {}, { day = null, now = new Date() } = {}) {
  const d = { ...defaultDeps, ...deps }
  const kind = pauseKind(person)
  if (!kind) return false
  // day: the account day it began on - a pause that ends the same day (back
  // on at 9 PM) must not start again at the next check.
  const entry = { until: until.toISOString(), at: now.toISOString(), day }
  if (kind === 'jellyfin') {
    const replaced = await d.setJellyfinBlocked(prisma, accountId, person.id, true, { decrypt: deps.decrypt })
    // null: already blocked like this before - so not ours to lift.
    if (replaced) entry.jellyfinSchedules = replaced
  }
  await patchEntry(prisma, accountId, PAUSES, person.id, entry)
  // The sync reads the entry just written.
  if (kind === 'addons') await d.syncPerson(prisma, accountId, person.id)
  return true
}

/** Undo a pause: their stream addons back, or their Jellyfin account on again. */
async function unpausePerson(prisma, accountId, person, entry, deps = {}, { resumedOn = null } = {}) {
  const d = { ...defaultDeps, ...deps }
  await patchEntry(prisma, accountId, PAUSES, person.id, resumedOn ? { resumedOn } : null)
  const kind = pauseKind(person)
  if (kind === 'addons') await d.syncPerson(prisma, accountId, person.id)
  if (kind === 'jellyfin' && Array.isArray(entry?.jellyfinSchedules)) await d.setJellyfinBlocked(prisma, accountId, person.id, false, { decrypt: deps.decrypt, restore: entry.jellyfinSchedules })
}

const PERSON_SELECT = { id: true, username: true, providerType: true, jellyfinServerKind: true, isActive: true }

// ---------------------------------------------------------------------------
// The person page

/** The person page's view: their limit, today so far, and any pause. */
async function getLimit(prisma, accountId, userId, deps = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const { cfg } = await readSync(prisma, accountId)
  const limit = cleanLimit(cfg.screenTime?.[userId])
  const timezone = await resolveAccountTimezone(prisma, accountId)
  const today = accountToday(timezone)
  const seconds = (await secondsToday(prisma, accountId, [userId], timezone)).get(userId) || 0
  const pause = cfg[PAUSES]?.[userId]
  return {
    limit,
    todayMinutes: Math.floor(seconds / 60),
    appliesToday: limit ? appliesToday(limit, today.weekday) : false,
    paused: pauseInForce(pause) ? { until: pause.until } : null,
    canPause: await canPause(prisma, accountId, person, deps),
  }
}

async function setLimit(prisma, accountId, userId, raw, deps = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const limit = raw == null ? null : cleanLimit(raw)
  if (raw != null && !limit) throw fail(`A limit is between 1 and ${MAX_MINUTES} minutes`)
  await patchEntry(prisma, accountId, 'screenTime', userId, limit)

  // A pause that the new limit no longer calls for ends now: the limit was
  // removed, set back to alerting, or raised past what they've watched.
  const { cfg } = await readSync(prisma, accountId)
  const pause = cfg[PAUSES]?.[userId]
  if (pauseInForce(pause)) {
    const timezone = await resolveAccountTimezone(prisma, accountId)
    const today = accountToday(timezone)
    const watched = Math.floor(((await secondsToday(prisma, accountId, [userId], timezone)).get(userId) || 0) / 60)
    const stillDue = limit?.onReach === 'pause' && appliesToday(limit, today.weekday) && watched >= limit.minutes
    if (!stillDue) {
      await unpausePerson(prisma, accountId, person, pause, deps)
    } else {
      // A new "back on at" moves this pause's end: the first time it comes
      // round after the pause began, or now if that has already passed.
      const until = nextAccountTime(timezone, new Date(pause.at || Date.now()), limit.resumeAt || '00:00')
      if (until.getTime() <= Date.now()) await unpausePerson(prisma, accountId, person, pause, deps, { resumedOn: pause.day === today.date ? today.date : null })
      else if (until.toISOString() !== pause.until) await patchEntry(prisma, accountId, PAUSES, userId, { ...pause, until: until.toISOString() })
    }
  }
  return getLimit(prisma, accountId, userId, deps)
}

/** "Resume now": streaming back for the rest of today. */
async function resume(prisma, accountId, userId, deps = {}, { now = new Date() } = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const { cfg } = await readSync(prisma, accountId)
  const pause = cfg[PAUSES]?.[userId]
  if (!pauseInForce(pause)) throw fail('They aren’t paused')
  const timezone = await resolveAccountTimezone(prisma, accountId)
  // Remembered for today, so the next check doesn't pause them again.
  await unpausePerson(prisma, accountId, person, pause, deps, { resumedOn: accountToday(timezone, now).date })
  return getLimit(prisma, accountId, userId, deps)
}

// ---------------------------------------------------------------------------
// The check

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

/** Pauses whose day is over end; a "Resume now" note from an earlier day is dropped. */
async function endFinishedPauses(prisma, accountId, pauses, today, now, deps) {
  for (const [userId, entry] of Object.entries(pauses || {})) {
    if (activePause(entry, now.getTime())) continue
    if (entry?.resumedOn && entry.resumedOn === today.date) continue
    const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
    if (!person) { await patchEntry(prisma, accountId, PAUSES, userId, null); continue }
    // Ended on the day it began (back on at 9 PM): remembered for the rest
    // of today, or the next check would pause them straight away again.
    const resumedOn = entry?.day && entry.day === today.date ? today.date : null
    if (entry?.until) await unpausePerson(prisma, accountId, person, entry, deps, { resumedOn }).catch((e) => console.warn(`[ScreenTime] resuming ${userId}:`, e?.message))
    else await patchEntry(prisma, accountId, PAUSES, userId, null)
  }
}

/** One look across every account with a limit set. Returns the alerts sent. */
async function checkScreenTime(prisma, { now = new Date(), emit, deps = {} } = {}) {
  const fire = emit || require('./automation/engine').emitAutomationEvent
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  let sent = 0
  for (const account of accounts) {
    let cfg = account.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    const limits = Object.entries(cfg?.screenTime || {}).map(([userId, raw]) => [userId, cleanLimit(raw)]).filter(([, l]) => l)
    const pauses = cfg?.[PAUSES] || {}
    if (!limits.length && !Object.keys(pauses).length) continue
    try {
      const timezone = await resolveAccountTimezone(prisma, account.id)
      const today = accountToday(timezone, now)
      await endFinishedPauses(prisma, account.id, pauses, today, now, deps)
      const due = limits.filter(([, l]) => appliesToday(l, today.weekday))
      if (!due.length) continue
      // Read again: a pause ended just above leaves a note for today that
      // the copy read at the start doesn't have.
      const current = (await readSync(prisma, account.id)).cfg[PAUSES] || {}
      const people = await prisma.user.findMany({ where: { accountId: account.id, id: { in: due.map(([id]) => id) }, isActive: true }, select: PERSON_SELECT })
      const seconds = await secondsToday(prisma, account.id, people.map((p) => p.id), timezone, now)
      for (const person of people) {
        const limit = due.find(([id]) => id === person.id)[1]
        const watched = Math.floor((seconds.get(person.id) || 0) / 60)
        if (watched < limit.minutes) continue
        const name = person.username || 'Someone'

        // Pause first, so the alert can say so.
        let pausedNow = false
        const pause = current[person.id]
        if (limit.onReach === 'pause' && !activePause(pause, now.getTime()) && pause?.resumedOn !== today.date) {
          try {
            pausedNow = await pausePerson(prisma, account.id, person, nextAccountTime(timezone, now, limit.resumeAt || '00:00'), deps, { day: today.date, now })
          } catch (e) {
            console.warn(`[ScreenTime] pausing ${person.id}:`, e?.message)
          }
        }

        const dedupeKey = `screentime:${person.id}:${today.date}`
        if (!(await alreadySent(prisma, account.id, dedupeKey))) {
          await send(prisma, account.id, {
            title: `${name} reached today's ${limit.minutes}-minute limit`,
            body: `${name} has watched ${watched} minutes today.${pausedNow ? ` Streaming is paused until ${backOnLabel(limit.resumeAt)}.` : ''}`,
            url: `/users/${person.id}`,
            dedupeKey,
          })
          await fire(prisma, account.id, 'watch.budget_exceeded', {
            username: person.username, userId: person.id, minutesWatched: watched, limitMinutes: limit.minutes,
          }).catch(() => {})
          sent++
        } else if (pausedNow) {
          // Switched to pausing after today's alert had already gone out.
          await send(prisma, account.id, {
            title: `${name}'s streaming is paused until ${backOnLabel(limit.resumeAt)}`,
            body: `${name} is past today's ${limit.minutes}-minute limit.`,
            url: `/users/${person.id}`,
            dedupeKey: `screentime-pause:${person.id}:${today.date}`,
          })
        }
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

module.exports = {
  getLimit, setLimit, resume, checkScreenTime, scheduleScreenTime, cleanLimit, accountToday, nextAccountMidnight, nextAccountTime,
  isStreamingPaused, servesStreams, CHECK_INTERVAL_MS,
}
