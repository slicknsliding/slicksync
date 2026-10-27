const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const bcrypt = require('bcryptjs')

process.env.JWT_SECRET = 'unit-test-signing-secret-not-for-use'
process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-not-for-use-0123456789'
delete process.env.PRIVATE_ACCOUNT_PASSWORD
delete process.env.NODE_ENV

// The three provider sign-ins reach their providers through these; they are
// swapped before the router loads (it pulls two of them in at load time).
const stremio = require('../server/utils/stremio')
stremio.validateStremioAuthKey = async () => ({ user: { email: 'person@example.com' } })
const nuvioAuth = require('../server/providers/nuvioAuth')
nuvioAuth.exchangeNuvioTvLogin = async () => ({ refreshToken: 'nuvio-refresh', user: { id: 'nuvio-1', email: 'person@example.com' } })
const jellyfinConnect = require('../server/utils/jellyfinConnect')
jellyfinConnect.signInFromBody = async () => ({
  probe: { serverUrl: 'https://media.example.com' },
  login: { userId: 'jf-user-1', userName: 'person', serverId: 'srv-1' },
})
jellyfinConnect.rememberSignIn = async () => {}
jellyfinConnect.jellyfinFields = () => ({ providerType: 'jellyfin' })

const publicAuth = require('../server/routes/publicAuth')
const { createAuthGate } = require('../server/middleware/auth')
const {
  pathIsAllowlisted, extractBearerToken, parseCookies, cookieName, issueAccessToken, issueRefreshToken,
  randomCsrfToken, verifyAccountToken, defaultAccountPassword, replaceLegacyDefaultHash,
} = require('../server/utils/auth')

const SECRET = process.env.JWT_SECRET
const DEFAULT_UUID = '00000000-0000-4000-8000-000000000000'

// A small AppAccount table; person rows answer "known person, no stored key"
// so the provider sign-ins treat the account as theirs without re-checking.
function fakeDb(accounts) {
  const rows = accounts.map((r) => ({ uuid: null, email: null, passwordHash: null, disabled: false, twoFactorEnabled: false, ...r }))
  const find = (where) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) || null
  return {
    rows,
    prisma: {
      appAccount: {
        findUnique: async ({ where }) => find(where),
        update: async ({ where, data }) => Object.assign(find(where), data),
        create: async ({ data }) => { const row = { id: `acc-${rows.length + 1}`, disabled: false, twoFactorEnabled: false, ...data }; rows.push(row); return row },
        count: async () => rows.length,
      },
      user: {
        findFirst: async () => ({ id: 7, stremioAuthKey: null, nuvioRefreshToken: null }),
        create: async ({ data }) => ({ id: 8, ...data }),
        update: async () => ({}),
      },
    },
  }
}

async function startApp(t, { prisma, instanceType = 'public', privateAuth = null, trustProxy = false }) {
  const router = publicAuth({
    prisma,
    INSTANCE_TYPE: instanceType,
    PRIVATE_AUTH_ENABLED: !!privateAuth,
    PRIVATE_AUTH_USERNAME: privateAuth?.username ?? null,
    PRIVATE_AUTH_PASSWORD: privateAuth?.password ?? null,
    DEFAULT_ACCOUNT_ID: 'default',
    issueAccessToken,
    issueRefreshToken,
    cookieName,
    isProdEnv: () => false,
    parseCookies,
    verifyAccountToken,
    encrypt: (value) => `enc:${value}`,
    decrypt: (value) => String(value).replace(/^enc:/, ''),
  })
  const app = express()
  if (trustProxy) app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api/auth', router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/auth`
  return async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json(), setCookie: r.headers.getSetCookie() }
  }
}

// ------------------------------------------------------------- register

test('a private instance refuses to register an account', async (t) => {
  const { prisma, rows } = fakeDb([{ id: 'default', uuid: DEFAULT_UUID }])
  const post = await startApp(t, { prisma, instanceType: 'private', privateAuth: { username: 'owner', password: 'pw' } })
  const out = await post('/register', { uuid: '3f1c7a52-9b6e-4d0a-8c1e-2a5b7d9e4f10', password: 'abcd' })
  assert.equal(out.status, 400)
  assert.deepEqual(out.setCookie, [])
  assert.equal(rows.length, 1, 'no account was created')
})

test('a public instance still registers', async (t) => {
  const { prisma, rows } = fakeDb([])
  const post = await startApp(t, { prisma })
  const out = await post('/register', { uuid: '3f1c7a52-9b6e-4d0a-8c1e-2a5b7d9e4f10', password: 'abcd' })
  assert.equal(out.status, 201)
  assert.equal(rows.length, 1)
})

// ------------------------------------------------------------- auth gate

async function gateOutcome(token, kind) {
  const prisma = { appAccount: { findUnique: async () => ({ disabled: false }) } }
  const gate = createAuthGate({
    INSTANCE_TYPE: 'private', PRIVATE_AUTH_ENABLED: true, JWT_SECRET: SECRET, pathIsAllowlisted, parseCookies, cookieName,
    extractBearerToken, issueAccessToken, randomCsrfToken, isProdEnv: () => false, prisma, DEFAULT_ACCOUNT_ID: 'default',
  })
  const cookie = kind === 'refresh' ? `sfm_rt=${token}` : ''
  const req = { method: 'GET', path: '/api/users', headers: kind === 'refresh' ? { cookie } : { authorization: `Bearer ${token}` } }
  const res = { statusCode: null, status(c) { this.statusCode = c; return this }, json() { return this }, cookie() { return this } }
  let nextCalled = false
  await gate(req, res, () => { nextCalled = true })
  return { nextCalled, status: res.statusCode, accId: req.appAccountId }
}

test('in private mode only the default account\'s tokens open the gate', async () => {
  const ok = await gateOutcome(issueAccessToken('default'), 'access')
  assert.equal(ok.nextCalled, true)
  assert.equal(ok.accId, 'default')

  const stray = await gateOutcome(issueAccessToken('acc-1'), 'access')
  assert.equal(stray.nextCalled, false)
  assert.equal(stray.status, 401)

  const strayRefresh = await gateOutcome(issueRefreshToken('acc-1'), 'refresh')
  assert.equal(strayRefresh.nextCalled, false)
  assert.equal(strayRefresh.status, 401)
})

// ------------------------------------------- default account's password

test('the default account\'s uuid + well-known password is refused when private login is on', async (t) => {
  const hash = await bcrypt.hash('private-mode', 4)
  const { prisma } = fakeDb([{ id: 'default', uuid: DEFAULT_UUID, passwordHash: hash }])
  const post = await startApp(t, { prisma, instanceType: 'private', privateAuth: { username: 'owner', password: 'pw' } })
  const out = await post('/login', { uuid: DEFAULT_UUID, password: 'private-mode' })
  assert.equal(out.status, 401)
  assert.deepEqual(out.setCookie, [])
})

test('the operator login, and a private install with no login, work as before', async (t) => {
  const hash = await bcrypt.hash('private-mode', 4)
  const { prisma } = fakeDb([{ id: 'default', uuid: DEFAULT_UUID, passwordHash: hash }])
  const withLogin = await startApp(t, { prisma, instanceType: 'private', privateAuth: { username: 'owner', password: 'pw' } })
  const ok = await withLogin('/private-login', { username: 'owner', password: 'pw' })
  assert.equal(ok.status, 200)
  assert.ok(ok.setCookie.some((c) => c.startsWith('sfm_at=')))

  // No operator login configured: the uuid door is not the one being closed.
  const open = await startApp(t, { prisma, instanceType: 'private' })
  const uuidLogin = await open('/login', { uuid: DEFAULT_UUID, password: 'private-mode' })
  assert.equal(uuidLogin.status, 200)
})

test('the default password is random unless the operator chose one', () => {
  const a = defaultAccountPassword()
  assert.notEqual(a, 'private-mode')
  assert.notEqual(a, defaultAccountPassword())
  process.env.PRIVATE_ACCOUNT_PASSWORD = 'chosen'
  try { assert.equal(defaultAccountPassword(), 'chosen') } finally { delete process.env.PRIVATE_ACCOUNT_PASSWORD }
})

test('at boot an old well-known hash is replaced; anything else is left alone', async () => {
  const legacy = await bcrypt.hash('private-mode', 4)
  const fresh = await replaceLegacyDefaultHash(legacy)
  assert.ok(fresh)
  assert.equal(await bcrypt.compare('private-mode', fresh), false)

  const own = await bcrypt.hash('something-else', 4)
  assert.equal(await replaceLegacyDefaultHash(own), null)
  assert.equal(await replaceLegacyDefaultHash(null), null)

  process.env.PRIVATE_ACCOUNT_PASSWORD = 'private-mode'
  try { assert.equal(await replaceLegacyDefaultHash(legacy), null, 'an operator who chose it keeps it') } finally { delete process.env.PRIVATE_ACCOUNT_PASSWORD }
})

// ------------------------------------------------ provider sign-ins and 2FA

const PROVIDERS = [
  ['/stremio-login', { authKey: 'key' }],
  ['/nuvio-login', { code: 'c', deviceNonce: 'n', anonToken: 't' }],
  ['/jellyfin-login', { serverUrl: 'https://media.example.com' }],
]
const emailFor = (path) => (path === '/jellyfin-login' ? 'jf-user-1@media.example.com' : 'person@example.com')

for (const [path, body] of PROVIDERS) {
  test(`${path} hands back the 2FA challenge instead of a session`, async (t) => {
    const { prisma } = fakeDb([{ id: 'acc-1', email: emailFor(path), twoFactorEnabled: true }])
    const post = await startApp(t, { prisma })
    const out = await post(path, body)
    assert.equal(out.status, 200)
    assert.equal(out.body.requiresTwoFactor, true)
    assert.ok(out.body.pendingToken)
    assert.equal(out.body.token, undefined)
    assert.deepEqual(out.setCookie, [], 'no session cookies yet')
  })

  test(`${path} still signs in an account without 2FA, and refuses a disabled one`, async (t) => {
    const plain = fakeDb([{ id: 'acc-1', email: emailFor(path) }])
    const ok = await (await startApp(t, { prisma: plain.prisma }))(path, body)
    assert.equal(ok.status, 200)
    assert.ok(ok.body.token)
    assert.ok(ok.setCookie.some((c) => c.startsWith('sfm_at=')))

    const off = fakeDb([{ id: 'acc-1', email: emailFor(path), disabled: true }])
    const refused = await (await startApp(t, { prisma: off.prisma }))(path, body)
    assert.equal(refused.status, 403)
    assert.deepEqual(refused.setCookie, [])
  })
}

// A household install often runs without NODE_ENV=production behind an HTTPS
// proxy; its sign-in cookies still go out Secure when the request came in over
// HTTPS, and stay usable over plain http on the LAN.
test('sign-in cookies are Secure whenever the request came in over HTTPS', async (t) => {
  const { prisma } = fakeDb([{ id: 'default', uuid: DEFAULT_UUID }])
  const post = await startApp(t, { prisma, instanceType: 'private', privateAuth: { username: 'owner', password: 'pw' }, trustProxy: true })
  const viaHttps = await post('/private-login', { username: 'owner', password: 'pw' }, { 'x-forwarded-proto': 'https' })
  assert.equal(viaHttps.status, 200)
  assert.ok(viaHttps.setCookie.length >= 3 && viaHttps.setCookie.every((c) => /;\s*Secure/i.test(c)))
  const viaHttp = await post('/private-login', { username: 'owner', password: 'pw' })
  assert.ok(viaHttp.setCookie.length >= 3 && viaHttp.setCookie.every((c) => !/;\s*Secure/i.test(c)))
})
