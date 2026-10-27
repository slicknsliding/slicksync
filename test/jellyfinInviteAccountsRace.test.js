// An invitation that makes Jellyfin accounts is open to anyone with the link,
// so parallel requests must not get past the waiting limit, must not lose the
// record of an account they made, and a request that is refused must not leave
// an account on the household's server.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const serverCollections = require('../server/utils/jellyfinServerCollections')
const jfAuth = require('../server/providers/jellyfinAuth')
const inviteAccounts = require('../server/utils/jellyfinInviteAccounts')
const makeInvitationsRouter = require('../server/routes/invitations')

const realFetch = global.fetch
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const URL = 'https://jf.example.test'

// A Jellyfin server that makes, switches and deletes accounts, slowly.
function fakeJellyfin(t) {
  const users = new Map() // id -> { Name, Policy }
  let n = 0
  const orig = { call: serverCollections.call, serversFor: serverCollections.serversFor, findActor: serverCollections.findActor, probe: jfAuth.probeServer, auth: jfAuth.authenticateByName }
  serverCollections.serversFor = async () => [{ key: 'srv', address: 'jf.example.test', url: URL }]
  serverCollections.findActor = async () => ({ session: { fake: true }, admin: true })
  serverCollections.call = async (_s, path, opts = {}) => {
    await delay(5)
    if (path === '/Users/New') {
      if ([...users.values()].some((u) => u.Name === opts.body.Name)) throw Object.assign(new Error('taken'), { status: 400 })
      const id = `u${++n}`.padStart(32, '0')
      users.set(id, { Name: opts.body.Name, Policy: { IsDisabled: false } })
      return { Id: id }
    }
    const m = /^\/Users\/([^/]+)(\/Policy)?$/.exec(path)
    const u = m && users.get(m[1])
    if (!u) throw Object.assign(new Error('missing'), { status: 404 })
    if (opts.method === 'DELETE') { users.delete(m[1]); return null }
    if (m[2]) { u.Policy = opts.body; return null }
    return { Id: m[1], Name: u.Name, Policy: u.Policy }
  }
  jfAuth.probeServer = async () => ({ serverUrl: URL, serverId: 'sid', kind: 'jellyfin' })
  jfAuth.authenticateByName = async (_u, name) => {
    const id = [...users].find(([, v]) => v.Name === name)?.[0]
    return { token: 'tok', userId: id, userName: name, serverId: 'sid' }
  }
  t.after(() => {
    serverCollections.call = orig.call; serverCollections.serversFor = orig.serversFor; serverCollections.findActor = orig.findActor
    jfAuth.probeServer = orig.probe; jfAuth.authenticateByName = orig.auth
  })
  return users
}

// Just enough prisma, with latency so reads and writes interleave.
function fakePrisma(extra = {}) {
  const account = { id: 'acc1', sync: { jellyfinInvites: { inv1: 'srv' }, other: { keep: 'me' } } }
  const invitation = { id: 'inv1', accountId: 'acc1', inviteCode: 'CODE', isActive: true, expiresAt: null, maxUses: null, currentUses: 0 }
  const requests = []
  const people = [...(extra.people || [])]
  let n = 0
  const matchRow = (row, where = {}) => Object.entries(where).every(([k, v]) => typeof v !== 'object' || v === null ? row[k] === v : true)
  return {
    account, requests,
    appAccount: {
      findUnique: async () => { const snapshot = JSON.parse(JSON.stringify(account)); await delay(2); return { sync: snapshot.sync } },
      update: async ({ data }) => { await delay(2); account.sync = data.sync },
      findMany: async () => [{ id: 'acc1' }],
    },
    invitation: { findUnique: async ({ where }) => (where.inviteCode === 'CODE' ? { ...invitation } : null) },
    user: { findFirst: async ({ where }) => people.find((p) => matchRow(p, where)) || null, findMany: async () => [], update: async () => {} },
    inviteRequest: {
      findFirst: async ({ where }) => requests.find((r) => matchRow(r, where)) || null,
      findUnique: async ({ where }) => { const r = requests.find((x) => x.id === where.id); return r ? { ...r, invitation: { ...invitation } } : null },
      create: async ({ data }) => { await delay(2); const r = { id: `r${++n}`, createdAt: new Date(), ...data }; requests.push(r); return { ...r } },
      update: async ({ where, data }) => { const r = requests.find((x) => x.id === where.id); Object.assign(r, data); return { ...r } },
      delete: async ({ where }) => { requests.splice(requests.findIndex((x) => x.id === where.id), 1) },
    },
  }
}

const records = (prisma) => Object.values(prisma.account.sync.jellyfinInviteAccounts || {})

test('30 parallel requests make at most 10 accounts, and every one is on record', async (t) => {
  const users = fakeJellyfin(t)
  const prisma = fakePrisma()
  const invitation = { id: 'inv1', accountId: 'acc1' }
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) =>
    inviteAccounts.createForRequest(prisma, (v) => v, invitation, { username: `person${i}`, password: 'secret1' })))
  const made = results.filter((r) => r.status === 'fulfilled')
  const refused = results.filter((r) => r.status === 'rejected')
  assert.equal(made.length, 10)
  assert.equal(users.size, 10, 'no more accounts on the server than the limit')
  assert.ok(refused.every((r) => r.reason.status === 429))
  assert.equal(records(prisma).length, 10, 'every account made is recorded')
  assert.ok(records(prisma).every((r) => r.jellyfinUserId && !r.reservedAt), 'no held place left over')
  assert.deepEqual(prisma.account.sync.other, { keep: 'me' }, 'other settings are untouched')
  assert.ok([...users.values()].every((u) => u.Policy.IsDisabled), 'all wait switched off')
})

test('a failed account leaves neither a held place nor an account', async (t) => {
  const users = fakeJellyfin(t)
  const prisma = fakePrisma()
  const invitation = { id: 'inv1', accountId: 'acc1' }
  jfAuth.authenticateByName = async () => { throw Object.assign(new Error('boom'), { status: 502 }) }
  await assert.rejects(inviteAccounts.createForRequest(prisma, (v) => v, invitation, { username: 'ann', password: 'secret1' }))
  assert.equal(users.size, 0)
  assert.equal(records(prisma).length, 0)
})

test('concurrent writers to the account settings do not undo each other', async () => {
  const prisma = fakePrisma()
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    inviteAccounts.setInvitationServer(prisma, 'acc1', `i${i}`, `server${i}`)))
  assert.equal(Object.keys(prisma.account.sync.jellyfinInvites).length, 21)
  assert.deepEqual(prisma.account.sync.other, { keep: 'me' })
})

async function serve(t, prisma) {
  const app = express()
  app.use(express.json())
  const deps = { prisma, getAccountId: () => 'acc1', INSTANCE_TYPE: 'private', encrypt: (v) => v, decrypt: (v) => v, assignUserToGroup: async () => {} }
  app.use('/api/invitations', makeInvitationsRouter(deps))
  app.use('/invite', makeInvitationsRouter.createPublicRouter(deps))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  return async (method, route, body) => {
    const res = await realFetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, body: json }
  }
}

test('a username already taken is refused before any account is made', async (t) => {
  const users = fakeJellyfin(t)
  const prisma = fakePrisma({ people: [{ accountId: 'acc1', username: 'ann' }] })
  const api = await serve(t, prisma)
  const res = await api('POST', '/invite/CODE/request', { username: 'ann', jellyfinNew: { password: 'secret1' } })
  assert.equal(res.status, 409)
  assert.equal(users.size, 0)
  assert.equal(records(prisma).length, 0)
})

test('a request that fails after the account was made takes the account away again', async (t) => {
  const users = fakeJellyfin(t)
  const prisma = fakePrisma()
  prisma.inviteRequest.create = async () => { throw new Error('database down') }
  const api = await serve(t, prisma)
  const res = await api('POST', '/invite/CODE/request', { username: 'bob', jellyfinNew: { password: 'secret1' } })
  assert.equal(res.status, 500)
  assert.equal(users.size, 0)
  assert.equal(records(prisma).length, 0)
})

test('rejecting a request deletes its account, and accepting it again says so', async (t) => {
  const users = fakeJellyfin(t)
  const prisma = fakePrisma()
  const api = await serve(t, prisma)
  const made = await api('POST', '/invite/CODE/request', { username: 'cy', jellyfinNew: { password: 'secret1' } })
  assert.equal(made.status, 200)
  assert.equal(users.size, 1)

  const rejected = await api('POST', `/api/invitations/requests/${made.body.id}/reject`)
  assert.equal(rejected.status, 200)
  assert.equal(users.size, 0, 'the account is gone from the server')
  assert.equal(records(prisma)[0].state, 'removed')

  const undo = await api('POST', `/api/invitations/requests/${made.body.id}/undo-rejection`, {})
  assert.equal(undo.status, 409)

  const deleted = await api('DELETE', `/api/invitations/requests/${made.body.id}`)
  assert.equal(deleted.status, 200)
  assert.equal(records(prisma).length, 0, 'deleting the request clears the note')
})

test('undoing the rejection of a request with no invite-made account still works', async (t) => {
  fakeJellyfin(t)
  const prisma = fakePrisma()
  prisma.requests.push({ id: 'rx', invitationId: 'inv1', status: 'rejected', providerType: 'jellyfin', jellyfinServerUrl: URL, jellyfinUserId: 'existing' })
  const api = await serve(t, prisma)
  assert.equal((await api('POST', '/api/invitations/requests/rx/reject')).status, 200)
  const undo = await api('POST', '/api/invitations/requests/rx/undo-rejection', {})
  assert.equal(undo.status, 200)
  assert.equal(undo.body.status, 'accepted')
})
