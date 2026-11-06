// A server on the same hostname but another port or path is another server, so
// it must not reach an account made for the first one - while accounts made
// before port and path counted keep signing in at the address they were made at.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

process.env.JWT_SECRET = 'unit-test-signing-secret-not-for-use'
process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-not-for-use-0123456789'
delete process.env.NODE_ENV

const publicAuth = require('../server/routes/publicAuth')
const jellyfinConnect = require('../server/utils/jellyfinConnect')
const { identityEmail, legacyIdentityEmail } = require('../server/providers/jellyfinAuth')
const { issueAccessToken, issueRefreshToken, cookieName, parseCookies, verifyAccountToken } = require('../server/utils/auth')

const realFetch = global.fetch
const LOGIN = { userId: 'jf-user-1', userName: 'alice', token: 'tok', serverId: 'server-1' }
const probeAt = (serverUrl) => ({ serverUrl, serverId: 'server-1', kind: 'jellyfin', kindLabel: 'Jellyfin' })

test('identity: default address is unchanged, port and path make a different identity', () => {
  assert.equal(identityEmail('https://jf.example.com', 'U1'), 'u1@jf.example.com')
  assert.equal(identityEmail('https://jf.example.com', 'U1'), legacyIdentityEmail('https://jf.example.com:9000', 'U1').replace('@jf', '@jf'))
  assert.notEqual(identityEmail('https://jf.example.com:9000', 'u1'), identityEmail('https://jf.example.com', 'u1'))
  assert.notEqual(identityEmail('https://jf.example.com/a', 'u1'), identityEmail('https://jf.example.com/b', 'u1'))
  assert.ok(!identityEmail('https://jf.example.com/secretpath', 'u1').includes('secretpath'))
})

async function run(t, { accounts, users }, serverUrl) {
  const saved = { s: jellyfinConnect.signInFromBody, r: jellyfinConnect.rememberSignIn }
  jellyfinConnect.signInFromBody = async () => ({ probe: probeAt(serverUrl), login: LOGIN })
  jellyfinConnect.rememberSignIn = async () => {}
  t.after(() => { jellyfinConnect.signInFromBody = saved.s; jellyfinConnect.rememberSignIn = saved.r })
  const rows = accounts.map((a) => ({ uuid: null, passwordHash: null, linkedProvider: 'jellyfin', ...a }))
  const find = (where) => rows.find((a) => Object.entries(where).every(([k, v]) => a[k] === v)) || null
  const prisma = {
    appAccount: {
      findUnique: async ({ where }) => find(where),
      update: async ({ where, data }) => Object.assign(find(where), data),
      create: async ({ data }) => { const row = { id: `new-${rows.length + 1}`, ...data }; rows.push(row); return row },
    },
    user: {
      findFirst: async ({ where }) => users.find((u) => Object.entries(where).every(([k, v]) => u[k] === v)) || null,
      updateMany: async ({ where, data }) => { users.filter((u) => Object.entries(where).every(([k, v]) => u[k] === v)).forEach((u) => Object.assign(u, data)); return {} },
      update: async () => ({}),
      create: async ({ data }) => ({ id: 'person-new', ...data }),
    },
  }
  const router = publicAuth({
    prisma, INSTANCE_TYPE: 'public', PRIVATE_AUTH_ENABLED: false, DEFAULT_ACCOUNT_ID: 'default',
    issueAccessToken, issueRefreshToken, cookieName, isProdEnv: () => false, parseCookies, verifyAccountToken,
    encrypt: (v) => `enc:${v}`,
  })
  const app = express()
  app.use(express.json())
  app.use('/api/public-auth', router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/public-auth/jellyfin-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  return { res, rows, users }
}

const OLD = legacyIdentityEmail('https://jf.example.com', LOGIN.userId)

test('same host on another port does not reach the existing account', async (t) => {
  const { res, rows } = await run(t, {
    accounts: [{ id: 'victim', email: OLD }],
    users: [{ id: 'p1', accountId: 'victim', providerType: 'jellyfin', jellyfinUserId: LOGIN.userId, jellyfinServerUrl: 'https://jf.example.com', email: OLD }],
  }, 'https://jf.example.com:9000')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.notEqual(body.account.id, 'victim')
  assert.equal(rows.find((a) => a.id === 'victim').email, OLD)
})

test('an existing default-port account still signs in and is upgraded in place', async (t) => {
  const { res, rows } = await run(t, {
    accounts: [{ id: 'old', email: OLD }],
    users: [{ id: 'p1', accountId: 'old', providerType: 'jellyfin', jellyfinUserId: LOGIN.userId, jellyfinServerUrl: 'https://jf.example.com', email: OLD }],
  }, 'https://jf.example.com')
  assert.equal(res.status, 200)
  assert.equal((await res.json()).account.id, 'old')
  assert.equal(rows.length, 1)
})

test('an account made at a non-default port keeps signing in at that address', async (t) => {
  const { res, rows, users } = await run(t, {
    accounts: [{ id: 'old', email: OLD }],
    users: [{ id: 'p1', accountId: 'old', providerType: 'jellyfin', jellyfinUserId: LOGIN.userId, jellyfinServerUrl: 'https://jf.example.com:8096', email: OLD }],
  }, 'https://jf.example.com:8096')
  assert.equal(res.status, 200)
  assert.equal((await res.json()).account.id, 'old')
  assert.equal(rows.find((a) => a.id === 'old').email, identityEmail('https://jf.example.com:8096', LOGIN.userId))
  assert.equal(users[0].email, identityEmail('https://jf.example.com:8096', LOGIN.userId))
})
