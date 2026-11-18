// Superadmin alerts and the panel's own sign-in log.
//
// Privacy boundary (same as the rest of the panel, see routes/superadmin.js):
// alerts carry counts and the first 8 characters of an account id, never a
// name, nickname, email or anything from inside an account. Watch history is
// not counted anywhere here. A panel sign-in keeps a shortened address and the
// browser family only - the full address and user agent are never stored.
const { dayKey } = require('./lastUsed')

const DEFAULT_SETTINGS = { signupSurge: true, fastGrowth: true, wrongPasswords: true, discord: true }
const SURGE_COUNT = 10
const SURGE_WINDOW_MS = 60 * 60 * 1000
const GROWTH_COUNT = 200
const WRONG_COUNT = 5
const WRONG_WINDOW_MS = 15 * 60 * 1000
const KEEP_MS = 90 * 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 10 * 60 * 1000

// ---- What gets stored about a panel sign-in ---------------------------------

/** "203.0.113.47" -> "203.0.113.x"; IPv6 keeps its first three groups. */
function shortAddress(ip) {
  let s = String(ip || '').trim().replace(/%.*$/, '')
  if (s.startsWith('::ffff:')) s = s.slice(7)
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) {
    const groups = (s.includes('::') ? s.split('::')[0] : s).split(':').filter(Boolean)
    return `${groups.slice(0, 3).join(':')}:…`
  }
  return 'unknown address'
}

/** "Firefox on Windows" from a user agent; nothing else of it is kept. */
function browserFamily(ua) {
  const s = String(ua || '')
  const browser = /\bEdg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(s) ? 'Opera'
    : /\bSamsungBrowser\//.test(s) ? 'Samsung Internet'
    : /\bFirefox\/|\bFxiOS\//.test(s) ? 'Firefox'
    : /\bDuckDuckGo\//.test(s) ? 'DuckDuckGo'
    : /Chrome\/|\bCriOS\/|\bChromium\//.test(s) ? 'Chrome' // also HeadlessChrome/
    : /\bSafari\//.test(s) ? 'Safari'
    : null
  const system = /\biPhone\b/.test(s) ? 'iPhone'
    : /\biPad\b/.test(s) ? 'iPad'
    : /\bAndroid\b/.test(s) ? 'Android'
    : /\bCrOS\b/.test(s) ? 'ChromeOS'
    : /\bWindows\b/.test(s) ? 'Windows'
    : /\bMacintosh\b|\bMac OS X\b/.test(s) ? 'Mac'
    : /\bLinux\b/.test(s) ? 'Linux'
    : null
  if (browser && system) return `${browser} on ${system}`
  if (browser) return browser
  return system ? `A browser on ${system}` : 'Unknown browser'
}

// ---- Switches ----------------------------------------------------------------

async function readSetting(prisma, key) {
  const row = await prisma.superadminSetting.findUnique({ where: { key } })
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

async function writeSetting(prisma, key, value) {
  const json = JSON.stringify(value)
  await prisma.superadminSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } })
}

async function getAlertSettings(prisma) {
  const saved = await readSetting(prisma, 'alerts').catch(() => null)
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
}

async function saveAlertSettings(prisma, patch = {}) {
  const next = await getAlertSettings(prisma)
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in patch) next[k] = !!patch[k]
  await writeSetting(prisma, 'alerts', next)
  return next
}

// ---- Raising and sending an alert --------------------------------------------

function alertText(a) {
  if (a.type === 'signupSurge') return `Sign-up surge: ${a.count} new accounts within an hour`
  if (a.type === 'fastGrowth') return `Fast-growing account: ${a.shortId} added ${a.count} records today`
  if (a.type === 'wrongPasswords') return `Wrong passwords: ${a.count} tries on the Superadmin page from ${a.address || 'several addresses'}`
  return 'Superadmin alert'
}

async function deliver(prisma, alert, settings, deps) {
  const text = alertText(alert)
  const sendPush = deps.sendPush || require('./pushNotifications').sendPushToSubscription
  const subs = await prisma.superadminPushSubscription.findMany().catch(() => [])
  for (const s of subs) {
    const result = await sendPush(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      { title: 'SlickSync alert', body: text, url: '/superadmin', tag: `superadmin-${alert.type}` },
    ).catch(() => 'failed')
    if (result === 'gone') await prisma.superadminPushSubscription.delete({ where: { id: s.id } }).catch(() => {})
  }
  const webhook = (process.env.SUPERADMIN_NOTIFY_WEBHOOK_URL || '').trim()
  if (settings.discord && webhook) {
    const postDiscord = deps.postDiscord || require('./notify').postDiscord
    await postDiscord(webhook, `⚠️ SlickSync alert - ${text}.`).catch(() => {})
  }
}

/** Records an alert and sends it, unless its switch is off. Returns the row or null. */
async function raiseAlert(prisma, { type, count, shortId = null, address = null }, deps = {}, now = new Date()) {
  const settings = await getAlertSettings(prisma)
  if (!settings[type]) return null
  const alert = await prisma.superadminAlert.create({
    data: { type, count, shortId, address, day: dayKey(now), createdAt: now },
  })
  await deliver(prisma, alert, settings, deps).catch(() => {})
  return alert
}

// ---- Panel sign-ins ----------------------------------------------------------

/**
 * Logs one attempt at the Superadmin password. Wrong passwords from the same
 * address and browser within 15 minutes are one row with a count; 5 or more
 * wrong passwords within 15 minutes (from anywhere) raise one alert.
 */
async function recordPanelSignin(prisma, { ok, ip, userAgent }, deps = {}, now = new Date()) {
  const address = shortAddress(ip)
  const browser = browserFamily(userAgent)
  if (ok) {
    return prisma.superadminSignin.create({ data: { ok: true, address, browser, firstAt: now, lastAt: now } })
  }
  const since = new Date(now.getTime() - WRONG_WINDOW_MS)
  const run = await prisma.superadminSignin.findFirst({
    where: { ok: false, address, browser, firstAt: { gte: since } },
    orderBy: { firstAt: 'desc' },
  })
  const row = run
    ? await prisma.superadminSignin.update({ where: { id: run.id }, data: { count: { increment: 1 }, lastAt: now } })
    : await prisma.superadminSignin.create({ data: { ok: false, address, browser, firstAt: now, lastAt: now } })

  const recent = await prisma.superadminSignin.findMany({ where: { ok: false, firstAt: { gte: since } }, select: { count: true, address: true } })
  const total = recent.reduce((n, r) => n + r.count, 0)
  if (total >= WRONG_COUNT) {
    const already = await prisma.superadminAlert.findFirst({ where: { type: 'wrongPasswords', createdAt: { gte: since } } })
    if (!already) {
      const from = new Set(recent.map((r) => r.address))
      await raiseAlert(prisma, { type: 'wrongPasswords', count: total, address: from.size === 1 ? [...from][0] : null }, deps, now)
    }
  }
  return row
}

// ---- Counts (setup only - watch history is never counted) --------------------

const SETUP_TABLES = ['user', 'group', 'addon', 'customList', 'vaultEntry']

/** One grouped count per table: { user: Map(accountId -> n), ... }. */
async function countSetup(prisma) {
  const maps = await Promise.all(SETUP_TABLES.map(async (model) => {
    const rows = await prisma[model].groupBy({ by: ['accountId'], _count: { _all: true } })
    return new Map(rows.map((r) => [r.accountId, r._count._all]))
  }))
  return Object.fromEntries(SETUP_TABLES.map((t, i) => [t, maps[i]]))
}

function setupTotal(counts, accountId) {
  return SETUP_TABLES.reduce((n, t) => n + (counts[t].get(accountId) || 0), 0)
}

// ---- The timed checks --------------------------------------------------------

async function checkSignupSurge(prisma, deps = {}, now = new Date()) {
  const since = new Date(now.getTime() - SURGE_WINDOW_MS)
  const n = await prisma.appAccount.count({ where: { createdAt: { gte: since } } })
  if (n < SURGE_COUNT) return null
  const already = await prisma.superadminAlert.findFirst({ where: { type: 'signupSurge', createdAt: { gte: since } } })
  if (already) return null
  return raiseAlert(prisma, { type: 'signupSurge', count: n }, deps, now)
}

/**
 * An account that added 200 or more setup records since the start of the day.
 * Each account's count at the start of the day is kept (counts only); an
 * account that signed up today starts from zero. One alert per account a day.
 */
async function checkFastGrowth(prisma, deps = {}, now = new Date()) {
  const today = dayKey(now)
  const counts = await countSetup(prisma)
  const accounts = await prisma.appAccount.findMany({ select: { id: true, uuid: true, createdAt: true } })
  const base = await readSetting(prisma, 'growthBaseline').catch(() => null)
  if (!base || base.day !== today || typeof base.totals !== 'object') {
    const totals = Object.fromEntries(accounts.map((a) => [a.id, setupTotal(counts, a.id)]))
    await writeSetting(prisma, 'growthBaseline', { day: today, totals, alerted: [] })
    return []
  }
  const alerted = new Set(Array.isArray(base.alerted) ? base.alerted : [])
  const grown = []
  for (const a of accounts) {
    const n = setupTotal(counts, a.id)
    if (!(a.id in base.totals)) base.totals[a.id] = dayKey(new Date(a.createdAt)) === today ? 0 : n
    if (alerted.has(a.id)) continue
    const added = n - base.totals[a.id]
    if (added >= GROWTH_COUNT) {
      alerted.add(a.id)
      grown.push({ shortId: String(a.uuid || a.id).slice(0, 8), added })
    }
  }
  // Deleted accounts drop out of the start-of-day counts.
  const live = new Set(accounts.map((a) => a.id))
  for (const id of Object.keys(base.totals)) if (!live.has(id)) delete base.totals[id]
  await writeSetting(prisma, 'growthBaseline', { day: today, totals: base.totals, alerted: [...alerted].filter((id) => live.has(id)) })
  const raised = []
  for (const g of grown) {
    const alert = await raiseAlert(prisma, { type: 'fastGrowth', count: g.added, shortId: g.shortId }, deps, now)
    if (alert) raised.push(alert)
  }
  return raised
}

async function pruneOld(prisma, now = new Date()) {
  const before = new Date(now.getTime() - KEEP_MS)
  await prisma.superadminAlert.deleteMany({ where: { createdAt: { lt: before } } }).catch(() => {})
  await prisma.superadminSignin.deleteMany({ where: { lastAt: { lt: before } } }).catch(() => {})
}

async function runAlertChecks(prisma, deps = {}, now = new Date()) {
  for (const check of [checkSignupSurge, checkFastGrowth]) {
    try { await check(prisma, deps, now) } catch (e) { console.warn('[Superadmin] Alert check failed:', e?.message) }
  }
  await pruneOld(prisma, now)
}

/** Boot: fill in last-used days, then run the checks every 10 minutes while the panel is on. */
function startSuperadminAlerts(prisma) {
  setTimeout(() => {
    require('./lastUsed').backfillLastUsed(prisma).catch((e) => console.warn('[Superadmin] Last-used backfill failed:', e?.message))
  }, 60 * 1000).unref?.()
  if (!(process.env.SUPERADMIN_PASSWORD || '').trim()) return false
  setTimeout(() => runAlertChecks(prisma), 2 * 60 * 1000).unref?.()
  setInterval(() => runAlertChecks(prisma), CHECK_EVERY_MS).unref?.()
  return true
}

module.exports = {
  shortAddress, browserFamily,
  getAlertSettings, saveAlertSettings, alertText, raiseAlert,
  recordPanelSignin, countSetup, setupTotal,
  checkSignupSurge, checkFastGrowth, runAlertChecks, pruneOld, startSuperadminAlerts,
  DEFAULT_SETTINGS,
}
