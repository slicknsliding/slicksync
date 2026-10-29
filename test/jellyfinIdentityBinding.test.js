// A Jellyfin-compatible sign-in is the server speaking: the address it answers
// on, its own id and the user id in its reply are whatever the server at that
// address says. These pin what SlickSync does with that on an instance serving
// strangers (a stored sign-in is only ever reached through the address it was
// stored under, so a server someone runs elsewhere cannot touch anyone's), that
// a household's own install, where one server has several names, still finds
// the same server by another name - but only once the server stored for them
// accepts the new sign-in's token, never on the id a server claims - and that a
// sign-in is handed to everyone holding that server user whatever the route
// does next - the server has already retired the token they held.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const dns = require('node:dns').promises
const jwt = require('jsonwebtoken')
const express = require('express')

const config = require('../server/utils/config')
const jfAuth = require('../server/providers/jellyfinAuth')
const connect = require('../server/utils/jellyfinConnect')
const connectionAlerts = require('../server/utils/connectionAlerts')
const makePublicLibraryRouter = require('../server/routes/publicLibrary')
const makeJellyfinRouter = require('../server/routes/jellyfin')
const makeInvitationsRouter = require('../server/routes/invitations')

const SECRET = 'jellyfin-identity-test-secret'
const realFetch = global.fetch
const configuredType = config.INSTANCE_TYPE
const instanceType = (t, type) => {
  config.INSTANCE_TYPE = type
  t.after(() => { config.INSTANCE_TYPE = configuredType })
}

// A token sealed for a household, readable in the assertions.
const encrypt = (value, req) => `sealed:${req?.appAccountId}:${value}`

function match(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => match(row, w))
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return want.in.includes(row[key])
      if ('contains' in want) return String(row[key] ?? '').includes(want.contains)
      if ('not' in want) return row[key] !== want.not
    }
    return row[key] === want
  })
}
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })
function table(rows) {
  let n = 0
  return {
    rows,
    findFirst: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findUnique: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findMany: async ({ where, select, orderBy } = {}) => {
      const found = rows.filter((x) => match(x, where))
      if (orderBy?.createdAt === 'asc') found.sort((p, q) => new Date(p.createdAt) - new Date(q.createdAt))
      return found.map((r) => pick(r, select))
    },
    update: async ({ where, data, select }) => { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return pick(r, select) },
    create: async ({ data }) => { const r = { id: `new${++n}`, createdAt: new Date(), ...data }; rows.push(r); return { ...r } },
  }
}

// Names resolve to a public address, never the network.
function publicNames(t, names) {
  const original = dns.lookup
  dns.lookup = async (host) => {
    if (!names.includes(host)) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e }
    return [{ address: '93.184.216.34', family: 4 }]
  }
  t.after(() => { dns.lookup = original })
}

const SERVER_USER = 'ABCDEF01-2345-6789-ABCD-EF0123456789'
const SERVER_USER_ID = 'abcdef0123456789abcdef0123456789'

// A few servers, each saying what it likes about itself. Records the device id
// every name-and-password sign-in presented.
function fakeServers(t, servers, ownBases = []) {
  const signIns = []
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (ownBases.some((b) => String(input).startsWith(b))) return realFetch(input, init)
    const server = servers[url.origin]
    if (!server) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/System/Info/Public') return json({ Id: server.id, ServerName: 'Example', Version: '10.9.0', ProductName: 'Jellyfin Server' })
    if (url.pathname === '/Users/Public') return json([])
    if (url.pathname === '/QuickConnect/Enabled') return json(false)
    if (url.pathname === '/System/Info') return json({})
    // Who a token belongs to: only the server that issued it knows it.
    if (url.pathname === '/Users/Me') {
      const token = /Token="([^"]+)"/.exec(init.headers?.Authorization || '')?.[1]
      return token && token === (server.token || 'fresh-token') ? json({ Id: SERVER_USER, Name: 'Vic' }) : json({}, 401)
    }
    if (url.pathname === '/Users/AuthenticateByName') {
      const device = /DeviceId="([^"]+)"/.exec(init.headers?.Authorization || '')?.[1]
      signIns.push({ origin: url.origin, device })
      return json({ AccessToken: server.token || 'fresh-token', User: { Id: SERVER_USER, ServerId: server.claimsId || server.id, Name: 'Vic' } })
    }
    return json({}, 404)
  }
  t.after(() => { global.fetch = realFetch })
  return signIns
}

// The "your server is back" notice needs a notification store these tests do not have.
function quietRecoveryNotice(t) {
  const original = connectionAlerts.onConnectionRecovered
  connectionAlerts.onConnectionRecovered = async () => false
  t.after(() => { connectionAlerts.onConnectionRecovered = original })
}

const jfPerson = (id, accountId, extra) => ({
  id, accountId, username: id, email: `${id}@example.com`, isActive: true, providerType: 'jellyfin', colorIndex: 0,
  jellyfinServerUrl: 'https://jelly.example.com', jellyfinServerId: 'server-1', jellyfinServerKind: 'jellyfin',
  jellyfinUserId: SERVER_USER_ID, jellyfinToken: `sealed:${accountId}:old-token`,
  providerConnectionError: null, providerConnectionErrorAt: null, createdAt: new Date('2026-01-01'), expiresAt: null, ...extra,
})

// Two households that both added the same server user, and a stranger's row.
function twoHouseholds() {
  return {
    user: table([
      jfPerson('vic1', 'acc1', { providerConnectionError: 'sign-in rejected', providerConnectionErrorAt: new Date('2026-02-01') }),
      jfPerson('vic2', 'acc2', { providerConnectionError: 'sign-in rejected', providerConnectionErrorAt: new Date('2026-02-01') }),
      jfPerson('mate1', 'acc1', { jellyfinUserId: 'someoneelse', jellyfinToken: 'sealed:acc1:mate-token' }),
    ]),
    userProviderCredential: table([
      { id: 'cred1', userId: 'vic1', providerType: 'jellyfin', jellyfinUserId: SERVER_USER_ID, jellyfinServerUrl: 'https://jelly.example.com', jellyfinServerId: 'server-1', jellyfinToken: 'sealed:acc1:old-token' },
      { id: 'cred2', userId: 'vic2', providerType: 'jellyfin', jellyfinUserId: SERVER_USER_ID, jellyfinServerUrl: 'https://jelly.example.com', jellyfinServerId: 'server-1', jellyfinToken: 'sealed:acc2:old-token' },
    ]),
    inviteRequest: table([
      { id: 'req1', accountId: 'acc1', status: 'pending', providerType: 'jellyfin', jellyfinUserId: SERVER_USER_ID, jellyfinServerUrl: 'https://jelly.example.com', jellyfinServerId: 'server-1', jellyfinToken: 'sealed:acc1:old-token' },
      { id: 'req2', accountId: 'acc2', status: 'pending', providerType: 'jellyfin', jellyfinUserId: SERVER_USER_ID, jellyfinServerUrl: 'https://jelly.example.com', jellyfinServerId: 'server-1', jellyfinToken: 'sealed:acc2:old-token' },
    ]),
    jellyfinProfile: table([
      { id: 'prof1', accountId: 'acc1', ownerUserId: 'vic1', jellyfinUserId: SERVER_USER_ID, token: 'sealed:acc1:old-token', needsPin: true, skip: false },
      { id: 'prof2', accountId: 'acc2', ownerUserId: 'vic2', jellyfinUserId: SERVER_USER_ID, token: 'sealed:acc2:old-token', needsPin: true, skip: false },
    ]),
    group: table([
      { id: 'g1', accountId: 'acc1', isActive: true, userIds: JSON.stringify(['vic1', 'mate1']) },
      { id: 'g2', accountId: 'acc2', isActive: true, userIds: JSON.stringify(['vic2']) },
    ]),
  }
}

// Rows are removed in place: the fake's lookups close over the one array.
const dropRows = (tbl, drop) => { for (let i = tbl.rows.length - 1; i >= 0; i--) if (drop(tbl.rows[i])) tbl.rows.splice(i, 1) }
const tokenOf = (db, id) => db.user.rows.find((u) => u.id === id).jellyfinToken
const probeOf = (url, serverId) => ({ serverUrl: url, serverId, kind: 'jellyfin' })
const loginOf = (serverId) => ({ userId: SERVER_USER_ID, serverId, token: 'fresh-token' })

// Every row of the stored sign-in for SERVER_USER_ID, in both households, as one list.
function storedTokens(db) {
  return {
    users: [tokenOf(db, 'vic1'), tokenOf(db, 'vic2')],
    credentials: db.userProviderCredential.rows.map((r) => r.jellyfinToken),
    requests: db.inviteRequest.rows.map((r) => r.jellyfinToken),
    profiles: db.jellyfinProfile.rows.map((r) => r.token),
  }
}
// What each of those holds once both households have taken `token`, each sealed for its own.
const bothTake = (token) => ({
  users: [`sealed:acc1:${token}`, `sealed:acc2:${token}`],
  credentials: [`sealed:acc1:${token}`, `sealed:acc2:${token}`],
  requests: [`sealed:acc1:${token}`, `sealed:acc2:${token}`],
  profiles: [`sealed:acc1:${token}`, `sealed:acc2:${token}`],
})
const bothKeep = () => bothTake('old-token')

test('serverMatch: the address (and proven other names) on a household install; strangers only by the address, under either scheme', (t) => {
  instanceType(t, 'private')
  assert.deepEqual(connect.serverMatch(probeOf('https://jelly.example.com', 'server-1'), loginOf('server-1')), {
    OR: [{ jellyfinServerUrl: 'https://jelly.example.com' }],
  }, 'the id a server reports is never matched on its own')
  assert.deepEqual(connect.serverMatch(probeOf('http://192.168.1.20:8096', 'server-1'), loginOf('server-1'), ['https://jelly.example.com']), {
    OR: [{ jellyfinServerUrl: 'http://192.168.1.20:8096' }, { jellyfinServerUrl: 'https://jelly.example.com' }],
  })
  instanceType(t, 'public')
  const spellings = { OR: [{ jellyfinServerUrl: 'https://jelly.example.com' }, { jellyfinServerUrl: 'http://jelly.example.com' }] }
  assert.deepEqual(connect.serverMatch(probeOf('https://jelly.example.com', 'server-1'), loginOf('server-1')), spellings)
  assert.deepEqual(connect.serverMatch(probeOf('http://jelly.example.com', 'server-1'), loginOf('server-1')), spellings)
  // The port and the path are part of the address under both.
  assert.deepEqual(connect.serverMatch(probeOf('http://jelly.example.com:8096/jellyfin/u/abc', 'x'), loginOf('x')), {
    OR: [{ jellyfinServerUrl: 'https://jelly.example.com:8096/jellyfin/u/abc' }, { jellyfinServerUrl: 'http://jelly.example.com:8096/jellyfin/u/abc' }],
  })
})

test('rememberSignIn: everyone holding the server user takes the fresh token, each sealed for their own household', async (t) => {
  for (const type of ['public', 'private']) {
    instanceType(t, type)
    const db = twoHouseholds()
    const recovered = []
    const original = connectionAlerts.onConnectionRecovered
    connectionAlerts.onConnectionRecovered = async (_prisma, accountId, user) => { recovered.push([accountId, user.id]) }
    try {
      await connect.rememberSignIn(db, encrypt, probeOf('https://jelly.example.com', 'server-1'), loginOf('server-1'))
    } finally { connectionAlerts.onConnectionRecovered = original }
    assert.deepEqual(storedTokens(db), bothTake('fresh-token'), type)
    assert.equal(db.jellyfinProfile.rows[0].needsPin, false, type)
    assert.equal(db.jellyfinProfile.rows[1].needsPin, false, type)
    assert.equal(db.user.rows[0].providerConnectionError, null, type)
    assert.equal(db.user.rows[1].providerConnectionError, null, type)
    // Someone else on the same server is not touched.
    assert.equal(tokenOf(db, 'mate1'), 'sealed:acc1:mate-token', type)
    assert.deepEqual(recovered, [['acc1', 'vic1'], ['acc2', 'vic2']], type)
  }
})

test('rememberSignIn: on an instance serving strangers a server at another address claiming the same ids changes nothing', async (t) => {
  instanceType(t, 'public')
  const db = twoHouseholds()
  const before = JSON.stringify(db)
  // It answers at its own address but says it is server-1 and signs in as the server user the households hold.
  await connect.rememberSignIn(db, encrypt, probeOf('https://evil.example.com', 'server-1'), loginOf('server-1'))
  assert.equal(JSON.stringify(db), before)
  assert.deepEqual(storedTokens(db), bothKeep())
})

test('rememberSignIn: on an instance serving strangers a row that never held a sign-in is handed none, on a household install it is', async (t) => {
  for (const type of ['public', 'private']) {
    instanceType(t, type)
    const db = twoHouseholds()
    // The address and user id of a real person, written onto a row that was never signed in.
    Object.assign(db.user.rows[1], { jellyfinToken: null })
    db.userProviderCredential.rows[1].jellyfinToken = null
    db.inviteRequest.rows[1].jellyfinToken = null
    db.jellyfinProfile.rows[1].token = null
    await connect.rememberSignIn(db, encrypt, probeOf('https://jelly.example.com', 'server-1'), loginOf('server-1'))
    const stored = storedTokens(db)
    if (type === 'public') {
      assert.deepEqual(stored.users, ['sealed:acc1:fresh-token', null])
      assert.deepEqual(stored.credentials, ['sealed:acc1:fresh-token', null])
      assert.deepEqual(stored.requests, ['sealed:acc1:fresh-token', null])
      assert.deepEqual(stored.profiles, ['sealed:acc1:fresh-token', null])
    } else {
      assert.deepEqual(stored, bothTake('fresh-token'))
    }
  }
})

test('rememberSignIn: a path typed in another case is the same device, so it finds the row stored under the lowercase spelling', async (t) => {
  instanceType(t, 'public')
  const stored = 'https://jelly.example.com/jellyfin/u/abc'
  const db = twoHouseholds()
  for (const row of db.user.rows) row.jellyfinServerUrl = stored
  for (const tbl of [db.userProviderCredential, db.inviteRequest]) for (const row of tbl.rows) row.jellyfinServerUrl = stored
  assert.equal(jfAuth.signInDeviceId(stored, 'u1'), jfAuth.signInDeviceId('https://jelly.example.com/jellyfin/u/ABC', 'u1'))
  await connect.rememberSignIn(db, encrypt, probeOf('https://jelly.example.com/jellyfin/u/ABC', 'server-1'), loginOf('server-1'))
  assert.deepEqual(storedTokens(db), bothTake('fresh-token'))
  assert.deepEqual(
    connect.serverMatch(probeOf('https://jelly.example.com/jellyfin/u/ABC', 'x'), loginOf('x')).OR.map((m) => m.jellyfinServerUrl),
    ['https://jelly.example.com/jellyfin/u/ABC', 'http://jelly.example.com/jellyfin/u/ABC', 'https://jelly.example.com/jellyfin/u/abc', 'http://jelly.example.com/jellyfin/u/abc'],
  )
})

test('a household sign-in is handed to everyone holding that server user, whichever name it tried', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  const db = twoHouseholds()
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'household-token' } })
  const household = require('../server/utils/jellyfinProfiles')
  // The first name signs in as someone else (the main user); the second is the one asked for.
  const seen = []
  const hook = household.handToHolders(db, encrypt, 'https://jelly.example.com')
  const signed = await household.signInAs('https://jelly.example.com', ['not-them', 'them'], 'someone-else', 'pw', async (s) => { seen.push(s.userId); await hook(s) })
  assert.equal(signed.token, null, 'neither name was the user asked for')
  assert.deepEqual(seen, [SERVER_USER_ID, SERVER_USER_ID], 'every sign-in is reported, not only the one kept')
  assert.deepEqual(storedTokens(db), bothTake('household-token'))
  // Without a hook nothing else happens.
  const plain = await household.signInAs('https://jelly.example.com', ['them'], SERVER_USER_ID, 'pw')
  assert.equal(plain.token, 'household-token')
})

test('rememberSignIn: the other scheme for the same address finds the same rows on an instance serving strangers', async (t) => {
  instanceType(t, 'public')
  quietRecoveryNotice(t)
  const db = twoHouseholds()
  await connect.rememberSignIn(db, encrypt, probeOf('http://jelly.example.com', 'server-1'), loginOf('server-1'))
  assert.deepEqual(storedTokens(db), bothTake('fresh-token'))
  // ...but not another port or path on that host, which is another address.
  const other = twoHouseholds()
  await connect.rememberSignIn(other, encrypt, probeOf('https://jelly.example.com:8920', 'server-1'), loginOf('server-1'))
  await connect.rememberSignIn(other, encrypt, probeOf('https://jelly.example.com/jellyfin', 'server-1'), loginOf('server-1'))
  assert.deepEqual(storedTokens(other), bothKeep())
})

test('rememberSignIn: on a household install the same server by another name is found once the stored server accepts the new token', async (t) => {
  instanceType(t, 'private')
  quietRecoveryNotice(t)
  // The stored address and the LAN name are one server: a token from either works on both.
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1' }, 'http://192.168.1.20:8096': { id: 'server-1' } })
  const db = twoHouseholds()
  await connect.rememberSignIn(db, encrypt, probeOf('http://192.168.1.20:8096', 'server-1'), loginOf('server-1'))
  assert.deepEqual(storedTokens(db), bothTake('fresh-token'))
  // A different server (another id, another address) is not the same server.
  const other = twoHouseholds()
  await connect.rememberSignIn(other, encrypt, probeOf('http://192.168.1.21:8096', 'other-server'), loginOf('other-server'))
  assert.deepEqual(storedTokens(other), bothKeep())
})

test('rememberSignIn: on a household install a server at another address claiming the same ids changes nothing', async (t) => {
  instanceType(t, 'private')
  // The stored server does not know the token the other one handed out.
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'real-token' } })
  const db = twoHouseholds()
  await connect.rememberSignIn(db, encrypt, probeOf('https://evil.example.com', 'server-1'), { ...loginOf('server-1'), token: 'attackers-token' })
  assert.deepEqual(storedTokens(db), bothKeep())
})

test('findJellyfinUser: the same address (either scheme) on an instance serving strangers; a proven other name as well on a household install', async (t) => {
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1' } })
  const db = twoHouseholds()
  instanceType(t, 'public')
  assert.equal((await connect.findJellyfinUser(db, 'acc1', loginOf('server-1'), probeOf('https://jelly.example.com', 'server-1')))?.id, 'vic1')
  assert.equal((await connect.findJellyfinUser(db, 'acc1', loginOf('server-1'), probeOf('http://jelly.example.com', 'server-1')))?.id, 'vic1', 'the other scheme is the same person, not a second one')
  assert.equal(await connect.findJellyfinUser(db, 'acc1', loginOf('server-1'), probeOf('https://evil.example.com', 'server-1')), null)
  instanceType(t, 'private')
  assert.equal((await connect.findJellyfinUser(db, 'acc1', loginOf('server-1'), probeOf('http://192.168.1.20:8096', 'server-1')))?.id, 'vic1')
  assert.equal(await connect.findJellyfinUser(db, 'acc1', loginOf('other-server'), probeOf('http://192.168.1.20:8096', 'other-server')), null)
})

// What a device id was before households were ever part of it: one per server address and user name.
const headDevice = (url, user) => 'slicksync-' + crypto.createHash('sha256').update(`${url}|${user}`.toLowerCase()).digest('hex').slice(0, 24)

test('the sign-in device is one per address and user name on every kind of install, as it always was', async (t) => {
  const url = 'https://jelly.example.com'
  for (const type of ['public', 'private']) {
    instanceType(t, type)
    assert.equal(jfAuth.signInDeviceId(url, 'Vic'), headDevice(url, 'Vic'), type)
    assert.equal(jfAuth.deviceIdFor(url, 'Vic'), headDevice(url, 'Vic'), type)
    // A caller that still names a household gets the same device.
    assert.equal(jfAuth.signInDeviceId(url, 'Vic', 'acc1'), headDevice(url, 'Vic'), type)
  }
  publicNames(t, ['jelly.example.com'])
  const signIns = fakeServers(t, { 'https://jelly.example.com': { id: 'server-1' } })
  const body = { serverUrl: url, jellyfinUsername: 'Vic', password: 'pw' }
  for (const type of ['public', 'private']) {
    instanceType(t, type)
    signIns.length = 0
    await connect.signInFromBody(body)
    await connect.signInFromBody({ ...body, jellyfinUsername: 'Other' })
    assert.deepEqual(signIns.map((s) => s.device), [headDevice(url, 'Vic'), headDevice(url, 'Other')], type)
  }
})

// ---- the person's own page: POST /api/public-library/authenticate-jellyfin ----

async function servePortal(t, db) {
  quietRecoveryNotice(t)
  const app = express()
  app.use(express.json())
  app.use('/api/public-library', makePublicLibraryRouter({
    prisma: db, DEFAULT_ACCOUNT_ID: 'default', encrypt, decrypt: (v) => v,
    getCachedLibrary: () => [], setCachedLibrary: () => {}, JWT_SECRET: SECRET,
  }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    signIn: async (serverUrl) => {
      const res = await realFetch(`${base}/api/public-library/authenticate-jellyfin`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl, jellyfinUsername: 'Vic', password: 'pw' }),
      })
      return { status: res.status, body: await res.json() }
    },
  }
}

test('portal sign-in, instance serving strangers: a server claiming another household\'s id signs nobody in and changes nothing', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com', 'evil.example.com'])
  const db = twoHouseholds()
  const portal = await servePortal(t, db)
  const signIns = fakeServers(t, {
    'https://jelly.example.com': { id: 'server-1' },
    // Says it is server-1 and signs in as the server user the households hold.
    'https://evil.example.com': { id: 'server-1', token: 'attackers-token' },
  }, [portal.base])
  const before = JSON.stringify(db)

  const refused = await portal.signIn('https://evil.example.com')
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'USER_NOT_FOUND')
  assert.equal(refused.body.sessionToken, undefined)
  assert.equal(JSON.stringify(db), before, 'no household was changed')
  assert.equal(signIns[0].device, headDevice('https://evil.example.com', 'Vic'))
})

test('portal sign-in, instance serving strangers: the address the person was added with signs them in, and every household holding that server user takes the token', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  const db = twoHouseholds()
  const portal = await servePortal(t, db)
  const signIns = fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'real-fresh-token' } }, [portal.base])

  const ok = await portal.signIn('https://jelly.example.com')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.id, 'vic1')
  assert.equal(jwt.verify(ok.body.sessionToken, SECRET).sub, 'vic1')
  // The server retired the token both households held for this device, so both take the new one.
  assert.deepEqual(storedTokens(db), bothTake('real-fresh-token'))
  assert.equal(signIns.length, 1, 'one sign-in on the server, not one per household')
  assert.equal(signIns[0].device, headDevice('https://jelly.example.com', 'Vic'))
})

test('portal sign-in, instance serving strangers: the other scheme finds the same person and the stored address is not rewritten', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  const db = twoHouseholds()
  const portal = await servePortal(t, db)
  fakeServers(t, {
    'http://jelly.example.com': { id: 'server-1', token: 'plain-http-token' },
    'http://jelly.example.com:8096': { id: 'server-1', token: 'other-port-token' },
  }, [portal.base])

  const ok = await portal.signIn('http://jelly.example.com')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.id, 'vic1')
  assert.equal(db.user.rows.find((u) => u.id === 'vic1').jellyfinServerUrl, 'https://jelly.example.com', 'still the address the admin added')
  assert.equal(db.user.rows.find((u) => u.id === 'vic2').jellyfinServerUrl, 'https://jelly.example.com')
  assert.deepEqual(storedTokens(db), bothTake('plain-http-token'))
  // An address that only shares the host is somebody else's.
  const refused = await portal.signIn('http://jelly.example.com:8096')
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'USER_NOT_FOUND')
  assert.deepEqual(storedTokens(db), bothTake('plain-http-token'), 'the other port\'s token went nowhere')
})

test('portal sign-in, household install: a server claiming the household server\'s id signs nobody in and changes nothing', async (t) => {
  instanceType(t, 'private')
  const db = twoHouseholds()
  dropRows(db.user, (u) => u.accountId !== 'acc1') // one household, as a private install is
  const portal = await servePortal(t, db)
  fakeServers(t, {
    'https://jelly.example.com': { id: 'server-1', token: 'real-token' },
    // Says it is server-1 and signs anyone in as the member.
    'https://evil.example.com': { id: 'server-1', token: 'attackers-token' },
  }, [portal.base])
  const before = JSON.stringify(db)

  const refused = await portal.signIn('https://evil.example.com')
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'USER_NOT_FOUND')
  assert.equal(refused.body.sessionToken, undefined)
  assert.equal(JSON.stringify(db), before, 'no address or token was rewritten')
})

test('portal sign-in, household install: the same server at another address finds the person', async (t) => {
  instanceType(t, 'private')
  const db = twoHouseholds()
  dropRows(db.user, (u) => u.accountId !== 'acc1') // one household, as a private install is
  const portal = await servePortal(t, db)
  // One server by two names: the token it gives on the LAN name works at the stored address too.
  fakeServers(t, { 'http://192.168.1.20:8096': { id: 'server-1', token: 'lan-token' }, 'https://jelly.example.com': { id: 'server-1', token: 'lan-token' } }, [portal.base])

  const ok = await portal.signIn('http://192.168.1.20:8096')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.id, 'vic1')
  assert.equal(tokenOf(db, 'vic1'), 'sealed:acc1:lan-token')
  assert.equal(db.user.rows.find((u) => u.id === 'vic1').jellyfinServerUrl, 'http://192.168.1.20:8096')
})

test('portal sign-in: only the person\'s own household\'s groups can put them in a group', async (t) => {
  instanceType(t, 'private')
  const db = twoHouseholds()
  // vic1 is named by another household's group only.
  db.group.rows[0].userIds = JSON.stringify(['mate1'])
  db.group.rows[1].userIds = JSON.stringify(['mate2', 'vic1'])
  const portal = await servePortal(t, db)
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1' } }, [portal.base])
  const refused = await portal.signIn('https://jelly.example.com')
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'USER_NOT_IN_GROUP')
})

test('portal sign-in, public: a server user held in two households is signed in to the household that can have them', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  const db = twoHouseholds()
  // The older household has them switched off; the other has them active and in a group.
  db.user.rows[0].isActive = false
  db.user.rows[0].createdAt = new Date('2026-01-01')
  db.user.rows[1].createdAt = new Date('2026-03-01')
  db.user.rows.reverse() // the order the rows happen to be read in must not decide it
  const portal = await servePortal(t, db)
  fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'newest-token' } }, [portal.base])
  const ok = await portal.signIn('https://jelly.example.com')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.id, 'vic2')
})

// A sign-in on the person's page retires the token SlickSync stored for that device
// whether or not the page lets the person in, so the stored rows take the new one regardless.
const TURNED_AWAY = {
  // The same server user is a person in both households, so it takes both being turned away.
  'a person who is inactive': { error: 'USER_NOT_ACTIVE', arrange: (db) => { db.user.rows[0].isActive = false; db.user.rows[1].isActive = false } },
  'a person in no group': { error: 'USER_NOT_IN_GROUP', arrange: (db) => { db.group.rows[0].userIds = JSON.stringify(['mate1']); db.group.rows[1].userIds = JSON.stringify(['mate2']) } },
  'a login nobody here is signed in as': {
    error: 'USER_NOT_FOUND',
    // Only a merged-in login, a waiting invite request and a profile hold it - no person is that server user.
    arrange: (db) => {
      db.user.rows[0].jellyfinUserId = 'another-server-user'
      db.user.rows[1].jellyfinUserId = 'another-server-user'
      db.jellyfinProfile.rows.length = 0
    },
  },
}
for (const type of ['public', 'private']) {
  for (const [who, { error, arrange }] of Object.entries(TURNED_AWAY)) {
    test(`portal sign-in (${type}): ${who} is turned away, and what is stored for them still takes the new token`, async (t) => {
      instanceType(t, type)
      publicNames(t, ['jelly.example.com'])
      const db = twoHouseholds()
      arrange(db)
      const portal = await servePortal(t, db)
      fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'newest-token' } }, [portal.base])

      const refused = await portal.signIn('https://jelly.example.com')
      assert.equal(refused.status, 403)
      assert.equal(refused.body.error, error)
      assert.equal(refused.body.sessionToken, undefined)
      const stored = storedTokens(db)
      const fresh = bothTake('newest-token')
      assert.deepEqual(stored.credentials, fresh.credentials)
      assert.deepEqual(stored.requests, fresh.requests)
      if (error === 'USER_NOT_FOUND') {
        assert.deepEqual(stored.users, ['sealed:acc1:old-token', 'sealed:acc2:old-token'], 'they are not that server user')
      } else {
        assert.deepEqual(stored.users, fresh.users)
        assert.deepEqual(stored.profiles, fresh.profiles)
      }
    })
  }
}

// ---- the admin's Reconnect and an invitation ----

async function serveReconnect(t, db) {
  quietRecoveryNotice(t)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.appAccountId = 'acc1'; next() })
  app.use('/api/jellyfin', makeJellyfinRouter({ prisma: db, getAccountId: () => 'acc1', encrypt, decrypt: (v) => v, assignUserToGroup: async () => {} }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    connect: async (body) => realFetch(`${base}/api/jellyfin/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'https://jelly.example.com', jellyfinUsername: 'Vic', password: 'pw', ...body }),
    }),
  }
}

test('Reconnect: everyone holding the server user takes the token, from the one device per address and user name', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  const db = twoHouseholds()
  const admin = await serveReconnect(t, db)
  const signIns = fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'reconnect-token' } }, [admin.base])

  const res = await admin.connect({ userId: 'vic1' })
  assert.equal(res.status, 200, await res.text())
  assert.deepEqual(storedTokens(db), bothTake('reconnect-token'))
  assert.equal(signIns[0].device, headDevice('https://jelly.example.com', 'Vic'))
})

test('Reconnect: a sign-in the admin\'s request then refuses as already added still hands over the fresh token', async (t) => {
  for (const type of ['public', 'private']) {
    instanceType(t, type)
    publicNames(t, ['jelly.example.com'])
    const db = twoHouseholds()
    const admin = await serveReconnect(t, db)
    fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'refused-token' } }, [admin.base])

    // Reconnecting mate1 with vic1's login: that server user is already added as vic1.
    const refused = await admin.connect({ userId: 'mate1' })
    assert.equal(refused.status, 409, type)
    assert.deepEqual(storedTokens(db), bothTake('refused-token'), type)
    assert.equal(tokenOf(db, 'mate1'), 'sealed:acc1:mate-token', type)
  }
})

test('an invitation holder\'s sign-in is handed to everyone holding the server user, from the one device per address and user name', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  quietRecoveryNotice(t)
  const db = twoHouseholds()
  db.invitation = table([{ id: 'inv1', inviteCode: 'JOINCODE', accountId: 'acc1', isActive: true, maxUses: 0, currentUses: 0, expiresAt: null, groupName: null }])
  // The person being invited is not added yet: nobody in either household holds the login as a user.
  dropRows(db.user, (u) => u.jellyfinUserId === SERVER_USER_ID)
  db.userProviderCredential.rows.length = 0
  db.jellyfinProfile.rows.length = 0
  const app = express()
  app.use(express.json())
  app.use('/invite', makeInvitationsRouter.createPublicRouter({ prisma: db, encrypt, decrypt: (v) => v, assignUserToGroup: async () => {} }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const signIns = fakeServers(t, { 'https://jelly.example.com': { id: 'server-1', token: 'invite-token' } }, [base])

  const res = await realFetch(`${base}/invite/JOINCODE/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Vic', jellyfin: { serverUrl: 'https://jelly.example.com', jellyfinUsername: 'Vic', password: 'pw' } }),
  })
  assert.equal(res.status, 200, await res.text())
  // Both households' waiting requests took the fresh token, each sealed for its own.
  assert.equal(db.inviteRequest.rows.find((r) => r.id === 'req1').jellyfinToken, 'sealed:acc1:invite-token')
  assert.equal(db.inviteRequest.rows.find((r) => r.id === 'req2').jellyfinToken, 'sealed:acc2:invite-token')
  assert.equal(signIns[0].device, headDevice('https://jelly.example.com', 'Vic'))
})

// ---- the request itself: a redirect is held to the same rule as the address ----

const INTERNAL_TARGETS = ['http://127.0.0.1:8096/System/Info/Public', 'http://192.168.1.10:8096/System/Info/Public', 'http://[::1]/System/Info/Public', 'http://169.254.169.254/latest/meta-data/']

test('instance serving strangers: an address that redirects to the network behind this server is refused before it is asked', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com'])
  for (const target of INTERNAL_TARGETS) {
    const asked = []
    global.fetch = async (input) => {
      asked.push(String(input))
      return new Response(null, { status: 302, headers: { location: target } })
    }
    await assert.rejects(
      () => jfAuth.probeServer('https://jelly.example.com'),
      (e) => e.status === 400 && e.message === 'That address is on a private network, which this instance cannot reach',
      target,
    )
    assert.deepEqual(asked, ['https://jelly.example.com/System/Info/Public'], target)
  }
  global.fetch = realFetch
})

test('instance serving strangers: a redirect to another public address is still followed', async (t) => {
  instanceType(t, 'public')
  publicNames(t, ['jelly.example.com', 'media.example.com'])
  global.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.origin === 'http://jelly.example.com') return new Response(null, { status: 301, headers: { location: `https://media.example.com${url.pathname}` } })
    if (url.pathname === '/System/Info/Public') {
      return new Response(JSON.stringify({ Id: 'server-1', ServerName: 'Example', ProductName: 'Jellyfin Server' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }
  t.after(() => { global.fetch = realFetch })
  const probe = await jfAuth.probeServer('http://jelly.example.com')
  assert.equal(probe.serverId, 'server-1')
  assert.equal(probe.serverUrl, 'http://jelly.example.com', 'the address stays the one that was typed')
})

test('instance serving strangers: an internal address itself is still refused', async (t) => {
  instanceType(t, 'public')
  publicNames(t, [])
  for (const address of ['http://127.0.0.1:8096', 'http://192.168.1.10:8096', 'http://localhost:8096']) {
    await assert.rejects(() => jfAuth.probeServer(address), (e) => e.status === 400 && /private network/.test(e.message), address)
  }
})

test('household install: a server on its own network, and a redirect to another one, work as they always did', async (t) => {
  instanceType(t, 'private')
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
  const target = await listen(http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ Id: 'server-1', ServerName: 'Example', ProductName: 'Jellyfin Server' }))
  }))
  const front = await listen(http.createServer((req, res) => {
    res.statusCode = 302
    res.setHeader('location', `http://127.0.0.1:${target.address().port}${req.url}`)
    res.end()
  }))
  t.after(() => { target.close(); front.close() })
  const direct = await jfAuth.jfRequest(`http://127.0.0.1:${target.address().port}`, '/System/Info/Public')
  assert.equal(direct.Id, 'server-1')
  const redirected = await jfAuth.jfRequest(`http://127.0.0.1:${front.address().port}`, '/System/Info/Public')
  assert.equal(redirected.Id, 'server-1')
  const probe = await jfAuth.probeServer(`http://127.0.0.1:${front.address().port}`)
  assert.equal(probe.serverId, 'server-1')
})
