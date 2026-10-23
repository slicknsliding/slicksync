// Jellyfin servers given to groups on the Addons page (server/utils/jellyfinHouseholdServers.js),
// against a stand-in Jellyfin server and database.
const test = require('node:test')
const assert = require('node:assert/strict')

const enc = require('../server/utils/encryption')
enc.encrypt = (t) => `enc:${t}`
enc.decrypt = (t) => String(t).replace(/^enc:/, '')
require('../server/utils/jellyfinConnect').rememberSignIn = async () => {}
const jfAuth = require('../server/providers/jellyfinAuth')
const servers = require('../server/utils/jellyfinHouseholdServers')

const URL = 'https://jf.example.invalid'

function fakeJellyfin() {
  const users = new Map()
  let n = 0
  const add = (Name, { admin = false, password = '' } = {}) => {
    const Id = `${(++n).toString(16).padStart(8, '0')}aaaabbbbccccddddeeeeffff`
    users.set(Id, { Id, Name, password, Policy: { IsAdministrator: admin, IsDisabled: false } })
    return Id
  }
  const approved = []
  const pending = new Map()
  jfAuth.jfRequest = async (base, path, opts = {}) => {
    assert.equal(base, URL)
    const method = opts.method || 'GET'
    let m
    if (path === '/Users' && method === 'GET') return [...users.values()].map((u) => ({ ...u }))
    if (path === '/Users/New' && method === 'POST') return users.get(add(opts.body.Name, { password: opts.body.Password }))
    if ((m = /^\/Users\/(\w+)$/.exec(path)) && method === 'GET') {
      const u = users.get(m[1]); if (!u) throw Object.assign(new Error('nf'), { status: 404 }); return { ...u, Policy: { ...u.Policy } }
    }
    if ((m = /^\/Users\/(\w+)\/Policy$/.exec(path))) { users.get(m[1]).Policy = { ...opts.body }; return null }
    if ((m = /^\/QuickConnect\/Authorize\?code=(\w+)&userId=(\w+)$/.exec(path))) {
      if (m[1] !== '123456' && !pending.has(m[1])) throw Object.assign(new Error('nf'), { status: 404 })
      approved.push({ code: m[1], userId: m[2] }); if (pending.has(m[1])) pending.set(m[1], m[2]); return true
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  jfAuth.authenticateByName = async (base, name, pw) => {
    const u = [...users.values()].find((x) => x.Name === name && x.password === pw)
    if (!u) throw Object.assign(new Error('Wrong user name or password'), { status: 401 })
    if (u.Policy.IsDisabled) throw Object.assign(new Error('disabled'), { status: 401 })
    return { serverUrl: base, serverId: 'srv1', token: `tok-${u.Id}`, userId: u.Id, userName: u.Name, isAdmin: u.Policy.IsAdministrator }
  }
  jfAuth.quickConnectInitiate = async () => { const code = String(700000 + pending.size); pending.set(code, null); return { code, secret: `s-${code}`, deviceId: 'd' } }
  jfAuth.quickConnectAuthenticate = async (base, secret) => {
    const uid = pending.get(secret.slice(2)); const u = users.get(uid)
    return { serverUrl: base, serverId: 'srv1', token: `tok-${uid}`, userId: uid, userName: u.Name, isAdmin: false }
  }
  return { users, add, approved }
}

function fakeDb(people, groups) {
  let sync = {}
  const creds = []
  let cid = 0
  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k])
    if (v === null) return row[k] == null
    return row[k] === v
  })
  const prisma = {
    appAccount: {
      findUnique: async () => ({ sync: JSON.parse(JSON.stringify(sync)) }),
      update: async ({ data }) => { sync = JSON.parse(JSON.stringify(data.sync)) },
      findMany: async () => [{ id: 'acc' }],
    },
    group: { findMany: async ({ where }) => groups.filter((g) => matches(g, where)) },
    user: { findMany: async ({ where }) => people.filter((p) => matches(p, where)) },
    userProviderCredential: {
      findMany: async ({ where }) => creds.filter((c) => matches(c, where)),
      findUnique: async ({ where }) => creds.find((c) => c.id === where.id) || null,
      create: async ({ data }) => { const c = { id: `c${++cid}`, ...data }; creds.push(c); return c },
      update: async ({ where, data }) => Object.assign(creds.find((c) => c.id === where.id), data),
      deleteMany: async ({ where }) => { for (let i = creds.length - 1; i >= 0; i--) if (matches(creds[i], where)) creds.splice(i, 1) },
    },
  }
  return { prisma, creds, get sync() { return sync }, set sync(v) { sync = v } }
}

const person = (id, username, extra = {}) => ({ id, username, accountId: 'acc', isActive: true, expiresAt: null, providerType: 'stremio', ...extra })

async function setup() {
  const jf = fakeJellyfin()
  jf.add('owner', { admin: true, password: 'x' })
  const garyId = jf.add('Gary', { password: 'his-own' })
  const tomId = jf.add('tom', { password: 'tom-pw' })
  const people = [
    person('p-sarah', 'Sarah'),
    person('p-gary', 'gary'),
    person('p-tom', 'Tom', { providerType: 'jellyfin', jellyfinServerUrl: URL, jellyfinServerId: 'srv1', jellyfinUserId: tomId, jellyfinUserName: 'tom' }),
    person('p-owner', 'owner'),
  ]
  const groups = [{ id: 'g-family', accountId: 'acc', isActive: true, userIds: JSON.stringify(['p-sarah', 'p-gary', 'p-tom', 'p-owner']) }]
  const db = fakeDb(people, groups)
  db.sync = { jellyfinHouseholdServers: { s1: { id: 's1', name: 'Home Jellyfin', url: URL, serverId: 'srv1', key: 'enc:KEY', keyMade: true, groupIds: ['g-family'], accounts: {} } } }
  return { jf, db, people, groups, garyId, tomId }
}

test('a group sync makes, links and tracks accounts - never an administrator\'s', async () => {
  const { jf, db, garyId, tomId } = await setup()
  const changes = await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  const by = Object.fromEntries(changes.map((c) => [c.personId, c]))
  assert.equal(by['p-sarah'].action, 'made')
  assert.equal(by['p-gary'].action, 'linked')
  assert.equal(by['p-tom'].action, 'linked')
  // "owner" on the server is an administrator: owner gets an account of their own.
  assert.equal(by['p-owner'].action, 'made')
  assert.equal(by['p-owner'].name, 'owner 2')

  const recs = db.sync.jellyfinHouseholdServers.s1.accounts
  assert.equal(recs['p-gary'].jellyfinUserId, garyId)
  assert.equal(recs['p-gary'].made, false)
  assert.equal(recs['p-tom'].own, true)
  assert.equal(recs['p-tom'].jellyfinUserId, tomId)
  assert.ok(recs['p-sarah'].password.startsWith('enc:'))
  // Sarah's account really exists, with the password SlickSync kept.
  const sarah = [...jf.users.values()].find((u) => u.Name === 'Sarah')
  assert.equal(sarah.password, recs['p-sarah'].password.slice(4))

  // Tracked as stored sign-ins: Sarah's by password, Gary's (already there) by an approved Quick Connect.
  const origins = db.creds.map((c) => `${c.userId}:${c.origin}`).sort()
  assert.deepEqual(origins, ['p-gary:jellyfin-server:s1', 'p-owner:jellyfin-server:s1', 'p-sarah:jellyfin-server:s1'])
  assert.ok(jf.approved.some((a) => a.userId === garyId))

  // A second sync changes nothing.
  assert.deepEqual(await servers.syncForGroup(db.prisma, 'acc', 'g-family'), [])
  assert.equal([...jf.users.values()].filter((u) => u.Name.startsWith('Sarah')).length, 1)
})

test('leaving the group switches off an account SlickSync made, only unlinks one that was there', async () => {
  const { jf, db, groups, garyId } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  groups[0].userIds = JSON.stringify(['p-tom', 'p-owner'])
  const changes = await servers.syncServer(db.prisma, 'acc', 's1', { add: false })
  const by = Object.fromEntries(changes.map((c) => [c.personId, c.action]))
  assert.equal(by['p-sarah'], 'off')
  assert.equal(by['p-gary'], 'unlinked')
  const sarah = [...jf.users.values()].find((u) => u.Name === 'Sarah')
  assert.equal(sarah.Policy.IsDisabled, true)
  assert.equal(jf.users.get(garyId).Policy.IsDisabled, false)
  assert.deepEqual(db.creds.map((c) => c.userId).sort(), ['p-owner'])

  // Back in the group: switched on again and signed in again, not made twice.
  groups[0].userIds = JSON.stringify(['p-sarah', 'p-tom', 'p-owner'])
  const again = await servers.syncServer(db.prisma, 'acc', 's1', { add: false })
  assert.deepEqual(again.map((c) => c.action), ['on'])
  assert.equal(sarah.Policy.IsDisabled, false)
  assert.ok(db.creds.some((c) => c.userId === 'p-sarah'))
  assert.equal([...jf.users.values()].filter((u) => u.Name.startsWith('Sarah')).length, 1)
})

test('a deactivated person counts as gone', async () => {
  const { jf, db, people } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  people[0].isActive = false
  await servers.syncServer(db.prisma, 'acc', 's1', { add: false })
  assert.equal([...jf.users.values()].find((u) => u.Name === 'Sarah').Policy.IsDisabled, true)
})

test('approving a Quick Connect code signs the app in as that person; the password is only for accounts SlickSync made', async () => {
  const { jf, db, garyId } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  const r = await servers.approveCode(db.prisma, 'acc', 's1', 'p-gary', '123 456')
  assert.equal(r.approved, true)
  assert.deepEqual(jf.approved.at(-1), { code: '123456', userId: garyId })
  await assert.rejects(servers.approveCode(db.prisma, 'acc', 's1', 'p-gary', '999999'), /wasn’t found/)
  await assert.rejects(servers.approveCode(db.prisma, 'acc', 's1', 'p-gary', 'abc'), /Type the code/)

  const pw = await servers.revealPassword(db.prisma, 'acc', 's1', 'p-sarah')
  assert.equal(pw.userName, 'Sarah')
  assert.equal(pw.password, [...jf.users.values()].find((u) => u.Name === 'Sarah').password)
  await assert.rejects(servers.revealPassword(db.prisma, 'acc', 's1', 'p-gary'), /its own password/)
})

test('removing a server and adding it back picks up the accounts SlickSync made, passwords and all', async () => {
  const { jf, db } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  const before = db.sync.jellyfinHouseholdServers.s1.accounts
  jfAuth.probeServer = async () => ({ serverUrl: URL, serverId: 'srv1', serverName: 'Home', kind: 'jellyfin' })
  await servers.removeServer(db.prisma, 'acc', 's1')
  assert.equal(db.creds.length, 0)
  const again = await servers.addServer(db.prisma, 'acc', { url: URL, name: 'Home', auth: { method: 'apikey', apiKey: 'KEY' }, groupIds: ['g-family'] })
  const changes = await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  const recs = db.sync.jellyfinHouseholdServers[again.id].accounts
  // No one got a second account: Sarah and "owner 2" are the same ones, made by SlickSync, password kept.
  assert.ok(!changes.some((c) => c.action === 'made'))
  assert.equal(recs['p-sarah'].jellyfinUserId, before['p-sarah'].jellyfinUserId)
  assert.equal(recs['p-sarah'].password, before['p-sarah'].password)
  assert.equal(recs['p-owner'].userName, 'owner 2')
  assert.equal([...jf.users.values()].filter((u) => /^owner/.test(u.Name)).length, 2)
  // ...and they're tracked again.
  assert.deepEqual(db.creds.map((c) => c.userId).sort(), ['p-gary', 'p-owner', 'p-sarah'])
})

test('an account SlickSync numbered ("owner 2") is found again even without the record', async () => {
  const { jf, db } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  db.sync = { jellyfinHouseholdServers: { s1: { ...db.sync.jellyfinHouseholdServers.s1, accounts: {} } } }
  db.creds.length = 0
  const changes = await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  assert.equal(changes.find((c) => c.personId === 'p-owner').action, 'linked')
  assert.equal([...jf.users.values()].filter((u) => /^owner/.test(u.Name)).length, 2)
})

test('a merge takes the Jellyfin slot; once it is undone, the next sync signs them in again', async () => {
  const { db } = await setup()
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  // A merge replaced Sarah's server sign-in with her own merged-in login...
  const i = db.creds.findIndex((c) => c.userId === 'p-sarah')
  db.creds.splice(i, 1, { id: 'merged', userId: 'p-sarah', providerType: 'jellyfin', origin: null, jellyfinServerUrl: 'https://elsewhere.invalid' })
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  assert.equal(db.sync.jellyfinHouseholdServers.s1.accounts['p-sarah'].tracked, false)
  assert.equal(db.creds.filter((c) => c.userId === 'p-sarah').length, 1)
  // ...and was undone.
  db.creds.splice(db.creds.findIndex((c) => c.id === 'merged'), 1)
  await servers.syncForGroup(db.prisma, 'acc', 'g-family')
  assert.equal(db.sync.jellyfinHouseholdServers.s1.accounts['p-sarah'].tracked, true)
  assert.ok(db.creds.some((c) => c.userId === 'p-sarah' && c.origin === 'jellyfin-server:s1'))
})

test('names Jellyfin takes, and which server a sign-in is on', () => {
  assert.equal(servers.accountName('Jen 🎬!', new Set()), 'Jen')
  assert.equal(servers.accountName('jen', new Set(['jen', 'jen 2'])), 'jen 3')
  assert.equal(servers.accountName('🎬', new Set()), 'user')
  const s = { url: URL, serverId: 'srv1' }
  assert.ok(servers.sameServer(s, 'http://JF.example.invalid', null))
  assert.ok(servers.sameServer(s, 'https://other.invalid', 'SRV1'))
  assert.ok(!servers.sameServer(s, 'https://other.invalid', 'srv2'))
})

test('a server sign-in is never shown or undone as a merge', async () => {
  const { getUndoInfo } = require('../server/utils/userMerge')
  const rows = [{ id: 'c1', userId: 'p-sarah', providerType: 'jellyfin', origin: 'jellyfin-server:s1' }]
  const prisma = { userProviderCredential: { findFirst: async ({ where }) => rows.find((r) => r.userId === where.userId && (where.origin === undefined || r.origin === where.origin)) || null } }
  assert.equal(await getUndoInfo(prisma, 'p-sarah'), null)
  rows.push({ id: 'c2', userId: 'p-sarah', providerType: 'stremio', origin: null, donorId: 'd', mergeArchivePath: null })
  assert.equal((await getUndoInfo(prisma, 'p-sarah')).providerType, 'stremio')
})
