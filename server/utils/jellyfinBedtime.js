// A bedtime written into a real Jellyfin server's own access schedule, so the
// server refuses at bedtime by itself - even if SlickSync is restarting or
// down at that minute. SlickSync's own pause still runs alongside it
// (screenTime.js: the banner, Resume now, Stop what's playing); this is the
// backstop, and it is the same parental schedule Jellyfin's dashboard edits.
//
// Jellyfin reads an access schedule against its own clock (server local
// time - Jellyfin.Data UserEntityExtensions.IsParentalScheduleAllowed), and
// says nothing about its time zone except in its log lines, which end their
// timestamp with the UTC offset ("[2026-10-06 21:00:01.123 -07:00]"). So the
// offset is read from the newest log - through the administrator sign-in a
// Jellyfin pause already needs - and the bedtime, set on the account's clock,
// is moved onto the server's. Without an offset nothing is written: a
// schedule on the wrong clock would block the wrong hours.
//
// A schedule lists the hours someone MAY watch, day by day; a day left out
// is closed all day, and an empty list leaves every hour open. Only a
// schedule that is empty or exactly the one SlickSync last wrote is replaced:
// one an administrator set on the server is theirs, and stays (SlickSync's
// own pause still covers bedtime for them then).

const DAY = 24 * 60
const WEEK = 7 * DAY
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STATE_KEY = 'jellyfinBedtime'
const OFFSET_TTL_MS = 6 * 60 * 60 * 1000
const VERIFY_MS = 15 * 60 * 1000

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}
const round = (n) => Math.round(n * 10000) / 10000

/** Minutes the time zone is ahead of UTC at `date`. */
function tzOffsetMinutes(timezone, date = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]))
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
  } catch {
    return 0
  }
}

/** The UTC offset of the newest timestamp in a Jellyfin log, in minutes - or null. */
function offsetFromLog(text) {
  const re = /\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} ([+-])(\d\d):(\d\d)\]/g
  let last = null
  let m
  while ((m = re.exec(String(text || '')))) last = m
  if (!last) return null
  return (last[1] === '-' ? -1 : 1) * (Number(last[2]) * 60 + Number(last[3]))
}

/**
 * The access schedule for a bedtime: the hours outside it, day by day on the
 * server's clock. `skipNight` (an account date) leaves that night open - Resume
 * now. Empty when there is nothing to close.
 */
function scheduleFor(bedtime, { accountOffset = 0, serverOffset = 0, skipNight = null } = {}) {
  const from = minutesOf(bedtime?.from)
  const to = minutesOf(bedtime?.to)
  if (from === null || to === null || from === to) return []
  const nights = Array.isArray(bedtime.days) && bedtime.days.length ? bedtime.days : [0, 1, 2, 3, 4, 5, 6]
  const skipDay = skipNight ? new Date(`${skipNight}T12:00:00Z`).getUTCDay() : null
  // Server time = account time + shift.
  const shift = serverOffset - accountOffset
  const length = to > from ? to - from : DAY - from + to
  const closed = []
  for (const d of nights) {
    if (d === skipDay) continue
    const start = (((d * DAY + from + shift) % WEEK) + WEEK) % WEEK
    const end = start + length
    if (end <= WEEK) closed.push([start, end])
    else { closed.push([start, WEEK]); closed.push([0, end - WEEK]) }
  }
  if (!closed.length) return []
  closed.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of closed) {
    const prev = merged[merged.length - 1]
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e)
    else merged.push([s, e])
  }
  const open = []
  let at = 0
  for (const [s, e] of merged) {
    if (s > at) open.push([at, s])
    at = Math.max(at, e)
  }
  if (at < WEEK) open.push([at, WEEK])
  const out = []
  for (let d = 0; d < 7; d++) {
    for (const [s, e] of open) {
      const a = Math.max(s, d * DAY)
      const b = Math.min(e, (d + 1) * DAY)
      if (b > a) out.push({ DayOfWeek: DAY_NAMES[d], StartHour: round((a - d * DAY) / 60), EndHour: round((b - d * DAY) / 60) })
    }
  }
  return out
}

const plain = (list) => (Array.isArray(list) ? list : []).map(({ DayOfWeek, StartHour, EndHour }) => ({ DayOfWeek: String(DayOfWeek), StartHour: round(Number(StartHour)), EndHour: round(Number(EndHour)) }))
const sameSchedule = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b))

// Per server address: { offset, at }. And per person: what was last checked
// on the server and when, so the minute check reads the server only when
// something changed or a while has passed.
const offsets = new Map()
const verified = new Map()

async function serverOffset(ctx, call) {
  const key = ctx.session?.serverUrl || ctx.person?.jellyfinServerUrl || ''
  const known = offsets.get(key)
  if (known && Date.now() - known.at < OFFSET_TTL_MS) return known.offset
  let offset = null
  try {
    const logs = await call(ctx.session, '/System/Logs')
    const newest = (Array.isArray(logs) ? logs : []).filter((l) => l?.Name).sort((a, b) => Date.parse(b.DateModified || 0) - Date.parse(a.DateModified || 0))[0]
    if (newest) offset = offsetFromLog(await call(ctx.session, `/System/Logs/Log?name=${encodeURIComponent(newest.Name)}`))
  } catch { /* unknown - nothing is written */ }
  offsets.set(key, { offset, at: Date.now() })
  return offset
}

/**
 * Bring someone's Jellyfin access schedule in line with their bedtime.
 * `limit` null (or no bedtime) takes SlickSync's schedule away again. Skipped
 * while a SlickSync pause holds their schedule - ending the pause puts this
 * one back, and the next check refreshes it.
 */
async function syncBedtimeSchedule(prisma, accountId, person, limit, { entry, timezone, now = new Date() } = {}, deps = {}) {
  const st = deps.screenTime || require('./screenTime')
  const { readSync, patchEntry } = st
  if (!person || person.providerType !== 'jellyfin' || (person.jellyfinServerKind && person.jellyfinServerKind !== 'jellyfin')) return 'not-jellyfin'
  if (st.pauseInForce(entry)) return 'paused'
  const { cfg } = await readSync(prisma, accountId)
  const mine = cfg[STATE_KEY]?.[person.id]?.schedule || null
  const bedtime = person.isActive === false ? null : limit?.bedtime || null
  if (!bedtime && !mine) return 'nothing'

  const ctx = await (deps.adminContext || require('./jellyfinParental').adminContext)(prisma, deps.decrypt || require('./encryption').decrypt, accountId, person.id).catch(() => null)
  if (!ctx?.available || !ctx.session) return 'no-admin'
  const call = deps.call || require('./jellyfinServerCollections').call

  let desired = []
  if (bedtime) {
    const offset = await serverOffset(ctx, call)
    if (offset === null) desired = null
    else {
      const bed = st.bedtimeWindow(bedtime, timezone, now)
      const skipNight = entry?.skipNight && bed?.night === entry.skipNight ? entry.skipNight : null
      desired = scheduleFor(bedtime, { accountOffset: tzOffsetMinutes(timezone, now), serverOffset: offset, skipNight })
    }
  }
  // Server clock unknown: take ours away rather than leave a wrong one.
  if (desired === null) desired = []

  const memo = verified.get(person.id)
  const wantKey = JSON.stringify(plain(desired))
  if (memo && memo.want === wantKey && Date.now() - memo.at < VERIFY_MS) return 'unchanged'

  const path = `/Users/${ctx.person.jellyfinUserId}`
  const policy = (await call(ctx.session, path))?.Policy
  if (!policy) return 'no-policy'
  const current = Array.isArray(policy.AccessSchedules) ? policy.AccessSchedules : []
  const ours = !current.length || (mine && sameSchedule(current, mine))
  if (!ours) {
    // An administrator's own schedule: theirs. Forget ours if it was replaced.
    if (mine) await patchEntry(prisma, accountId, STATE_KEY, person.id, null)
    verified.set(person.id, { want: wantKey, at: Date.now() })
    return 'theirs'
  }
  if (!sameSchedule(current, desired)) {
    await call(ctx.session, `${path}/Policy`, { method: 'POST', body: { ...policy, AccessSchedules: desired } })
  }
  const nextState = desired.length ? { schedule: plain(desired), at: now.toISOString() } : null
  if (JSON.stringify(nextState?.schedule || null) !== JSON.stringify(mine)) await patchEntry(prisma, accountId, STATE_KEY, person.id, nextState)
  verified.set(person.id, { want: wantKey, at: Date.now() })
  return desired.length ? 'written' : 'cleared'
}

function forgetForTests() {
  offsets.clear()
  verified.clear()
}

module.exports = { scheduleFor, offsetFromLog, tzOffsetMinutes, syncBedtimeSchedule, sameSchedule, STATE_KEY, forgetForTests }
