const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const gate = require('../server/utils/streamGate')
const helpers = require('../server/utils/helpers')
const { getDesiredAddons } = require('../server/utils/sync')

const TOKEN = 'ab'.repeat(24)
const BASE = 'https://slicksync.example.com'
const CATALOGS = { id: 'a1', name: 'Catalogs', transportUrl: 'https://catalogs.example.com/manifest.json', transportName: '', manifest: { id: 'org.catalogs', name: 'Catalogs', resources: ['catalog', 'meta'] } }
const STREAMS = { id: 'a2', name: 'My Streams', transportUrl: 'https://streams.example.com/abc/manifest.json', transportName: '', manifest: { id: 'org.streams', name: 'Streams', resources: [{ name: 'stream', types: ['movie'] }] } }

// One person (Mia, on Nuvio) in one group holding CATALOGS and STREAMS; `cfg`
// is the account's settings, read live.
const REACHED = { streamGateCheck: { state: { base: BASE, ok: true, fails: 0, at: 0, next: 8e15 } } }

function fakeAccount(cfg) {
  const updates = []
  const prisma = {
    appAccount: { findUnique: async () => ({ sync: JSON.stringify({ ...REACHED, ...cfg() }) }), findFirst: async () => ({ sync: JSON.stringify({ ...REACHED, ...cfg() }) }), update: async () => ({}) },
    group: { findMany: async () => [{ id: 'g1' }] },
    user: {
      findUnique: async ({ where }) => (where.id === 'mia' ? { providerType: 'nuvio', traxToken: null } : null),
      findFirst: async ({ where }) => (where.traxToken === TOKEN ? { id: 'mia', accountId: 'default' } : null),
      update: async ({ data }) => { updates.push(data); return data },
    },
  }
  return { prisma, updates }
}

const realGetGroupAddons = helpers.getGroupAddons
function withGroup(fn) {
  helpers.getGroupAddons = async () => [CATALOGS, STREAMS]
  return Promise.resolve().then(fn).finally(() => { helpers.getGroupAddons = realGetGroupAddons; gate.forgetResolvedForTests() })
}

test('a gate address carries the token and addon, and changes when the real address does', () => {
  const url = gate.gateUrl({ base: BASE, token: TOKEN }, 'a2', STREAMS.transportUrl)
  assert.match(url, new RegExp(`^${BASE}/trax/gate/${TOKEN}/a2/[a-f0-9]{10}/manifest\\.json$`))
  assert.deepEqual(gate.parseGateUrl(url), { token: TOKEN, addonId: 'a2' })
  assert.notEqual(url, gate.gateUrl({ base: BASE, token: TOKEN }, 'a2', 'https://streams.example.com/new/manifest.json'))
  assert.equal(gate.parseGateUrl(STREAMS.transportUrl), null)
})

test('the gate is for Stremio and Nuvio people with a pause set up, on an instance with a public address', async () => {
  let cfg = { publicBaseUrl: BASE, screenTime: { mia: { bedtime: { from: '21:00', to: '07:00', days: [] } } } }
  const { prisma, updates } = fakeAccount(() => cfg)
  const mia = { id: 'mia', providerType: 'nuvio', traxToken: null }

  const g = await gate.gateFor(prisma, 'default', mia)
  assert.equal(g.base, BASE)
  assert.match(g.token, /^[a-f0-9]{48}$/, 'given a token of their own')
  assert.deepEqual(updates, [{ traxToken: g.token }], 'and it is kept')
  assert.equal((await gate.gateFor(prisma, 'default', { ...mia, traxToken: TOKEN })).token, TOKEN, 'an existing token is used')

  assert.equal(await gate.gateFor(prisma, 'default', { ...mia, providerType: 'jellyfin' }), null, 'not Jellyfin')
  cfg = { publicBaseUrl: BASE, screenTime: { mia: { minutes: 90, days: [] } } }
  assert.equal(await gate.gateFor(prisma, 'default', mia), null, 'a limit that only alerts never pauses')
  cfg = { publicBaseUrl: BASE, screenTime: { mia: { minutes: 90, days: [], onReach: 'pause' } } }
  assert.ok(await gate.gateFor(prisma, 'default', mia), 'a limit that pauses')
  cfg = { screenTime: { mia: { minutes: 90, days: [], onReach: 'pause' } }, streamGateCheck: null }
  assert.equal(await gate.gateFor(prisma, 'default', mia), null, 'no public address: nothing a device could reach')
})

test('the sync puts the stream addons through the gate, and keeps them there through a pause', async () => {
  await withGroup(async () => {
    const bedtime = { mia: { bedtime: { from: '21:00', to: '07:00', days: [] } } }
    let cfg = { publicBaseUrl: BASE, screenTime: bedtime }
    const { prisma } = fakeAccount(() => cfg)
    const deps = { prisma, getAccountId: () => 'default', decrypt: (x) => x, parseAddonIds: () => [], parseProtectedAddons: () => [], canonicalizeManifestUrl: (u) => u, _prefetchedUserAddons: [] }
    const mia = { id: 'mia', providerType: 'nuvio', traxToken: TOKEN, excludedAddons: null, protectedAddons: null }
    const urls = async () => (await getDesiredAddons(mia, {}, deps)).addons.map((a) => a.transportUrl)

    const gated = gate.gateUrl({ base: BASE, token: TOKEN }, 'a2', STREAMS.transportUrl)
    assert.deepEqual(await urls(), [CATALOGS.transportUrl, gated], 'only the stream addon is gated')
    cfg = { publicBaseUrl: BASE, screenTime: bedtime, screenTimePauses: { mia: { until: '2999-01-01T00:00:00.000Z' } } }
    assert.deepEqual(await urls(), [CATALOGS.transportUrl, gated], 'paused: the same list - the gate does the pausing')
    const named = (await getDesiredAddons(mia, {}, deps)).addons[1].manifest.name
    assert.equal(named, 'My Streams', 'with the name set in SlickSync, as before')
    cfg = { publicBaseUrl: BASE }
    assert.deepEqual(await urls(), [CATALOGS.transportUrl, STREAMS.transportUrl], 'no pause set up: the real addresses')
  })
})

async function gateServer(cfg) {
  const { prisma } = fakeAccount(cfg)
  const app = express()
  app.use('/trax', require('../server/routes/traxAddon')({ prisma }))
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

test('the gate: the manifest, streams sent on to the addon, and nothing to play while paused', async () => {
  await withGroup(async () => {
    const bedtime = { mia: { bedtime: { from: '21:00', to: '07:00', days: [] } } }
    let cfg = { screenTime: bedtime }
    const srv = await gateServer(() => cfg)
    try {
      const at = `${srv.base}/trax/gate/${TOKEN}/a2/0123456789`
      const manifest = await fetch(`${at}/manifest.json`)
      assert.equal(manifest.status, 200)
      assert.equal(manifest.headers.get('cache-control'), 'no-store')
      assert.equal(manifest.headers.get('access-control-allow-origin'), '*')
      assert.deepEqual(await manifest.json(), { ...STREAMS.manifest, name: 'My Streams' })

      const stream = await fetch(`${at}/stream/series/tt0903747%3A1%3A2.json?x=1`, { redirect: 'manual' })
      assert.equal(stream.status, 302)
      assert.equal(stream.headers.get('location'), 'https://streams.example.com/abc/stream/series/tt0903747%3A1%3A2.json?x=1')
      assert.equal(stream.headers.get('cache-control'), 'no-store')

      cfg = { screenTime: bedtime, screenTimePauses: { mia: { until: '2999-01-01T00:00:00.000Z' } } }
      const paused = await fetch(`${at}/stream/movie/tt0111161.json`, { redirect: 'manual' })
      assert.equal(paused.status, 200)
      assert.deepEqual(await paused.json(), { streams: [] })
      const catalog = await fetch(`${at}/catalog/movie/top.json`, { redirect: 'manual' })
      assert.equal(catalog.status, 302, 'catalogs still browse while paused')
      assert.equal(catalog.headers.get('location'), 'https://streams.example.com/abc/catalog/movie/top.json')

      assert.equal((await fetch(`${srv.base}/trax/gate/${'cd'.repeat(24)}/a2/0123456789/manifest.json`)).status, 404, 'unknown token')
      assert.equal((await fetch(`${srv.base}/trax/gate/${TOKEN}/gone/0123456789/manifest.json`)).status, 404, 'an addon not in their group')
    } finally {
      await srv.close()
    }
  })
})

test('reaching the gate: worked stays worked through one failure, never-worked fails at once, a login page is caught', async () => {
  let cfg = {}
  const prisma = {
    appAccount: {
      findUnique: async () => ({ sync: JSON.stringify({ publicBaseUrl: BASE, ...cfg }) }),
      findFirst: async () => ({ sync: JSON.stringify({ publicBaseUrl: BASE, ...cfg }) }),
      update: async ({ data }) => { const all = JSON.parse(data.sync); delete all.publicBaseUrl; cfg = all },
    },
  }
  const answer = (reply) => async () => reply
  const ok = { status: 200, ok: true, json: async () => ({ slicksync: 'gate' }) }
  const down = async () => { throw new Error('ECONNREFUSED') }
  const login = { status: 302, ok: false, json: async () => null }
  const H = 60 * 60 * 1000

  assert.equal((await gate.gateUsable(prisma, 'acc', { now: 0, fetchImpl: down })).ok, false, 'never worked: no')
  cfg = {}
  assert.equal((await gate.gateUsable(prisma, 'acc', { now: 0, fetchImpl: answer(ok) })).ok, true)
  assert.equal((await gate.gateUsable(prisma, 'acc', { now: H, fetchImpl: down })).ok, true, 'kept: not looked at again for six hours')
  assert.equal((await gate.gateUsable(prisma, 'acc', { now: 7 * H, fetchImpl: down })).ok, true, 'one failure after working: still on')
  assert.equal((await gate.gateUsable(prisma, 'acc', { now: 7 * H + 31 * 60000, fetchImpl: down })).ok, false, 'a second, half an hour on: off')
  cfg = {}
  const r = await gate.gateUsable(prisma, 'acc', { now: 0, fetchImpl: answer(login) })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'login')
})

test('a merged profile\'s own stream addon, wrapped: its manifest, sent on, nothing while paused, nothing above its age limit', async () => {
  const { encrypt } = require('../server/utils/encryption')
  const real = 'https://kids-streams.example.com/xyz/manifest.json'
  const KID = 'np-nuv1-3'
  let cfg = { screenTime: { [KID]: { bedtime: { from: '21:00', to: '07:00', days: [] } } } }
  const wrap = { id: 'w1', accountId: 'default', userId: 'mia', subjectId: KID, realUrl: encrypt(real, { appAccountId: 'default' }) }
  const prisma = {
    appAccount: { findUnique: async () => ({ sync: JSON.stringify(cfg) }), findFirst: async () => ({ sync: JSON.stringify(cfg) }) },
    user: { findFirst: async ({ where }) => (where.traxToken === TOKEN ? { id: 'mia', accountId: 'default' } : null) },
    streamGateWrap: { findFirst: async ({ where }) => (where.id === 'w1' && where.userId === 'mia' ? wrap : null) },
  }
  const app = express()
  app.use('/trax', require('../server/routes/traxAddon')({ prisma }))
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const at = `http://127.0.0.1:${server.address().port}/trax/gate/${TOKEN}/w-w1/0123456789`
  try {
    const sent = await fetch(`${at}/stream/movie/tt0111161.json`, { redirect: 'manual' })
    assert.equal(sent.status, 302)
    assert.equal(sent.headers.get('location'), 'https://kids-streams.example.com/xyz/stream/movie/tt0111161.json')

    cfg = { screenTime: { [KID]: { bedtime: { from: '21:00', to: '07:00', days: [] } } }, screenTimePauses: { [KID]: { until: '2999-01-01T00:00:00.000Z' } } }
    gate.forgetResolvedForTests()
    assert.deepEqual(await (await fetch(`${at}/stream/movie/tt0111161.json`)).json(), { streams: [] }, 'paused: only the profile')

    cfg = { ageLimits: { [KID]: { maxAge: 10, blockUnrated: true } } }
    const verdict = (path) => gate.streamVerdict(prisma, { subjectId: KID, accountId: 'default' }, path, { ratingOf: async (id) => ({ tt1: 'PG', tt2: 'R' }[id] || null) })
    assert.equal(await verdict('stream/movie/tt1.json'), 'pass')
    assert.equal(await verdict('stream/movie/tt2.json'), 'age')
    assert.equal(await verdict('stream/movie/tt9.json'), 'age', 'unrated, and unrated ones are blocked')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('an address only the server itself can reach is never used for the gate', async () => {
  for (const base of ['http://slicksync-betatest-slicksync-1:3000', 'http://localhost:3000', 'http://127.0.0.1:4000', 'http://host.docker.internal:3000', 'http://[::1]:3000']) {
    assert.equal(gate.deviceReachable(base), false, base)
  }
  for (const base of ['https://slicksync.example.com', 'http://192.168.1.20:3000', 'http://nas.local:3000']) {
    assert.equal(gate.deviceReachable(base), true, base)
  }
  // Even with a check on record that passed, an internal address is refused before anything is asked.
  const prisma = { appAccount: { findUnique: async () => ({ sync: JSON.stringify({ publicBaseUrl: 'http://slicksync-1:3000', streamGateCheck: { state: { base: 'http://slicksync-1:3000', ok: true, next: 8e15 } } }) }), findFirst: async () => ({ sync: '{}' }) } }
  const r = await gate.gateUsable(prisma, 'acc', { fetchImpl: async () => { throw new Error('should not be asked') } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'internal-address')
})

// Stremio people: their app's events come in through one stream addon, without SlickTrax.
const STREAMS2 = { ...STREAMS, id: 'a3', name: 'More Streams', transportUrl: 'https://more.example.com/manifest.json' }
const noah = { id: 'noah', accountId: 'default', username: 'Noah', providerType: 'stremio', traxToken: TOKEN, traxAddonEnabled: false, isActive: true, excludedAddons: null, protectedAddons: null }

function stremioAccount(person, cfg = () => ({ publicBaseUrl: BASE })) {
  const { prisma } = fakeAccount(cfg)
  const cursors = new Map()
  prisma.user.findUnique = async () => person()
  prisma.user.findFirst = async ({ where }) => (where.traxToken === TOKEN ? { id: person().id, accountId: 'default' } : null)
  prisma.watchStateCursor = {
    findUnique: async ({ where }) => cursors.get(where.accountId_userId_videoId.videoId) || null,
    upsert: async ({ where, create, update }) => { const id = where.accountId_userId_videoId.videoId; cursors.set(id, { ...(cursors.get(id) || create), ...update, itemName: 'Named' }) },
    update: async () => ({}),
    delete: async ({ where }) => { cursors.delete(where.accountId_userId_videoId.videoId) },
    deleteMany: async () => ({ count: 0 }),
  }
  return { prisma, cursors }
}

test('someone on Stremio without SlickTrax has one stream addon carry the events; nothing is added to the list', async () => {
  const { prisma } = stremioAccount(() => noah)
  const deps = { prisma, getAccountId: () => 'default', decrypt: (x) => x, parseAddonIds: () => [], parseProtectedAddons: () => [], canonicalizeManifestUrl: (u) => u, _prefetchedUserAddons: [] }
  helpers.getGroupAddons = async () => [CATALOGS, STREAMS, STREAMS2]
  try {
    const { addons } = await getDesiredAddons(noah, {}, deps)
    assert.deepEqual(addons.map((a) => a.transportUrl), [CATALOGS.transportUrl, gate.gateUrl({ base: BASE, token: TOKEN }, 'a2', STREAMS.transportUrl), STREAMS2.transportUrl])
    const names = (m) => (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name))
    assert.ok(names(addons[1].manifest).includes('player') && names(addons[1].manifest).includes('library'))
    assert.ok(names(addons[1].manifest).includes('stream'), 'and still what it was')
    assert.ok(!names(addons[0].manifest).includes('player'))
    assert.ok(!names(addons[2].manifest).includes('player'))

    assert.equal(await gate.gateFor(prisma, 'default', { ...noah, traxAddonEnabled: true }), null, 'SlickTrax already hears them')
    assert.equal(await gate.gateFor(prisma, 'default', { ...noah, providerType: 'nuvio' }), null, 'Nuvio sends no such events')
    const { prisma: noAddress } = stremioAccount(() => noah, () => ({ streamGateCheck: null }))
    assert.equal(await gate.gateFor(noAddress, 'default', noah), null, 'no public address: installed as it is')
  } finally {
    helpers.getGroupAddons = realGetGroupAddons
    gate.forgetResolvedForTests()
  }
})

test('the gate answers Stremio events itself and sends everything else on', async () => {
  let person = noah
  await withGroup(async () => {
    const { prisma, cursors } = stremioAccount(() => person)
    const app = express()
    app.use('/trax', require('../server/routes/traxAddon')({ prisma }))
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    const at = `http://127.0.0.1:${server.address().port}/trax/gate/${TOKEN}/a2/0123456789`
    const event = (path) => fetch(`${at}/${path}`, { redirect: 'manual' })
    try {
      const manifest = await (await fetch(`${at}/manifest.json`)).json()
      assert.ok(manifest.resources.some((r) => r.name === 'player'), 'the manifest declares them')

      const start = await event('player/series/tt0096697%3A1%3A1/action=start&currentTime=159000&duration=1395000.json')
      assert.equal(start.status, 200, 'not sent on to the addon')
      assert.deepEqual(await start.json(), {})
      const playing = cursors.get('tt0096697:1:1')
      assert.equal(playing.startPositionMs, 159000)
      assert.ok(playing.startAt, 'playing')
      await new Promise((r) => setTimeout(r, 20))

      await event('player/series/tt0096697%3A1%3A1/action%3Dpause%26currentTime%3D161000%26duration%3D1395000.json')
      const paused = cursors.get('tt0096697:1:1')
      assert.equal(paused.startPositionMs, 161000, 'also when the app encodes the whole thing')
      assert.equal(paused.startAt, null, 'paused')

      assert.equal((await event('player/series/tt0096697%3A1%3A1/action=stop&currentTime=161000&duration=1395000.json')).status, 200)
      assert.equal(cursors.size, 0, 'stopped')

      assert.equal((await event('stream/series/tt0096697%3A1%3A1.json')).status, 302, 'finding something to play still goes to the addon')

      person = { ...noah, isActive: false }
      assert.equal((await event('player/movie/tt0111161/action=start&currentTime=1&duration=2.json')).status, 200)
      assert.equal(cursors.size, 0, 'someone switched off in SlickSync is not tracked')

      person = { ...noah, traxAddonEnabled: true }
      assert.equal((await event('player/movie/tt0111161/action=start&currentTime=1&duration=2.json')).status, 302, 'with SlickTrax on it is not ours to answer here')
      assert.equal(cursors.size, 0)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
