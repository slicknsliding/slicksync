// A daily screen-time limit per person: "Mia: 90 minutes on school days",
// and/or a bedtime: "no streaming from 9 PM to 7 AM on school nights". When
// their watching today reaches the limit, the household hears once - bell and
// push - and the "watch.budget_exceeded" automation trigger fires.
//
// A limit can also pause their streaming until midnight or a chosen time
// (onReach: 'pause', resumeAt - off unless chosen for that person), and a
// bedtime always pauses it, from its start to its end:
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
//   With stopPlaying, what they're watching is stopped too, after a warning
//   on their screen ten minutes before (Jellyfin's own session messages).
// - AIOStreams: a variant that takes the streams out of every addon, given to
//   their users in the configuration (utils/aioPause.js). Needs the
//   configuration password, like every write to it.
// - AIOMetadata: their users are pointed at SlickSync's "paused" stream addon,
//   which has nothing to play (utils/aiomPause.js). Also needs the
//   configuration password.
// Otherwise what is already playing carries on; the next thing they try won't.
//
// Minutes are counted exactly like Watch Time: today's WatchActivity rows,
// "today" being the account's own day (getAccountDateString - never the
// server's UTC day). WatchActivity is the record every pipeline writes, with
// merged viewings already kept to the longer of the two (max, never a sum),
// so nothing is counted twice. Stremio and Nuvio only report at pause or
// stop, so an alert (and a pause) can arrive late - never early.
//
// Limits live in the account settings (sync.screenTime[userId] =
// { minutes?, days: [0-6], 0 = Sunday; empty = every day, onReach?,
// resumeAt?, stopPlaying?, bedtime?: { from, to, days } }) and pauses beside
// them (sync.screenTimePauses[userId] = { until, at, day, budgetDay?,
// budgetAt?, night?, jellyfinSchedules?, aioUsers? } or, after a pause ended
// on the day it began or "Resume now", { resumedOn, skipNight? }) - no schema
// change. One alert per person per account day, keyed by that day.

const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')

// Every minute, so a pause ends within a minute of its "back on at" time.
// A check is a settings read and one grouped count per account with limits.
const CHECK_INTERVAL_MS = 60 * 1000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_MINUTES = 24 * 60
const PAUSES = 'screenTimePauses'
// How long before the limit or bedtime a Jellyfin screen is warned.
const WARN_MINUTES = 10

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

const cleanDays = (raw) => (Array.isArray(raw) ? [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [])

/** A bedtime as stored, cleaned; null for none. Its days are the nights it starts on. */
function cleanBedtime(raw) {
  if (!raw || typeof raw !== 'object') return null
  const from = cleanTime(raw.from)
  const to = cleanTime(raw.to)
  if (!from || !to || from === to) return null
  const days = cleanDays(raw.days)
  return { from, to, days: days.length === 7 ? [] : days }
}

/** A limit as stored, cleaned; null for none. A bedtime alone is a limit too. */
function cleanLimit(raw) {
  if (!raw || typeof raw !== 'object') return null
  const minutes = Math.round(Number(raw.minutes))
  const hasMinutes = minutes >= 1 && minutes <= MAX_MINUTES
  const bedtime = cleanBedtime(raw.bedtime)
  if (!hasMinutes && !bedtime) return null
  const out = hasMinutes ? { minutes, days: cleanDays(raw.days) } : { days: cleanDays(raw.days) }
  // Alerting is the default and isn't stored; only a pause is, with the time
  // it ends when that isn't midnight.
  if (raw.onReach === 'pause') {
    out.onReach = 'pause'
    const resumeAt = cleanTime(raw.resumeAt)
    if (resumeAt && resumeAt !== '00:00') out.resumeAt = resumeAt
  }
  if (bedtime) out.bedtime = bedtime
  if (raw.stopPlaying === true && (out.onReach === 'pause' || bedtime)) out.stopPlaying = true
  return out
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

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

/** "HH:MM" on the account's clock at `when`. */
function wallTime(timezone, when) {
  const m = wallMinutes(timezone, when)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
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

/**
 * Whether bedtime is on right now: { night, end } - the account day the
 * night began on, and when it ends - or null. A bedtime runs from `from` on
 * one of its nights to the next `to`, past midnight when `to` is earlier
 * ("21:00" to "07:00"), or within the day when it's later ("13:00" to "15:00").
 */
function bedtimeWindow(bedtime, timezone, now = new Date()) {
  if (!bedtime) return null
  const from = toMinutes(bedtime.from)
  const to = toMinutes(bedtime.to)
  const at = wallMinutes(timezone, now)
  const today = accountToday(timezone, now)
  const onNight = (weekday) => !bedtime.days.length || bedtime.days.includes(weekday)
  if (from < to) {
    if (at >= from && at < to && onNight(today.weekday)) return { night: today.date, end: nextAccountTime(timezone, now, bedtime.to) }
    return null
  }
  if (at >= from && onNight(today.weekday)) return { night: today.date, end: nextAccountTime(timezone, now, bedtime.to) }
  if (at < to) {
    const yesterday = accountToday(timezone, new Date(now.getTime() - (at + 1) * 60 * 1000))
    if (onNight(yesterday.weekday)) return { night: yesterday.date, end: nextAccountTime(timezone, now, bedtime.to) }
  }
  return null
}

/** Minutes until tonight's bedtime starts, if it starts within `within` minutes. */
function minutesToBedtime(bedtime, timezone, now, within) {
  if (!bedtime) return null
  const start = nextAccountTime(timezone, now, bedtime.from)
  const minutes = Math.round((start.getTime() - now.getTime()) / 60000)
  if (minutes <= 0 || minutes > within) return null
  if (bedtimeWindow(bedtime, timezone, new Date(start.getTime() + 60 * 1000)) == null) return null
  return { minutes, night: accountToday(timezone, start).date }
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

/**
 * The pause a person should be under right now, from their limit and their
 * bedtime: { until, budgetDay?, budgetAt?, night? }, or null for none.
 *
 * The limit pauses once a day: from when it is reached until its back-on
 * time, which can be the next morning. A pause it began holds to that time,
 * even past midnight, unless the limit stops asking for it (removed, set to
 * alerting, or raised past what they watched). Once that pause has ended -
 * or after "Resume now" - not again that day ({ resumedOn }).
 * Bedtime pauses from its start to its end, unless "Resume now" skipped that
 * night. Both at once: whichever ends later.
 */
function wantedPause(limit, { watched, today, now, timezone, entry }) {
  if (!limit) return null
  const inForce = pauseInForce(entry)
  let budgetUntil = null
  let budgetAt = null
  if (limit.minutes && limit.onReach === 'pause') {
    if (inForce && entry.budgetDay) {
      const stillOver = entry.budgetDay !== today.date || watched >= limit.minutes
      const end = nextAccountTime(timezone, new Date(entry.budgetAt || entry.at || now), limit.resumeAt || '00:00')
      if (stillOver && end.getTime() > now.getTime()) { budgetUntil = end; budgetAt = entry.budgetAt || entry.at }
    } else if (appliesToday(limit, today.weekday) && watched >= limit.minutes && entry?.resumedOn !== today.date) {
      budgetUntil = nextAccountTime(timezone, now, limit.resumeAt || '00:00')
      budgetAt = now.toISOString()
    }
  }
  let bed = bedtimeWindow(limit.bedtime, timezone, now)
  if (bed && entry?.skipNight === bed.night) bed = null
  if (!budgetUntil && !bed) return null
  const until = new Date(Math.max(budgetUntil ? budgetUntil.getTime() : 0, bed ? bed.end.getTime() : 0))
  return {
    until,
    ...(budgetUntil ? { budgetDay: inForce && entry.budgetDay ? entry.budgetDay : today.date, budgetAt } : {}),
    ...(bed ? { night: bed.night } : {}),
  }
}

// ---------------------------------------------------------------------------
// What a pause does for each kind of person

function pauseKind(person) {
  if (person.providerType !== 'jellyfin') return 'addons'
  if (!person.jellyfinServerKind || person.jellyfinServerKind === 'jellyfin') return 'jellyfin'
  if (person.jellyfinServerKind === 'aiostreams') return 'aiostreams'
  if (person.jellyfinServerKind === 'aiometadata') return 'aiometadata'
  return null
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

const sameId = (a, b) => String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase()

/**
 * Their sessions on a real Jellyfin server that are playing something: put a
 * message on each screen, and with `stop`, stop the playback. Through an
 * administrator's sign-in, which may control anyone's session. Returns how
 * many screens it reached.
 */
async function messageJellyfinScreens(prisma, accountId, userId, { text, stop = false, decrypt } = {}) {
  const ctx = await require('./jellyfinParental').adminContext(prisma, decrypt || require('./encryption').decrypt, accountId, userId)
  if (!ctx.available || !ctx.session) return 0
  const { call } = require('./jellyfinServerCollections')
  const sessions = await call(ctx.session, '/Sessions?ActiveWithinSeconds=600')
  const playing = (Array.isArray(sessions) ? sessions : []).filter((s) => sameId(s?.UserId, ctx.person.jellyfinUserId) && s?.NowPlayingItem && s?.Id)
  let reached = 0
  for (const s of playing) {
    try {
      if (stop) await call(ctx.session, `/Sessions/${encodeURIComponent(s.Id)}/Playing/Stop`, { method: 'POST' })
      await call(ctx.session, `/Sessions/${encodeURIComponent(s.Id)}/Message`, { method: 'POST', body: { Header: 'SlickSync', Text: text, TimeoutMs: 15000 } })
      reached++
    } catch (e) {
      console.warn(`[ScreenTime] could not reach a screen of ${userId}:`, e?.message)
    }
  }
  return reached
}

// ---------------------------------------------------------------------------
// After a pause on Stremio and Nuvio
//
// The app on someone's device holds the addon list it last saw - during a
// pause, the paused one - and can write it back to their account after the
// pause has ended and SlickSync has put the full list back (seen live on
// Nuvio, three minutes after a bedtime ended: Account Guard flagged it and
// their streams stayed off). So the list a pause leaves on the account is
// remembered as a fingerprint, and for a while after the pause ends each
// check reads their account: if it is exactly that paused list again, the
// full list is put back. Any other change is the household's and is left
// alone. A few tries at most, so SlickSync never fights an app forever.
const AFTER_PAUSE = 'screenTimeAfterPause'
const AFTER_PAUSE_MS = 15 * 60 * 1000
const AFTER_PAUSE_TRIES = 3

/** A fingerprint of an account's addon list: its addresses, in any order. */
function addonPrint(addons) {
  const urls = [...new Set((Array.isArray(addons) ? addons : [])
    .map((a) => String(a?.transportUrl || a?.manifestUrl || a?.url || '').trim())
    .filter(Boolean))].sort()
  return require('crypto').createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 24)
}

/** The addons on someone's Stremio or Nuvio account right now. */
async function readAccountAddons(prisma, accountId, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return null
  const { makeCreateProvider } = require('../providers')
  const { encrypt, decrypt } = require('./encryption')
  const provider = makeCreateProvider({ prisma, encrypt, getAccountId: () => accountId })(user, { decrypt, req: { appAccountId: accountId } })
  if (!provider?.getAddons) return null
  const { addons } = await provider.getAddons()
  return addons
}

const setAioPaused = (...args) => require('./aioPause').setAioPaused(...args)
const setAiomPaused = (...args) => require('./aiomPause').setAiomPaused(...args)

const defaultDeps = { syncPerson, setJellyfinBlocked, setAioPaused, setAiomPaused, messageScreens: messageJellyfinScreens, readAddons: readAccountAddons }

/** Whether a pause can work for them, and why not. */
async function canPause(prisma, accountId, person, deps = {}) {
  const kind = pauseKind(person)
  if (!kind) return { ok: false, code: 'not-supported', reason: 'This server can’t switch one person off, so here a limit can only alert.' }
  if (kind === 'addons') {
    let groups = 1
    try { groups = await prisma.group.count({ where: { accountId, userIds: { contains: person.id } } }) } catch { /* offer it; the sync will say */ }
    return groups ? { ok: true } : { ok: false, code: 'no-group', reason: 'Put them in a group first - a pause takes the group’s stream addons off their account.' }
  }
  if (kind === 'aiostreams') {
    const access = await (deps.aioAccess || require('./aioPause').pauseAccess)(prisma, accountId, person).catch(() => null)
    return access ? { ok: true } : { ok: false, code: 'needs-config-password', reason: 'Pausing needs their AIOStreams configuration password - reconnect them with it.' }
  }
  if (kind === 'aiometadata') {
    const access = await (deps.aiomAccess || require('./aiomPause').pauseAccess)(prisma, accountId, person).catch(() => null)
    return access ? { ok: true } : { ok: false, code: 'needs-config-password', reason: 'Pausing needs their AIOMetadata configuration password - reconnect them with it.' }
  }
  const ctx = await (deps.adminContext || require('./jellyfinParental').adminContext)(prisma, deps.decrypt || require('./encryption').decrypt, accountId, person.id).catch(() => null)
  return ctx?.available && ctx.session ? { ok: true } : { ok: false, code: 'needs-admin', reason: 'Pausing needs an administrator’s sign-in on their Jellyfin server.' }
}

/** Pause their streaming: `want` from wantedPause. */
async function pausePerson(prisma, accountId, person, want, deps = {}, { day = null, now = new Date(), stopPlaying = false, untilLabel = null } = {}) {
  const d = { ...defaultDeps, ...deps }
  const kind = pauseKind(person)
  if (!kind) return false
  // Without a group there are no stream addons to take off - a pause would
  // say they're paused while nothing changed.
  if (kind === 'addons') {
    const groups = prisma.group?.count
      ? await prisma.group.count({ where: { accountId, userIds: { contains: person.id } } }).catch(() => 1)
      : 1
    if (!groups) return false
  }
  // day: the account day it began on.
  const entry = { until: want.until.toISOString(), at: now.toISOString(), day }
  if (want.budgetDay) { entry.budgetDay = want.budgetDay; entry.budgetAt = want.budgetAt }
  if (want.night) entry.night = want.night
  if (kind === 'jellyfin') {
    const replaced = await d.setJellyfinBlocked(prisma, accountId, person.id, true, { decrypt: deps.decrypt })
    // null: already blocked like this before - so not ours to lift.
    if (replaced) entry.jellyfinSchedules = replaced
  }
  if (kind === 'aiostreams') {
    const done = await d.setAioPaused(prisma, accountId, person, true, { decrypt: deps.decrypt })
    entry.aioUsers = done?.users || []
  }
  if (kind === 'aiometadata') {
    // What was pointed away and what it held before, to put back exactly that.
    entry.aiomState = await d.setAiomPaused(prisma, accountId, person, true, { decrypt: deps.decrypt })
  }
  await patchEntry(prisma, accountId, PAUSES, person.id, entry)
  // The sync reads the entry just written.
  if (kind === 'addons') {
    await d.syncPerson(prisma, accountId, person.id)
    // What the pause left on their account, to recognise it if their app
    // writes it back after the pause ends ("After a pause" above).
    const left = await d.readAddons(prisma, accountId, person.id).catch(() => null)
    if (left) await patchEntry(prisma, accountId, PAUSES, person.id, { ...entry, pausedPrint: addonPrint(left) })
  }
  if (kind === 'jellyfin' && stopPlaying) {
    await d.messageScreens(prisma, accountId, person.id, { text: `Streaming is paused until ${untilLabel || 'later'}.`, stop: true, decrypt: deps.decrypt }).catch((e) => console.warn(`[ScreenTime] stopping ${person.id}:`, e?.message))
  }
  return true
}

/** Undo a pause: their stream addons back, their Jellyfin account on again, or AIOStreams' variant off. */
async function unpausePerson(prisma, accountId, person, entry, deps = {}, { resumedOn = null, skipNight = null, now = new Date() } = {}) {
  const d = { ...defaultDeps, ...deps }
  await patchEntry(prisma, accountId, PAUSES, person.id, resumedOn || skipNight ? { resumedOn: resumedOn || null, ...(skipNight ? { skipNight } : {}) } : null)
  const kind = pauseKind(person)
  if (kind === 'addons') {
    await d.syncPerson(prisma, accountId, person.id)
    // Watch for their app writing the paused list back - unless the full
    // list is the same as the paused one (no stream addons to lose).
    if (entry?.pausedPrint) {
      const restored = await d.readAddons(prisma, accountId, person.id).catch(() => null)
      if (!restored || addonPrint(restored) !== entry.pausedPrint) {
        await patchEntry(prisma, accountId, AFTER_PAUSE, person.id, { print: entry.pausedPrint, until: new Date(now.getTime() + AFTER_PAUSE_MS).toISOString(), tries: 0 })
      }
    }
  }
  if (kind === 'jellyfin' && Array.isArray(entry?.jellyfinSchedules)) await d.setJellyfinBlocked(prisma, accountId, person.id, false, { decrypt: deps.decrypt, restore: entry.jellyfinSchedules })
  if (kind === 'aiostreams' && entry?.aioUsers) await d.setAioPaused(prisma, accountId, person, false, { decrypt: deps.decrypt, users: entry.aioUsers })
  if (kind === 'aiometadata' && entry?.aiomState) await d.setAiomPaused(prisma, accountId, person, false, { decrypt: deps.decrypt, state: entry.aiomState })
}

/** A pause made to match `want` without lifting it: a later end, the reasons it holds for. */
async function reshapePause(prisma, accountId, person, entry, want) {
  const next = { ...entry, until: want.until.toISOString() }
  if (want.budgetDay) { next.budgetDay = want.budgetDay; next.budgetAt = want.budgetAt }
  if (want.night) next.night = want.night
  if (JSON.stringify(next) !== JSON.stringify(entry)) await patchEntry(prisma, accountId, PAUSES, person.id, next)
}

const PERSON_SELECT = { id: true, username: true, providerType: true, jellyfinServerKind: true, isActive: true }

/** "7:00 AM" (or "midnight") for when a pause ends, on the account's clock. */
function untilLabelFor(timezone, until) {
  return backOnLabel(wallTime(timezone, new Date(until)))
}

/**
 * Bring one person's pause in line with their limit and bedtime. `settings`:
 * after the household changed them, so a pause the new settings don't call
 * for ends now; otherwise (the minute check) a pause runs to its time, and is
 * only ever lengthened. Returns { pausedNow, want }.
 */
async function reconcile(prisma, accountId, person, limit, ctx, deps, { settings = false } = {}) {
  const { entry, today, now, timezone } = ctx
  const want = wantedPause(limit, ctx)
  // A pause ending on the day the limit began it is remembered for the rest
  // of that day, or the next check would pause them straight away again.
  const endNote = () => ({ resumedOn: entry?.budgetDay === today.date ? today.date : null })
  if (pauseInForce(entry)) {
    if (want) {
      const longer = want.until.getTime() > Date.parse(entry.until)
      if (settings || longer || !activePause(entry, now.getTime())) await reshapePause(prisma, accountId, person, entry, want)
    } else if (settings) {
      // The household changed it: no note, so pausing again today is still theirs to choose.
      await unpausePerson(prisma, accountId, person, entry, deps, { now })
    } else if (!activePause(entry, now.getTime())) {
      await unpausePerson(prisma, accountId, person, entry, deps, { ...endNote(), now })
    }
    return { pausedNow: false, want }
  }
  if (!want) return { pausedNow: false, want }
  const pausedNow = await pausePerson(prisma, accountId, person, want, deps, {
    day: today.date, now, stopPlaying: !!limit.stopPlaying, untilLabel: untilLabelFor(timezone, want.until),
  })
  return { pausedNow, want }
}

// ---------------------------------------------------------------------------
// The person page

/** The person page's view: their limit, today so far, and any pause. */
async function getLimit(prisma, accountId, userId, deps = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const { cfg } = await readSync(prisma, accountId)
  const limit = cleanLimit(cfg.screenTime?.[userId])
  const timezone = await resolveAccountTimezone(prisma, accountId)
  const now = new Date()
  const today = accountToday(timezone, now)
  const seconds = (await secondsToday(prisma, accountId, [userId], timezone)).get(userId) || 0
  const pause = cfg[PAUSES]?.[userId]
  const bed = limit?.bedtime ? bedtimeWindow(limit.bedtime, timezone, now) : null
  return {
    limit,
    todayMinutes: Math.floor(seconds / 60),
    appliesToday: limit?.minutes ? appliesToday(limit, today.weekday) : false,
    paused: pauseInForce(pause)
      ? { until: pause.until, untilLabel: untilLabelFor(timezone, pause.until), reason: pause.night && bed && bed.night === pause.night ? 'bedtime' : 'limit' }
      : null,
    canPause: await canPause(prisma, accountId, person, deps),
    // Stopping what's playing works on a real Jellyfin server only.
    canStopPlaying: pauseKind(person) === 'jellyfin',
  }
}

async function setLimit(prisma, accountId, userId, raw, deps = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const limit = raw == null ? null : cleanLimit(raw)
  if (raw != null && !limit) throw fail(`A limit is between 1 and ${MAX_MINUTES} minutes, or a bedtime with different start and end times`)
  await patchEntry(prisma, accountId, 'screenTime', userId, limit)

  // Bring a pause in line with the new settings at once: one they no longer
  // call for ends, a new back-on time moves it, and a bedtime set during its
  // hours starts it now.
  const { cfg } = await readSync(prisma, accountId)
  const entry = cfg[PAUSES]?.[userId]
  const timezone = await resolveAccountTimezone(prisma, accountId)
  const now = new Date()
  const today = accountToday(timezone, now)
  const watched = Math.floor(((await secondsToday(prisma, accountId, [userId], timezone, now)).get(userId) || 0) / 60)
  const ok = !limit || pauseInForce(entry) || (await canPause(prisma, accountId, person, deps)).ok
  if (ok) {
    await reconcile(prisma, accountId, person, limit, { entry, today, now, timezone, watched }, deps, { settings: true })
      .catch((e) => console.warn(`[ScreenTime] applying ${userId}'s new settings:`, e?.message))
  }
  // Switched off: a "Resume now" note for today or tonight goes too, so one
  // switched back on later applies from the start.
  if (!limit && entry && !pauseInForce(entry)) await patchEntry(prisma, accountId, PAUSES, userId, null)
  await syncServerBedtime(prisma, accountId, person, limit, { timezone, now }, deps)
  return getLimit(prisma, accountId, userId, deps)
}

/**
 * A real Jellyfin server's own copy of their bedtime (jellyfinBedtime.js):
 * written, moved or taken away to match, on a fresh read of their pause.
 */
async function syncServerBedtime(prisma, accountId, person, limit, { timezone, now = new Date() }, deps = {}) {
  if (pauseKind(person) !== 'jellyfin') return
  const entry = (await readSync(prisma, accountId)).cfg[PAUSES]?.[person.id]
  const sync = deps.syncBedtimeSchedule || require('./jellyfinBedtime').syncBedtimeSchedule
  await sync(prisma, accountId, person, limit, { entry, timezone, now }, { decrypt: deps.decrypt })
    .catch((e) => console.warn(`[ScreenTime] bedtime schedule for ${person.id}:`, e?.message))
}

/** "Resume now": streaming back for the rest of today - and tonight, if it's bedtime. */
async function resume(prisma, accountId, userId, deps = {}, { now = new Date() } = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PERSON_SELECT })
  if (!person) throw fail('User not found', 404)
  const { cfg } = await readSync(prisma, accountId)
  const pause = cfg[PAUSES]?.[userId]
  if (!pauseInForce(pause)) throw fail('They aren’t paused')
  const timezone = await resolveAccountTimezone(prisma, accountId)
  const limit = cleanLimit(cfg.screenTime?.[userId])
  const bed = limit?.bedtime ? bedtimeWindow(limit.bedtime, timezone, now) : null
  // Remembered, so the next check doesn't pause them again: today for the
  // limit, and tonight for a bedtime that's on now.
  await unpausePerson(prisma, accountId, person, pause, deps, { resumedOn: accountToday(timezone, now).date, skipNight: bed?.night || null, now })
  // Tonight opened on the server's own schedule too.
  await syncServerBedtime(prisma, accountId, person, limit, { timezone, now }, deps)
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

// Warnings already put on someone's screen: "<user>:<what>:<day or night>".
// In memory - after a restart one may be shown twice, never missed.
const warned = new Set()

/** Ten minutes' notice on a Jellyfin screen before the limit or bedtime stops it. */
async function warnScreens(prisma, accountId, person, limit, { watched, today, now, timezone, entry }, deps) {
  if (!limit.stopPlaying || pauseKind(person) !== 'jellyfin' || pauseInForce(entry)) return
  const d = { ...defaultDeps, ...deps }
  const say = async (key, text) => {
    if (warned.has(key)) return
    warned.add(key)
    await d.messageScreens(prisma, accountId, person.id, { text, decrypt: deps.decrypt }).catch(() => 0)
  }
  if (limit.minutes && limit.onReach === 'pause' && appliesToday(limit, today.weekday) && entry?.resumedOn !== today.date) {
    const left = limit.minutes - watched
    if (left > 0 && left <= WARN_MINUTES) await say(`${person.id}:limit:${today.date}`, `${left} minute${left === 1 ? '' : 's'} of watching left today.`)
  }
  const soon = minutesToBedtime(limit.bedtime, timezone, now, WARN_MINUTES)
  if (soon && entry?.skipNight !== soon.night) await say(`${person.id}:bedtime:${soon.night}`, `Bedtime in ${soon.minutes} minute${soon.minutes === 1 ? '' : 's'} - streaming stops at ${backOnLabel(limit.bedtime.from)}.`)
}

/**
 * The same ten minutes' notice on the person's own phone, for every kind of
 * account - only Jellyfin can put it on the screen they're watching. Sent to
 * devices they turned notifications on for from their own page, so nobody
 * who didn't ask hears anything; and only when a pause will really happen.
 */
async function warnPerson(prisma, accountId, person, limit, { watched, today, now, timezone, entry }, deps) {
  if (pauseInForce(entry) || !pauseKind(person)) return
  const notes = []
  if (limit.minutes && limit.onReach === 'pause' && appliesToday(limit, today.weekday) && entry?.resumedOn !== today.date) {
    const left = limit.minutes - watched
    if (left > 0 && left <= WARN_MINUTES) notes.push([`push:${person.id}:limit:${today.date}`, `${left} minute${left === 1 ? '' : 's'} of watching left today`, `Streaming pauses after that${limit.resumeAt && limit.resumeAt !== '00:00' ? `, back on at ${backOnLabel(limit.resumeAt)}` : ' until midnight'}.`])
  }
  const soon = minutesToBedtime(limit.bedtime, timezone, now, WARN_MINUTES)
  if (soon && entry?.skipNight !== soon.night) notes.push([`push:${person.id}:bedtime:${soon.night}`, `Bedtime in ${soon.minutes} minute${soon.minutes === 1 ? '' : 's'}`, `Streaming stops at ${backOnLabel(limit.bedtime.from)} until ${backOnLabel(limit.bedtime.to)}.`])
  const due = notes.filter(([key]) => !warned.has(key))
  if (!due.length) return
  if (!(await canPause(prisma, accountId, person, deps)).ok) return
  const sendTo = deps.sendPushToPerson || require('./pushNotifications').sendPushToPerson
  for (const [key, title, body] of due) {
    warned.add(key)
    await sendTo(prisma, accountId, person.id, { title, body, url: '/user' }).catch(() => {})
  }
}

/** The person's own phone, when a pause starts. */
async function tellPersonPaused(prisma, accountId, person, want, timezone, deps) {
  const sendTo = deps.sendPushToPerson || require('./pushNotifications').sendPushToPerson
  const until = untilLabelFor(timezone, want.until)
  await sendTo(prisma, accountId, person.id, want.night && !want.budgetDay
    ? { title: 'Bedtime', body: `Streaming is off until ${until}.`, url: '/user' }
    : { title: 'Streaming paused', body: `That's today's watching - streaming is back on at ${until}.`, url: '/user' }).catch(() => {})
}

/**
 * For a while after a pause ends: their account showing exactly the paused
 * list again means their app wrote it back - put the full list back, and say
 * so. Returns true when it did.
 */
async function guardAfterPause(prisma, accountId, person, watch, { now, entry }, deps) {
  const d = { ...defaultDeps, ...deps }
  if (!watch || Date.parse(watch.until) <= now.getTime() || (watch.tries || 0) >= AFTER_PAUSE_TRIES) {
    if (watch) await patchEntry(prisma, accountId, AFTER_PAUSE, person.id, null)
    return false
  }
  // A new pause is meant to look like this.
  if (pauseInForce(entry)) return false
  const addons = await d.readAddons(prisma, accountId, person.id).catch(() => null)
  if (!addons || addonPrint(addons) !== watch.print) return false
  await d.syncPerson(prisma, accountId, person.id)
  await patchEntry(prisma, accountId, AFTER_PAUSE, person.id, { ...watch, tries: (watch.tries || 0) + 1 })
  const name = person.username || 'Someone'
  await send(prisma, accountId, {
    title: `${name}'s addons put back`,
    body: `Their app wrote back the addon list from their pause after it ended, so SlickSync put their full list back.`,
    url: '/users',
    dedupeKey: `screen-time-after-pause:${person.id}:${watch.until}:${(watch.tries || 0) + 1}`,
  }).catch(() => {})
  return true
}

/** One look across every account with a limit or a pause. Returns the alerts sent. */
async function checkScreenTime(prisma, { now = new Date(), emit, deps = {} } = {}) {
  const fire = emit || require('./automation/engine').emitAutomationEvent
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  let sent = 0
  for (const account of accounts) {
    let cfg = account.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    const limits = new Map(Object.entries(cfg?.screenTime || {}).map(([userId, raw]) => [userId, cleanLimit(raw)]).filter(([, l]) => l))
    const pauses = cfg?.[PAUSES] || {}
    // Also anyone whose Jellyfin server still has a bedtime SlickSync wrote,
    // so one switched off is always taken away.
    const ids = [...new Set([...limits.keys(), ...Object.keys(pauses), ...Object.keys(cfg?.jellyfinBedtime || {}), ...Object.keys(cfg?.[AFTER_PAUSE] || {})])]
    if (!ids.length) continue
    try {
      const timezone = await resolveAccountTimezone(prisma, account.id)
      const today = accountToday(timezone, now)
      const people = await prisma.user.findMany({ where: { accountId: account.id, id: { in: ids } }, select: PERSON_SELECT })
      const byId = new Map(people.map((p) => [p.id, p]))
      const seconds = await secondsToday(prisma, account.id, people.map((p) => p.id), timezone, now)

      for (const userId of ids) {
        const person = byId.get(userId)
        // Read each time: a change for one person rewrites the whole settings.
        const entry = (await readSync(prisma, account.id)).cfg[PAUSES]?.[userId]
        if (!person) { if (entry) await patchEntry(prisma, account.id, PAUSES, userId, null); continue }
        // An inactive person's limit waits; a pause they're under still ends.
        const limit = person.isActive === false ? null : limits.get(userId) || null
        const watched = Math.floor((seconds.get(userId) || 0) / 60)
        const ctx = { entry, today, now, timezone, watched }

        // A note from an earlier day is done with.
        if (entry && !pauseInForce(entry) && entry.resumedOn !== today.date && !(entry.skipNight && bedtimeWindow(limit?.bedtime, timezone, now)?.night === entry.skipNight)) {
          await patchEntry(prisma, account.id, PAUSES, userId, null)
          ctx.entry = undefined
        }

        let pausedNow = false
        let want = null
        try {
          ({ pausedNow, want } = await reconcile(prisma, account.id, person, limit, ctx, deps))
        } catch (e) {
          console.warn(`[ScreenTime] pausing ${userId}:`, e?.message)
        }
        if (limit) await warnScreens(prisma, account.id, person, limit, ctx, deps).catch(() => {})
        if (limit) await warnPerson(prisma, account.id, person, limit, ctx, deps).catch(() => {})
        if (pausedNow && want) await tellPersonPaused(prisma, account.id, person, want, timezone, deps)
        {
          // Read fresh: reconcile may have just ended a pause and started the watch.
          const fresh = (await readSync(prisma, account.id)).cfg
          const watch = fresh[AFTER_PAUSE]?.[userId]
          if (watch) await guardAfterPause(prisma, account.id, person, watch, { now, entry: fresh[PAUSES]?.[userId] }, deps)
            .catch((e) => console.warn(`[ScreenTime] after ${userId}'s pause:`, e?.message))
        }
        await syncServerBedtime(prisma, account.id, person, limit, { timezone, now }, deps)

        // The limit's own alert: once a day, whether or not it pauses.
        if (!limit?.minutes || !appliesToday(limit, today.weekday) || watched < limit.minutes) continue
        const name = person.username || 'Someone'
        const pausedForLimit = pausedNow && !!want?.budgetDay
        const dedupeKey = `screentime:${userId}:${today.date}`
        if (!(await alreadySent(prisma, account.id, dedupeKey))) {
          await send(prisma, account.id, {
            title: `${name} reached today's ${limit.minutes}-minute limit`,
            body: `${name} has watched ${watched} minutes today.${pausedForLimit ? ` Streaming is paused until ${untilLabelFor(timezone, want.until)}.` : ''}`,
            url: `/users/${userId}`,
            dedupeKey,
          })
          await fire(prisma, account.id, 'watch.budget_exceeded', {
            username: person.username, userId, minutesWatched: watched, limitMinutes: limit.minutes,
          }).catch(() => {})
          sent++
        } else if (pausedForLimit) {
          // Switched to pausing after today's alert had already gone out.
          await send(prisma, account.id, {
            title: `${name}'s streaming is paused until ${untilLabelFor(timezone, want.until)}`,
            body: `${name} is past today's ${limit.minutes}-minute limit.`,
            url: `/users/${userId}`,
            dedupeKey: `screentime-pause:${userId}:${today.date}`,
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
  getLimit, setLimit, resume, checkScreenTime, scheduleScreenTime, cleanLimit, cleanBedtime, accountToday, nextAccountMidnight, nextAccountTime,
  bedtimeWindow, isStreamingPaused, servesStreams, CHECK_INTERVAL_MS,
  // For jellyfinBedtime.js, which keeps its state beside the pauses.
  readSync, patchEntry, pauseInForce,
  forgetWarningsForTests: () => warned.clear(),
}
