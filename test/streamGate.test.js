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
function fakeAccount(cfg) {
  const updates = []
  const prisma = {
    appAccount: { findUnique: async () => ({ sync: JSON.stringify(cfg()) }) },
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
  cfg = { screenTime: { mia: { minutes: 90, days: [], onReach: 'pause' } } }
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
