// Superadmin alerts, the panel's own sign-in log, and "last used" by day.
// Privacy is part of the contract here: alerts carry counts and a short id,
// a sign-in keeps a shortened address and a browser family, and "last used"
// is a day - never a time.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')

const signals = require('../server/utils/superadminAlerts')
const lastUsed = require('../server/utils/lastUsed')
const makeSuperadminRouter = require('../server/routes/superadmin')

// ---------------------------------------------------------------- a tiny database

let seq = 0
function matches(row, where = {}) {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('gte' in cond && !(v >= cond.gte)) return false
      if ('lt' in cond && !(v < cond.lt)) return false
      if ('not' in cond && (cond.not === null ? v == null : v === cond.not)) return false
      if ('in' in cond && !cond.in.includes(v)) return false
      return true
    }
    return cond instanceof Date ? +v === +cond : v === cond
  })
}
function pick(row, select) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}
function table(rows = [], key = 'id', defaults = () => ({})) {
  const t = {
    rows,
    findUnique: async ({ where, select }) => { const r = rows.find((x) => matches(x, where)); return r ? pick(r, select) : null },
    findFirst: async ({ where, orderBy } = {}) => (await t.findMany({ where, orderBy }))[0] || null,
    findMany: async ({ where, orderBy, take, select } = {}) => {
      let out = rows.filter((r) => matches(r, where))
      if (orderBy) {
        const [[f, dir]] = Object.entries(orderBy)
        out = [...out].sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
      }
      if (take) out = out.slice(0, take)
      return out.map((r) => pick(r, select))
    },
    create: async ({ data }) => { const r = { [key]: `id${++seq}`, ...defaults(), ...data }; rows.push(r); return { ...r } },
    update: async ({ where, data }) => {
      const r = rows.find((x) => matches(x, where))
      if (!r) throw new Error('not found')
      for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? r[k] + v.increment : v
      return { ...r }
    },
    upsert: async ({ where, create, update }) => {
      const r = rows.find((x) => matches(x, where))
      return r ? t.update({ where, data: update }) : t.create({ data: create })
    },
    delete: async ({ where }) => { const i = rows.findIndex((x) => matches(x, where)); if (i < 0) throw new Error('not found'); return rows.splice(i, 1)[0] },
    deleteMany: async ({ where } = {}) => { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1); return { count: before - rows.length } },
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
    groupBy: async ({ by }) => {
      const counts = new Map()
      for (const r of rows) counts.set(r[by[0]], (counts.get(r[by[0]]) || 0) + 1)
      return [...counts].map(([accountId, n]) => ({ accountId, _count: { _all: n } }))
    },
  }
  return t
}
function fakePrisma({ accounts = [], setup = {} } = {}) {
  const prisma = {
    appAccount: table(accounts),
    superadminSetting: table([], 'key'),
    superadminAlert: table([], 'id', () => ({ createdAt: new Date() })),
    superadminSignin: table([], 'id', () => ({ count: 1 })),
    superadminPushSubscription: table(),
    superadminAuditLog: table(),
  }
  for (const t of ['user', 'group', 'addon', 'customList', 'vaultEntry']) {
    prisma[t] = table((setup[t] || []).map((accountId) => ({ id: `${t}${++seq}`, accountId })))
  }
  // Watch history must never be read for the panel.
  prisma.watchSession = { groupBy: async () => { throw new Error('watch history was counted') }, count: async () => { throw new Error('watch history was counted') } }
  return prisma
}

const at = (iso) => new Date(iso)
const silent = { sendPush: async () => 'sent', postDiscord: async () => {} }

// ---------------------------------------------------------------- what is kept

test('a panel sign-in keeps a shortened address and the browser family only', () => {
  assert.equal(signals.shortAddress('203.0.113.47'), '203.0.113.x')
  assert.equal(signals.shortAddress('::ffff:198.51.100.9'), '198.51.100.x')
  assert.equal(signals.shortAddress('2001:db8:4a2c:12:abcd::1'), '2001:db8:4a2c:…')
  assert.equal(signals.shortAddress(''), 'unknown address')
  const ua = {
    firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  }
  assert.equal(signals.browserFamily(ua.firefoxWin), 'Firefox on Windows')
  assert.equal(signals.browserFamily(ua.chromeAndroid), 'Chrome on Android')
  assert.equal(signals.browserFamily(ua.safariIphone), 'Safari on iPhone')
  assert.equal(signals.browserFamily(ua.edgeWin), 'Edge on Windows')
  assert.equal(signals.browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36'), 'Chrome on Windows')
  assert.equal(signals.browserFamily(''), 'Unknown browser')
})

// ---------------------------------------------------------------- wrong passwords

test('wrong passwords group into one run and 5 within 15 minutes raise one alert', async () => {
  const prisma = fakePrisma()
  const sent = []
  const deps = { sendPush: async () => 'sent', postDiscord: async (url, text) => { sent.push(text) } }
  process.env.SUPERADMIN_NOTIFY_WEBHOOK_URL = 'https://discord.example.com/api/webhooks/1/x'
  try {
    const t0 = Date.parse('2026-11-16T05:58:00Z')
    for (let i = 0; i < 6; i++) {
      await signals.recordPanelSignin(prisma, { ok: false, ip: '203.0.113.47', userAgent: 'Firefox/132.0 (Windows NT 10.0)' }, deps, new Date(t0 + i * 60000))
    }
    const runs = prisma.superadminSignin.rows
    assert.equal(runs.length, 1)
    assert.equal(runs[0].count, 6)
    assert.equal(runs[0].address, '203.0.113.x')
    assert.ok(!JSON.stringify(runs).includes('203.0.113.47'), 'the full address is never stored')
    const alerts = prisma.superadminAlert.rows
    assert.equal(alerts.length, 1, 'one alert for the run, not one per try')
    assert.deepEqual({ type: alerts[0].type, count: alerts[0].count, address: alerts[0].address }, { type: 'wrongPasswords', count: 5, address: '203.0.113.x' })
    assert.equal(sent.length, 1)
    assert.match(sent[0], /Wrong passwords: 5 tries on the Superadmin page from 203\.0\.113\.x/)

    // 20 minutes later: a new run.
    await signals.recordPanelSignin(prisma, { ok: false, ip: '203.0.113.47', userAgent: 'Firefox/132.0 (Windows NT 10.0)' }, deps, new Date(t0 + 20 * 60000))
    assert.equal(prisma.superadminSignin.rows.length, 2)
  } finally {
    delete process.env.SUPERADMIN_NOTIFY_WEBHOOK_URL
  }
})

test('four wrong passwords stay quiet, and a switched-off alert is never raised', async () => {
  const prisma = fakePrisma()
  const t0 = Date.parse('2026-11-16T05:58:00Z')
  for (let i = 0; i < 4; i++) await signals.recordPanelSignin(prisma, { ok: false, ip: '198.51.100.2' }, silent, new Date(t0 + i * 1000))
  assert.equal(prisma.superadminAlert.rows.length, 0)
  await signals.saveAlertSettings(prisma, { wrongPasswords: false })
  for (let i = 0; i < 4; i++) await signals.recordPanelSignin(prisma, { ok: false, ip: '198.51.100.2' }, silent, new Date(t0 + 10000 + i * 1000))
  assert.equal(prisma.superadminAlert.rows.length, 0)
})

// ---------------------------------------------------------------- sign-up surge

test('10 sign-ups within an hour raise one surge alert', async () => {
  const now = at('2026-11-18T10:14:00Z')
  const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, uuid: `uuid-${i}`, createdAt: new Date(now.getTime() - i * 4 * 60000) }))
  accounts.push({ id: 'old', uuid: 'uuid-old', createdAt: at('2026-10-01T00:00:00Z') })
  const prisma = fakePrisma({ accounts })
  const first = await signals.checkSignupSurge(prisma, silent, now)
  assert.equal(first.count, 12)
  assert.equal(await signals.checkSignupSurge(prisma, silent, new Date(now.getTime() + 10 * 60000)), null, 'not again within the hour')
  const quiet = fakePrisma({ accounts: accounts.slice(0, 9) })
  assert.equal(await signals.checkSignupSurge(quiet, silent, now), null)
})

// ---------------------------------------------------------------- fast-growing account

test('an account that adds 200 setup records in a day raises one alert with its short id', async () => {
  const accounts = [
    { id: 'acct-big', uuid: 'b40c7d19-5e2f-4a83-9c61-f8e2a4d03b57', createdAt: at('2026-11-01T00:00:00Z'), displayName: 'Maple Street' },
    { id: 'acct-small', uuid: 'e93d0f61-2c4b-4d8a-b7e5-6a1f3c9d2e84', createdAt: at('2026-11-01T00:00:00Z') },
  ]
  const prisma = fakePrisma({ accounts, setup: { addon: ['acct-big', 'acct-small'] } })
  const morning = at('2026-11-17T16:00:00Z')
  assert.deepEqual(await signals.checkFastGrowth(prisma, silent, morning), [], 'the first look only notes where everyone starts')

  for (let i = 0; i < 120; i++) prisma.user.rows.push({ id: `u${i}`, accountId: 'acct-big' })
  for (let i = 0; i < 90; i++) prisma.addon.rows.push({ id: `a${i}`, accountId: 'acct-big' })
  for (let i = 0; i < 30; i++) prisma.addon.rows.push({ id: `s${i}`, accountId: 'acct-small' })
  const raised = await signals.checkFastGrowth(prisma, silent, at('2026-11-17T20:00:00Z'))
  assert.equal(raised.length, 1)
  assert.deepEqual({ type: raised[0].type, count: raised[0].count, shortId: raised[0].shortId }, { type: 'fastGrowth', count: 210, shortId: 'b40c7d19' })
  const stored = JSON.stringify(prisma.superadminAlert.rows)
  assert.ok(!stored.includes('Maple Street') && !stored.includes('acct-big'), 'no nickname, no full id')

  for (let i = 0; i < 250; i++) prisma.user.rows.push({ id: `v${i}`, accountId: 'acct-big' })
  assert.deepEqual(await signals.checkFastGrowth(prisma, silent, at('2026-11-17T22:00:00Z')), [], 'once a day per account')
  // Next day starts over from where everyone is now.
  assert.deepEqual(await signals.checkFastGrowth(prisma, silent, at('2026-11-18T16:00:00Z')), [])
})

test('watch history is never counted, for the quota or for growth', async () => {
  const prisma = fakePrisma({ accounts: [{ id: 'a', uuid: 'uuid-a', createdAt: at('2026-11-01T00:00:00Z') }] })
  await signals.checkFastGrowth(prisma, silent, at('2026-11-17T16:00:00Z'))
  await signals.checkFastGrowth(prisma, silent, at('2026-11-17T17:00:00Z'))
  const counts = await signals.countSetup(prisma)
  assert.deepEqual(Object.keys(counts).sort(), ['addon', 'customList', 'group', 'user', 'vaultEntry'])
})

// ---------------------------------------------------------------- delivery

test('push goes to every panel browser, a gone one is dropped; Discord only when set and on', async () => {
  const prisma = fakePrisma()
  prisma.superadminPushSubscription.rows.push(
    { id: 'p1', endpoint: 'https://fcm.googleapis.com/fcm/send/live', p256dh: 'k', auth: 'a' },
    { id: 'p2', endpoint: 'https://fcm.googleapis.com/fcm/send/gone', p256dh: 'k', auth: 'a' },
  )
  const pushed = []
  const discord = []
  const deps = {
    sendPush: async (sub, payload) => { pushed.push(payload); return sub.endpoint.endsWith('gone') ? 'gone' : 'sent' },
    postDiscord: async (url, text) => { discord.push(text) },
  }
  await signals.raiseAlert(prisma, { type: 'signupSurge', count: 12 }, deps)
  assert.equal(pushed.length, 2)
  assert.deepEqual(pushed[0], { title: 'SlickSync alert', body: 'Sign-up surge: 12 new accounts within an hour', url: '/superadmin', tag: 'superadmin-signupSurge' })
  assert.deepEqual(prisma.superadminPushSubscription.rows.map((r) => r.id), ['p1'])
  assert.equal(discord.length, 0, 'no webhook set')

  process.env.SUPERADMIN_NOTIFY_WEBHOOK_URL = 'https://discord.example.com/api/webhooks/1/x'
  try {
    await signals.raiseAlert(prisma, { type: 'signupSurge', count: 11 }, deps)
    assert.equal(discord.length, 1)
    await signals.saveAlertSettings(prisma, { discord: false })
    await signals.raiseAlert(prisma, { type: 'signupSurge', count: 10 }, deps)
    assert.equal(discord.length, 1, 'Discord switched off')
    assert.equal(prisma.superadminAlert.rows.length, 3, 'still recorded and pushed')
  } finally {
    delete process.env.SUPERADMIN_NOTIFY_WEBHOOK_URL
  }
})

// ---------------------------------------------------------------- last used

test('last used: a day only, once a day, and not the day the account signed up', () => {
  lastUsed.resetForTests()
  const writes = []
  const prisma = { appAccount: { update: async (q) => { writes.push(q); return q } } }
  const now = at('2026-11-18T19:45:00Z') // Nov 18, server time zone
  assert.equal(lastUsed.markUsed(prisma, { id: 'new', createdAt: at('2026-11-18T17:00:00Z'), lastActiveDay: null }, now), false, 'signing up is not coming back')
  assert.equal(lastUsed.markUsed(prisma, { id: 'old', createdAt: at('2026-11-01T00:00:00Z'), lastActiveDay: '2026-11-15' }, now), true)
  assert.equal(lastUsed.markUsed(prisma, { id: 'old', createdAt: at('2026-11-01T00:00:00Z'), lastActiveDay: '2026-11-15' }, now), false, 'once a day')
  assert.equal(lastUsed.markUsed(prisma, { id: 'same', createdAt: at('2026-11-01T00:00:00Z'), lastActiveDay: lastUsed.dayKey(now) }, now), false)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { where: { id: 'old' }, data: { lastActiveDay: lastUsed.dayKey(now) } })
  assert.match(writes[0].data.lastActiveDay, /^\d{4}-\d{2}-\d{2}$/, 'a day, never a time')
})

test('last used: filled in from the old password sign-in, with the same sign-up-day rule', async () => {
  const prisma = fakePrisma({
    accounts: [
      { id: 'back', createdAt: at('2026-11-01T18:00:00Z'), lastLoginAt: at('2026-11-10T18:00:00Z'), lastActiveDay: null },
      { id: 'sameday', createdAt: at('2026-11-01T18:00:00Z'), lastLoginAt: at('2026-11-01T19:00:00Z'), lastActiveDay: null },
      { id: 'never', createdAt: at('2026-11-01T18:00:00Z'), lastLoginAt: null, lastActiveDay: null },
      { id: 'kept', createdAt: at('2026-11-01T18:00:00Z'), lastLoginAt: at('2026-11-02T18:00:00Z'), lastActiveDay: '2026-11-17' },
    ],
  })
  assert.equal(await lastUsed.backfillLastUsed(prisma), 1)
  const day = Object.fromEntries(prisma.appAccount.rows.map((r) => [r.id, r.lastActiveDay]))
  assert.deepEqual(day, { back: '2026-11-10', sameday: null, never: null, kept: '2026-11-17' })
})

test('the auth gate records the day an account is used', async () => {
  lastUsed.resetForTests()
  const { createAuthGate } = require('../server/middleware/auth')
  const auth = require('../server/utils/auth')
  const SECRET = 'unit-test-signing-secret-not-for-use'
  const writes = []
  const prisma = {
    appAccount: {
      findUnique: async () => ({ id: 'acc1', disabled: false, createdAt: at('2026-10-01T00:00:00Z'), lastActiveDay: '2026-10-05' }),
      update: async (q) => { writes.push(q); return q },
    },
  }
  const gate = createAuthGate({
    INSTANCE_TYPE: 'public', PRIVATE_AUTH_ENABLED: false, JWT_SECRET: SECRET,
    pathIsAllowlisted: auth.pathIsAllowlisted, parseCookies: auth.parseCookies, cookieName: auth.cookieName,
    extractBearerToken: auth.extractBearerToken, issueAccessToken: auth.issueAccessToken, randomCsrfToken: auth.randomCsrfToken,
    isProdEnv: () => false, prisma,
  })
  const token = jwt.sign({ accId: 'acc1', typ: 'access' }, SECRET, { expiresIn: '1h' })
  let passed = false
  await gate({ method: 'GET', path: '/api/users', headers: { authorization: `Bearer ${token}` }, get: () => undefined }, { status: () => ({ json: () => {} }), cookie: () => {} }, () => { passed = true })
  assert.ok(passed)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].where, { id: 'acc1' })
  assert.match(writes[0].data.lastActiveDay, /^\d{4}-\d{2}-\d{2}$/)
})

// ---------------------------------------------------------------- the panel's routes

const SECRET = 'test-secret-superadmin'
async function panel(t, prisma) {
  const app = express()
  app.use(express.json())
  const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((c) => c.trim().split('=')))
  app.use('/api/superadmin', makeSuperadminRouter({ prisma, JWT_SECRET: SECRET, isProdEnv: () => false, parseCookies, alertDeps: silent }))
  const server = app.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/superadmin`
  return {
    base,
    get: (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} }),
    post: (path, body, cookie, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) }),
  }
}

test('signing in to the panel is logged, and the log marks this browser', async (t) => {
  process.env.SUPERADMIN_PASSWORD = 'correct horse'
  t.after(() => { delete process.env.SUPERADMIN_PASSWORD })
  const prisma = fakePrisma()
  const p = await panel(t, prisma)
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'
  assert.equal((await p.post('/login', { password: 'nope' }, null, { 'user-agent': UA })).status, 401)
  const ok = await p.post('/login', { password: 'correct horse' }, null, { 'user-agent': UA })
  assert.equal(ok.status, 200)
  const cookie = ok.headers.get('set-cookie').split(';')[0]
  const { entries } = await (await p.get('/signins', cookie)).json()
  assert.equal(entries.length, 2)
  const mine = entries.find((e) => e.ok)
  assert.deepEqual({ browser: mine.browser, current: mine.current }, { browser: 'Firefox on Windows', current: true })
  const wrong = entries.find((e) => !e.ok)
  assert.equal(wrong.current, false)
  assert.ok(!JSON.stringify(entries).includes('Gecko'), 'the user agent itself is not kept')
  assert.equal((await p.get('/signins')).status, 401, 'needs the panel sign-in')
})

test('alerts route: switches, fast-growth alerts by day only, push sign-up checks the address', async (t) => {
  const prisma = fakePrisma()
  const p = await panel(t, prisma)
  const cookie = `sfm_superadmin=${jwt.sign({ typ: 'superadmin' }, SECRET, { expiresIn: '1h' })}`
  await signals.raiseAlert(prisma, { type: 'fastGrowth', count: 296, shortId: 'b40c7d19' }, silent)
  await signals.raiseAlert(prisma, { type: 'signupSurge', count: 12 }, silent)
  const data = await (await p.get('/alerts', cookie)).json()
  assert.deepEqual(data.settings, signals.DEFAULT_SETTINGS)
  assert.equal(data.discordConfigured, false)
  const growth = data.recent.find((r) => r.type === 'fastGrowth')
  assert.equal(growth.at, null, 'a day, no time')
  assert.match(growth.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(data.recent.find((r) => r.type === 'signupSurge').at)

  const put = await fetch(`${p.base}/alerts`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ fastGrowth: false, bogus: true }) })
  assert.deepEqual((await put.json()).settings, { ...signals.DEFAULT_SETTINGS, fastGrowth: false })

  assert.equal((await p.post('/alerts/push', { subscription: { endpoint: 'https://example.com/push', keys: { p256dh: 'k', auth: 'a' } } }, cookie)).status, 400, 'not a push service')
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
  assert.equal((await p.post('/alerts/push', { subscription: { endpoint, keys: { p256dh: 'k', auth: 'a' } } }, cookie)).status, 200)
  assert.deepEqual(await (await p.post('/alerts/push/status', { endpoint }, cookie)).json(), { subscribed: true })
  await p.post('/alerts/push/remove', { endpoint }, cookie)
  assert.deepEqual(await (await p.post('/alerts/push/status', { endpoint }, cookie)).json(), { subscribed: false })
  assert.equal((await p.get('/alerts')).status, 401)
})
