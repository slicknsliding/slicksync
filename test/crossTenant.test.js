// Two households on one public instance must never see or touch each other's
// proxy logs, people, addons or groups through ids they send.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const express = require('express')

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slick-xtenant-'))
process.env.LOG_DIR = LOG_DIR
const { readProxyLogs, PROXY_LOG_FILE } = require('../server/utils/proxyLogger')
const userMerge = require('../server/utils/userMerge')
const makeAddonsRouter = require('../server/routes/addons')
const makeGroupsRouter = require('../server/routes/groups')
const makeSnapshotsRouter = require('../server/routes/snapshots')

async function serve(mount, router, fn) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.appAccountId = 'A'; next() })
  app.use(mount, router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, body: await res.json() }
    }
    return await fn(call)
  } finally {
    server.close()
  }
}

// ---- 1. proxy logs ----

test('the all-logs route returns only the callers account, including old entries without accountId', async () => {
  const lines = [
    { addonId: 'a1', accountId: 'A', upstreamUrl: 'https://a.example/KEYA' },
    { addonId: 'b1', accountId: 'B', upstreamUrl: 'https://b.example/KEYB' },
    { addonId: 'a1', upstreamUrl: 'https://a.example/old' },            // written before accountId existed
    { addonId: 'b1', upstreamUrl: 'https://b.example/old' },
    { addonName: 'Stream Proxy', upstreamUrl: 'https://x.example/s' },  // tied to no account
  ]
  fs.writeFileSync(PROXY_LOG_FILE, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const addons = { A: ['a1'], B: ['b1'] }
  const make = (acc, type) => makeAddonsRouter({
    prisma: { addon: { findMany: async ({ where }) => (addons[where.accountId] || []).map((id) => ({ id })) } },
    getAccountId: () => acc,
    INSTANCE_TYPE: type,
  })
  const urls = async (acc, type = 'public') => serve('/addons', make(acc, type), async (call) => {
    const r = await call('GET', '/addons/proxy-logs/all')
    assert.equal(r.status, 200)
    return r.body.data.logs.map((l) => l.upstreamUrl).sort()
  })
  assert.deepEqual(await urls('A'), ['https://a.example/KEYA', 'https://a.example/old'])
  assert.deepEqual(await urls('B'), ['https://b.example/KEYB', 'https://b.example/old'])
  assert.deepEqual(await urls(null), [])
  // A private instance has one account, so unattributed stream-proxy lines stay visible.
  assert.ok((await urls('A', 'private')).includes('https://x.example/s'))
  // The per-addon route filters by addon id alone.
  assert.equal((await readProxyLogs({ addonId: 'a1' })).total, 2)
})

// ---- 2. merge ----

function mergeDb(users) {
  return {
    user: { findFirst: async ({ where }) => users.find((u) => u.id === where.id && (!where.accountId || u.accountId === where.accountId)) || null },
    userProviderCredential: { findFirst: async () => null, findUnique: async () => null },
    movieWatchHistory: { count: async () => 0 },
    episodeWatchHistory: { count: async () => 0 },
    watchSession: { count: async () => 0 },
    watchSnapshot: { count: async () => 0 },
    group: { findFirst: async () => null },
  }
}

test('merge preview, merge, undo info and undo refuse people of another account', async () => {
  const users = [
    { id: 'u1', accountId: 'A', username: 'one', providerType: 'stremio' },
    { id: 'u2', accountId: 'A', username: 'two', providerType: 'nuvio' },
    { id: 'x1', accountId: 'B', username: 'other', providerType: 'nuvio' },
  ]
  const db = mergeDb(users)
  assert.equal((await userMerge.getMergePreview(db, 'u1', 'u2', 'A')).donor.id, 'u2')
  await assert.rejects(userMerge.getMergePreview(db, 'u1', 'x1', 'A'), /Donor user not found/)
  await assert.rejects(userMerge.getMergePreview(db, 'x1', 'u2', 'A'), /Survivor user not found/)
  await assert.rejects(userMerge.getMergePreview(db, 'u1', 'x1', 'B'), /Survivor user not found/)
  await assert.rejects(userMerge.getMergePreview(db, 'u1', 'u2', null), /Account not found/)
  await assert.rejects(userMerge.mergeUsers(db, 'u1', 'x1', 'A'), /Donor user not found/)
  assert.equal(await userMerge.getUndoInfo(db, 'x1', 'A'), null)
  await assert.rejects(userMerge.undoMerge(db, 'x1', 'A'), /No merged account/)
})

test('undo refuses an archive that belongs to another account', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slick-xtenant-merge-'))
  fs.mkdirSync(path.join(dataDir, 'backup', 'merges'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'backup', 'merges', 'arc.json'), JSON.stringify({ donorId: 'd1', donor: { id: 'd1', accountId: 'B', username: 'd' } }))
  const db = mergeDb([{ id: 'u1', accountId: 'A' }])
  db.userProviderCredential.findFirst = async () => ({ id: 'c1', userId: 'u1', donorId: 'd1', mergeArchivePath: 'arc.json', origin: null })
  await assert.rejects(userMerge.undoMerge(db, 'u1', 'A', { dataDir }), /another account/)
})

// ---- 3. group / addon references ----

function linkDb() {
  const state = { links: [], groupUpdates: 0 }
  const addons = [{ id: 'addA', accountId: 'A' }, { id: 'addB', accountId: 'B' }]
  const groups = [{ id: 'grA', accountId: 'A' }, { id: 'grB', accountId: 'B' }]
  const pick = (rows, where) => rows.filter((r) => (!where.accountId || r.accountId === where.accountId) && (!where.id || (where.id.in ? where.id.in.includes(r.id) : where.id === r.id)))
  const prisma = {
    addon: {
      count: async ({ where }) => pick(addons, where).length,
      findFirst: async ({ where }) => (pick(addons, where)[0] ? { ...pick(addons, where)[0], groupAddons: [] } : null),
    },
    group: {
      count: async ({ where }) => pick(groups, where).length,
      findFirst: async ({ where }) => (pick(groups, where)[0] ? { ...pick(groups, where)[0], name: 'g', description: '', addons: [] } : null),
      update: async () => { state.groupUpdates++; return {} },
    },
    groupAddon: {
      deleteMany: async () => {},
      createMany: async ({ data }) => { state.links.push(...data) },
      create: async ({ data }) => { state.links.push(data) },
    },
  }
  return { prisma, state }
}

test('a group edit cannot link another accounts addon, and writes nothing when it refuses', async () => {
  const { prisma, state } = linkDb()
  const router = makeGroupsRouter({ prisma, getAccountId: () => 'A', scopedWhere: (r, e) => ({ accountId: 'A', ...e }), INSTANCE_TYPE: 'public', decrypt: (v) => v })
  await serve('/groups', router, async (call) => {
    const bad = await call('PUT', '/groups/grA', { addonIds: ['addA', 'addB'] })
    assert.equal(bad.status, 400)
    assert.equal(state.groupUpdates, 0)
    assert.deepEqual(state.links, [])
    const ok = await call('PUT', '/groups/grA', { addonIds: ['addA'] })
    assert.equal(ok.status, 200)
    assert.deepEqual(state.links.map((l) => l.addonId), ['addA'])
  })
})

test('updating an addon cannot put it in another accounts group', async () => {
  const { prisma, state } = linkDb()
  const router = makeAddonsRouter({ prisma, getAccountId: () => 'A', INSTANCE_TYPE: 'public' })
  await serve('/addons', router, async (call) => {
    const bad = await call('PUT', '/addons/addA', { groupIds: ['grA', 'grB'] })
    assert.equal(bad.status, 400)
    assert.deepEqual(state.links, [])
  })
})

test('creating an addon cannot put it in another accounts group', async () => {
  const { prisma, state } = linkDb()
  const router = makeAddonsRouter({ prisma, getAccountId: () => 'A', INSTANCE_TYPE: 'public' })
  await serve('/addons', router, async (call) => {
    const bad = await call('POST', '/addons', { url: 'https://example.com/manifest.json', groupIds: ['grB'] })
    assert.equal(bad.status, 400)
    assert.deepEqual(state.links, [])
  })
})

test('a group snapshot ignores links to another accounts addons', async () => {
  let seenWhere = null
  let saved = null
  const rows = [
    { addon: { name: 'mine', accountId: 'A', manifestUrl: 'enc' }, position: 0 },
    { addon: { name: 'foreign', accountId: 'B', manifestUrl: 'enc' }, position: 1 },
  ]
  const prisma = {
    group: { findFirst: async () => ({ id: 'grA' }) },
    groupAddon: { findMany: async ({ where }) => { seenWhere = where; return rows.filter((r) => r.addon.accountId === where.addon.accountId) } },
    addonSnapshot: { create: async ({ data }) => { saved = data; return { id: 's1', ...data } } },
  }
  const router = makeSnapshotsRouter({ prisma, getAccountId: () => 'A', encrypt: (v) => v, decrypt: (v) => v, createProvider: () => null })
  await serve('/snapshots', router, async (call) => {
    const r = await call('POST', '/snapshots', { name: 'n', sourceType: 'group', sourceId: 'grA' })
    assert.ok(r.status < 300, JSON.stringify(r.body))
    assert.equal(seenWhere.addon.accountId, 'A')
    assert.deepEqual(JSON.parse(saved.addonsJson).map((a) => a.name), ['mine'])
  })
})
