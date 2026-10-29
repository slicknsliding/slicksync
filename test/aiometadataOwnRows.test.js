// "Their own rows": a household user's own AIOMetadata rows, as an AIOStreams
// variant that repoints the existing AIOMetadata addon at ?viewer=<name>.
const test = require('node:test')
const assert = require('node:assert/strict')

// Every request to a typed-in address goes through safeFetch; here it is the stand-in fetch.
const safeUrl = require('../server/utils/safeUrl')
safeUrl.safeFetch = (url, init) => global.fetch(url, init)

const rows = require('../server/utils/aioProfileVariants')
const { setProfileVariant } = rows
const { personaUserId } = require('../server/utils/aioHousehold')
const household = require('../server/utils/jellyfinProfiles')

const TOKEN = 'tok_0123456789abcdef'
const UUID = '0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b'
const META = 'https://meta.example.com/stremio/abc123/manifest.json'
const owner = {
  id: 'u1', username: 'Home', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams',
  jellyfinServerUrl: 'https://aio.example.com/jellyfin',
  aioConfigId: UUID, aioConfigPassword: 'enc', traxToken: TOKEN, watchStateEnabled: true,
}
const lockedOwner = { ...owner, jellyfinServerUrl: 'https://aio-locked.example.com/jellyfin' }
const kidProfile = { id: 'prof_kid', name: 'Kid', ownerUserId: 'u1', accountId: 'acc', jellyfinUserId: personaUserId(UUID, 'kid'), skip: false }
const samProfile = { id: 'prof_sam', name: 'Sam', ownerUserId: 'u1', accountId: 'acc', jellyfinUserId: personaUserId(UUID, 'sam'), skip: false }
const decrypt = () => 'pw'

function baseConfig() {
  return {
    addonName: 'Mine',
    presets: [
      { type: 'custom', instanceId: 'cin', enabled: true, options: { name: 'Cinemeta', manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json' } },
      { type: 'custom', instanceId: 'slk', enabled: true, options: { name: 'SlickTrax', manifestUrl: `https://ss.example.com/trax/${TOKEN}/aio/manifest.json` } },
      { type: 'custom', instanceId: 'aim', enabled: true, options: { name: 'AIOMetadata', manifestUrl: META } },
    ],
    variants: [{ id: 'theirs', script: 'set addonName = "x"' }],
    jellyfin: { personas: [{ id: 'sam', name: 'Sam' }, { id: 'kid', name: 'Kid', variants: ['theirs'] }] },
  }
}

// Stands in for the account's data: settings, profiles and people.
function fakePrisma({ sync = {}, profiles = [kidProfile, samProfile], owners = [owner] } = {}) {
  const state = { sync: JSON.parse(JSON.stringify(sync)), profiles }
  const prisma = {
    appAccount: {
      findUnique: async () => ({ sync: state.sync }),
      findMany: async () => [{ id: 'acc', sync: state.sync }],
      update: async ({ data }) => { state.sync = data.sync },
    },
    jellyfinProfile: {
      findMany: async ({ where = {} } = {}) => state.profiles.filter((p) => (!where.id?.in || where.id.in.includes(p.id)) && (!where.ownerUserId || p.ownerUserId === where.ownerUserId) && (where.ownUserId === undefined || (where.ownUserId === null ? !p.ownUserId : !!p.ownUserId))),
      findFirst: async ({ where }) => state.profiles.find((p) => p.id === where.id && p.accountId === where.accountId) || null,
    },
    user: {
      findFirst: async ({ where }) => owners.find((o) => o.id === where.id && (!where.accountId || o.accountId === where.accountId)) || null,
      findMany: async () => [],
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({}),
    },
  }
  return { prisma, state }
}

// Stands in for AIOStreams (the configuration) and AIOMetadata (manifest and catalogs).
function fakeWorld(config, meta = {}) {
  const w = {
    config, puts: 0, probes: [], manifestReads: 0,
    meta: { version: '3.8.3', cards: true, known: ['kid'], down: false, ...meta },
  }
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    if (u.host === 'meta.example.com') {
      if (w.meta.down) throw new Error('connection refused')
      if (u.pathname.endsWith('/manifest.json')) {
        w.manifestReads++
        return res(200, { version: w.meta.version, catalogs: [{ type: 'movie', id: 'recs' }] })
      }
      assert.match(u.pathname, /^\/stremio\/abc123\/catalog\/movie\/recs\.json$/)
      const viewer = u.searchParams.get('viewer')
      w.probes.push(viewer)
      if (!w.meta.cards) return res(200, { metas: [] })
      return w.meta.known.includes(String(viewer).toLowerCase()) ? res(200, { metas: [] }) : res(404, { error: 'Unknown viewer' })
    }
    if (u.pathname.endsWith('/api/v1/status')) return res(200, { data: { settings: { protected: !!w.protected } } })
    if ((opts.method || 'GET') === 'PUT') {
      if (w.protected) return res(403, { success: false, error: { code: 'ADDON_PASSWORD_INVALID', message: 'invalid addon password' } })
      w.puts++
      w.config = JSON.parse(opts.body).config
      return res(200, { success: true })
    }
    return res(200, { success: true, data: { userData: JSON.parse(JSON.stringify(w.config)) } })
  }
  return w
}

test.beforeEach(() => rows.forgetOwnRowsChecks())

const KID_VARIANT = 'slicksync-aiom-kid'
const variantOf = (config, id = KID_VARIANT) => (config.variants || []).find((v) => v.id === id)
const personaOf = (config, id) => config.jellyfin.personas.find((p) => p.id === id)

// --- URL building --------------------------------------------------------

test('viewer links: added, replaced, other parameters kept, name encoded', () => {
  assert.equal(rows.viewerManifestUrl(META, 'Kid'), `${META}?viewer=Kid`)
  assert.equal(rows.viewerManifestUrl(`${META}?viewer=Old`, 'Kid'), `${META}?viewer=Kid`)
  assert.equal(rows.viewerManifestUrl(`${META}?a=1&viewer=Old&b=2`, 'Kid'), `${META}?a=1&b=2&viewer=Kid`)
  assert.equal(rows.viewerManifestUrl(META, 'Zoë & Co/1'), `${META}?viewer=Zo%C3%AB%20%26%20Co%2F1`)
})

test('variant ids stay inside what AIOStreams accepts', () => {
  assert.equal(rows.aiometadataVariantId('kid'), KID_VARIANT)
  for (const id of ['a-very-long-persona-id-that-goes-on-and-on', 'Ünï cödé', '---x', '']) {
    const v = rows.aiometadataVariantId(id)
    assert.match(v, /^[a-z0-9][a-z0-9_-]{0,31}$/)
    assert.ok(v.length <= 32)
  }
  assert.notEqual(rows.aiometadataVariantId('a-very-long-persona-id-one'), rows.aiometadataVariantId('a-very-long-persona-id-two'))
  assert.equal(rows.aiometadataVariantId('a-very-long-persona-id-one'), rows.aiometadataVariantId('a-very-long-persona-id-one'))
})

// --- finding the AIOMetadata addon ----------------------------------------

test('preset detection: none, one, several, SlickTrax skipped, url field too', () => {
  assert.equal(rows.aiometadataPreset({ presets: [] }).preset, null)
  assert.equal(rows.aiometadataPreset({}).several, false)
  const one = rows.aiometadataPreset(baseConfig())
  assert.equal(one.preset.instanceId, 'aim') // the /trax/ one is not it
  assert.equal(one.several, false)

  const two = baseConfig()
  two.presets.push({ type: 'custom', instanceId: 'aim2', enabled: true, options: { manifestUrl: 'https://other.example.com/stremio/zzz/manifest.json' } })
  assert.deepEqual(rows.aiometadataPreset(two), { preset: null, several: true })
  two.presets[3].enabled = false
  assert.equal(rows.aiometadataPreset(two).preset.instanceId, 'aim')

  const urlField = { presets: [{ instanceId: 'x', options: { url: META } }] }
  assert.equal(rows.aiometadataPreset(urlField).preset.instanceId, 'x')
  assert.equal(rows.aiometadataPreset({ presets: [{ instanceId: 'c', options: { manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json' } }] }).preset, null)
})

// --- on / off --------------------------------------------------------------

test('on: adds only our variant, keeps the others, and is idempotent', async () => {
  const { prisma } = fakePrisma()
  const w = fakeWorld(baseConfig())
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  const c = w.config
  assert.equal(w.puts, 1)
  assert.deepEqual(c.presets, baseConfig().presets)
  assert.deepEqual(c.variants.map((v) => v.id), ['theirs', KID_VARIANT])
  assert.equal(variantOf(c).script, `set presets[instanceId=aim].options.manifestUrl = "${META}?viewer=Kid"`)
  assert.deepEqual(personaOf(c, 'kid').variants, ['theirs', KID_VARIANT])
  assert.equal(personaOf(c, 'sam').variants, undefined)

  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  assert.equal(w.puts, 1)
})

test('on: the script follows the field the preset uses, replaces a viewer already in the link', async () => {
  const cfg = baseConfig()
  const aim = cfg.presets[2]
  delete aim.options.manifestUrl
  aim.options.url = `${META}?viewer=Someone`
  const w = fakeWorld(cfg)
  await rows.setOwnRowsVariant(fakePrisma().prisma, decrypt, owner, kidProfile, true)
  assert.equal(variantOf(w.config).script, `set presets[instanceId=aim].options.url = "${META}?viewer=Kid"`)
})

test('off: removes only ours', async () => {
  const { prisma } = fakePrisma()
  const w = fakeWorld(baseConfig())
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, false)
  assert.deepEqual(w.config, baseConfig())
  const puts = w.puts
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, false) // nothing to remove: nothing written
  assert.equal(w.puts, puts)
})

test('coexists with the SlickTrax collections variant on the same persona', async () => {
  const { prisma } = fakePrisma()
  const w = fakeWorld(baseConfig())
  await setProfileVariant(prisma, decrypt, owner, kidProfile, true)
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  assert.deepEqual(w.config.variants.map((v) => v.id), ['theirs', 'slicksync-kid', KID_VARIANT])
  assert.deepEqual(personaOf(w.config, 'kid').variants, ['theirs', 'slicksync-kid', KID_VARIANT])

  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, false)
  assert.deepEqual(w.config.variants.map((v) => v.id), ['theirs', 'slicksync-kid'])
  await setProfileVariant(prisma, decrypt, owner, kidProfile, false)
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  await setProfileVariant(prisma, decrypt, owner, kidProfile, false)
  assert.deepEqual(w.config.variants.map((v) => v.id), ['theirs', KID_VARIANT])
})

test('refuses clearly when it cannot be done, writing nothing', async () => {
  const { prisma } = fakePrisma()
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, { ...owner, aioConfigPassword: null }, kidProfile, true), /configuration password/)

  const none = baseConfig()
  none.presets = none.presets.filter((p) => p.instanceId !== 'aim')
  let w = fakeWorld(none)
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true), /isn’t in this AIOStreams/)
  assert.equal(w.puts, 0)

  const several = baseConfig()
  several.presets.push({ type: 'custom', instanceId: 'aim2', enabled: true, options: { manifestUrl: 'https://other.example.com/stremio/zzz/manifest.json' } })
  w = fakeWorld(several)
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true), /more than one AIOMetadata/)
  assert.equal(w.puts, 0)

  w = fakeWorld(baseConfig())
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, { ...kidProfile, jellyfinUserId: 'nobody' }, true), /isn't a household user/)
  assert.equal(w.puts, 0)
})

test('a persona is found by id, so a renamed one still matches', async () => {
  const cfg = baseConfig()
  personaOf(cfg, 'kid').name = 'Kiddo'
  const w = fakeWorld(cfg, { known: ['kiddo'] })
  await rows.setOwnRowsVariant(fakePrisma().prisma, decrypt, owner, { ...kidProfile, name: 'Kid' }, true)
  assert.match(variantOf(w.config).script, /viewer=Kiddo"$/)
})

// --- does this AIOMetadata do it? -----------------------------------------

test('gating: a version past 3.8.3 writes, an older one does not, a 404 probe counts', async () => {
  const { prisma } = fakePrisma()
  // Newer version: supported without asking for a catalog of a made-up viewer.
  let w = fakeWorld(baseConfig(), { version: '3.9.0', cards: false })
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  assert.equal(w.puts, 1)
  assert.ok(!w.probes.some((p) => p.startsWith('slicksync-probe-')))

  // 3.8.3 and nothing configured for viewers: a 200 proves nothing, so no.
  rows.forgetOwnRowsChecks()
  w = fakeWorld(baseConfig(), { version: '3.8.3', cards: false })
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true), /next release/)
  assert.equal(w.puts, 0)
  assert.ok(w.probes.some((p) => p.startsWith('slicksync-probe-')))

  // Older still, but the development build answers viewers with a 404 for an unknown one.
  rows.forgetOwnRowsChecks()
  w = fakeWorld(baseConfig(), { version: '3.8.3', cards: true })
  await rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true)
  assert.equal(w.puts, 1)
  assert.equal(await rows.aiometadataSupport(META), true)

  // Cannot be reached: not supported as far as anyone can tell, nothing written.
  rows.forgetOwnRowsChecks()
  w = fakeWorld(baseConfig(), { down: true })
  assert.equal(await rows.aiometadataSupport(META), null)
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, kidProfile, true), /Couldn’t reach AIOMetadata/)
  assert.equal(w.puts, 0)
})

test('support answers are remembered, not asked for again', async () => {
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.aiometadataSupport(META)
  await rows.aiometadataSupport(META)
  assert.equal(w.manifestReads, 1)
})

test('name check: a viewer AIOMetadata does not know is not written', async () => {
  const { prisma } = fakePrisma()
  const w = fakeWorld(baseConfig(), { version: '3.9.0', known: ['kid'] })
  assert.equal(await rows.aiometadataNameKnown(META, 'Kid'), true)
  assert.equal(await rows.aiometadataNameKnown(META, 'Sam'), false)
  await assert.rejects(rows.setOwnRowsVariant(prisma, decrypt, owner, samProfile, true), /doesn’t know “Sam” yet. Add Sam under Also known as/)
  assert.equal(w.puts, 0)
  assert.ok(w.probes.includes('Sam'))
})

// --- the household card ----------------------------------------------------

test('household card: ownRows per profile, and left out when it cannot apply', async () => {
  const { prisma } = fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } } })
  let w = fakeWorld(baseConfig(), { version: '3.9.0', known: ['kid'] })
  let list = await household.describeHousehold(prisma, 'u1', { decrypt })
  assert.deepEqual(list.find((p) => p.id === 'prof_kid').ownRows, { available: true, on: true })
  assert.deepEqual(list.find((p) => p.id === 'prof_sam').ownRows, { available: false, on: false, reason: 'needs-name' })

  // Without `decrypt` (nothing to read the configuration with) there is no ownRows at all.
  list = await household.describeHousehold(prisma, 'u1')
  assert.ok(list.every((p) => p.ownRows === undefined))

  // No stored configuration password.
  rows.forgetOwnRowsChecks()
  const noPw = fakePrisma({ owners: [{ ...owner, aioConfigPassword: null }] })
  list = await household.describeHousehold(noPw.prisma, 'u1', { decrypt })
  assert.ok(list.every((p) => p.ownRows === undefined))

  // No AIOMetadata in it.
  rows.forgetOwnRowsChecks()
  const none = baseConfig()
  none.presets = none.presets.filter((p) => p.instanceId !== 'aim')
  w = fakeWorld(none)
  list = await household.describeHousehold(prisma, 'u1', { decrypt })
  assert.ok(list.every((p) => p.ownRows === undefined))

  // One that does not support it.
  rows.forgetOwnRowsChecks()
  w = fakeWorld(baseConfig(), { version: '3.8.3', cards: false })
  list = await household.describeHousehold(prisma, 'u1', { decrypt })
  assert.ok(list.every((p) => p.ownRows === undefined))

  // Two of them.
  rows.forgetOwnRowsChecks()
  const several = baseConfig()
  several.presets.push({ type: 'custom', instanceId: 'aim2', enabled: true, options: { manifestUrl: 'https://other.example.com/stremio/zzz/manifest.json' } })
  w = fakeWorld(several)
  list = await household.describeHousehold(prisma, 'u1', { decrypt })
  assert.deepEqual(list.find((p) => p.id === 'prof_kid').ownRows, { available: false, on: true, reason: 'several' })

  // A protected AIOStreams (remembered per address for a while, so its own).
  rows.forgetOwnRowsChecks()
  w = fakeWorld(baseConfig(), { version: '3.9.0' })
  w.protected = true
  list = await household.describeHousehold(fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } }, owners: [lockedOwner] }).prisma, 'u1', { decrypt })
  assert.deepEqual(list.find((p) => p.id === 'prof_kid').ownRows, { available: false, on: true, reason: 'protected' })
})

// --- the 30-minute check ---------------------------------------------------

test('healer: re-asserts a drifted variant, writes nothing when it is right', async () => {
  const { prisma } = fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } } })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(w.puts, 1)
  assert.match(variantOf(w.config).script, /viewer=Kid"$/)
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(w.puts, 1)

  // The addon moved: the variant follows it.
  const aim = w.config.presets.find((p) => p.instanceId === 'aim')
  aim.options.manifestUrl = 'https://meta.example.com/stremio/abc123/manifest.json?token=1'
  rows.forgetOwnRowsChecks()
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(w.puts, 2)
  assert.match(variantOf(w.config).script, /\?token=1&viewer=Kid"$/)

  // Someone deleted the variant in AIOStreams: it comes back.
  w.config.variants = w.config.variants.filter((v) => v.id !== KID_VARIANT)
  delete personaOf(w.config, 'kid').variants
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))
  assert.ok(personaOf(w.config, 'kid').variants.includes(KID_VARIANT))
})

test('healer: removes the variant when it can no longer work, keeps the choice', async () => {
  const { prisma, state } = fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } } })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))

  // AIOMetadata no longer knows the name.
  w.meta.known = []
  rows.forgetOwnRowsChecks()
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(variantOf(w.config), undefined)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)

  // Known again: it is put back.
  w.meta.known = ['kid']
  rows.forgetOwnRowsChecks()
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))

  // The AIOMetadata addon is gone from the configuration.
  w.config.presets = w.config.presets.filter((p) => p.instanceId !== 'aim')
  rows.forgetOwnRowsChecks()
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(variantOf(w.config), undefined)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)
})

test('healer: AIOMetadata not answering changes nothing', async () => {
  const { prisma } = fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } } })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healOwnRows(prisma, decrypt)
  const puts = w.puts
  w.meta.down = true
  rows.forgetOwnRowsChecks()
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(w.puts, puts)
  assert.ok(variantOf(w.config))
})

test('healer: an untracked profile loses the variant, a deleted one loses the choice', async () => {
  const sync = { aioAiometadataOwn: { prof_kid: true, prof_gone: true } }
  const { prisma, state } = fakePrisma({ sync })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))
  assert.equal(state.sync.aioAiometadataOwn.prof_gone, undefined)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)

  state.profiles = [{ ...kidProfile, skip: true }, samProfile]
  await rows.healOwnRows(prisma, decrypt)
  assert.equal(variantOf(w.config), undefined)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)

  // Tracked again: back.
  state.profiles = [kidProfile, samProfile]
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))
})

test('a deleted owner: their household loses its rows in AIOStreams, and the choices go', async () => {
  const sync = { aioAiometadataOwn: { prof_kid: true } }
  const { prisma, state } = fakePrisma({ sync })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healOwnRows(prisma, decrypt)
  assert.ok(variantOf(w.config))
  await rows.forgetOwnRows(prisma, decrypt, 'u1')
  assert.equal(variantOf(w.config), undefined)
  assert.ok(!(personaOf(w.config, 'kid').variants || []).includes(KID_VARIANT))
  assert.equal(state.sync.aioAiometadataOwn?.prof_kid, undefined)
  // Never throws, even with AIOStreams out of reach.
  global.fetch = async () => { throw new Error('connection refused') }
  await rows.forgetOwnRows(prisma, decrypt, 'u1')
})

test('the 30-minute profile check (healProfileVariants) also looks after these', async () => {
  const { prisma } = fakePrisma({ sync: { aioAiometadataOwn: { prof_kid: true } } })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  await rows.healProfileVariants(prisma, decrypt)
  assert.ok(variantOf(w.config))
})

// --- the route -------------------------------------------------------------

function ownRowsHandler(prisma, accountOf) {
  const router = require('../server/routes/jellyfin')({ prisma, getAccountId: (req) => accountOf(req), encrypt: (v) => v, decrypt })
  const layer = router.stack.find((l) => l.route?.path === '/household/:profileId/own-rows' && l.route.methods.put)
  assert.ok(layer, 'PUT /household/:profileId/own-rows is routed')
  return layer.route.stack[0].handle
}

async function call(handler, req) {
  const out = { status: 200, body: null }
  const res = { status(code) { out.status = code; return res }, json(body) { out.body = body; return res } }
  await handler(req, res)
  return out
}

test('route: keeps the choice when the write fails', async () => {
  const { prisma, state } = fakePrisma({ owners: [lockedOwner] })
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  w.protected = true
  const handler = ownRowsHandler(prisma, (req) => req.accountId)
  const out = await call(handler, { accountId: 'acc', params: { profileId: 'prof_kid' }, body: { enabled: true } })
  assert.equal(out.status, 200)
  assert.equal(out.body.success, false)
  assert.match(out.body.error, /only saves changes made while signed in on its own page/)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)
  assert.deepEqual(out.body.profiles.find((p) => p.id === 'prof_kid').ownRows, { available: false, on: true, reason: 'protected' })
  assert.equal(variantOf(w.config), undefined)
})

test('route: on writes the variant and returns the household, off takes it away', async () => {
  const { prisma, state } = fakePrisma()
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  const handler = ownRowsHandler(prisma, (req) => req.accountId)
  const put = (enabled) => call(handler, { accountId: 'acc', params: { profileId: 'prof_kid' }, body: { enabled } })

  let out = await put(true)
  assert.equal(out.body.error, undefined)
  assert.equal(out.body.success, true)
  assert.ok(variantOf(w.config))
  assert.deepEqual(out.body.profiles.find((p) => p.id === 'prof_kid').ownRows, { available: true, on: true })

  out = await put(false)
  assert.equal(variantOf(w.config), undefined)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, undefined)
  assert.deepEqual(out.body.profiles.find((p) => p.id === 'prof_kid').ownRows, { available: true, on: false })

  // AIOMetadata doesn’t know them: nothing is written, but the choice is kept.
  w.meta.known = []
  rows.forgetOwnRowsChecks()
  out = await put(true)
  assert.match(out.body.error, /doesn’t know “Kid” yet/)
  assert.equal(state.sync.aioAiometadataOwn.prof_kid, true)
  assert.equal(variantOf(w.config), undefined)
})

test('route: scoped to the account - another account\'s profile is not found and nothing changes', async () => {
  const { prisma, state } = fakePrisma()
  const w = fakeWorld(baseConfig(), { version: '3.9.0' })
  const handler = ownRowsHandler(prisma, (req) => req.accountId)
  const out = await call(handler, { accountId: 'someone-else', params: { profileId: 'prof_kid' }, body: { enabled: true } })
  assert.equal(out.status, 404)
  assert.equal(w.puts, 0)
  assert.equal(state.sync.aioAiometadataOwn, undefined)
})

test('the choice is kept per account in sync.aioAiometadataOwn, absent meaning off', async () => {
  const { prisma, state } = fakePrisma({ sync: { other: 1 } })
  assert.deepEqual(await rows.ownRowsChoices(prisma, 'acc'), {})
  await rows.saveOwnRowsChoice(prisma, 'acc', 'prof_kid', true)
  assert.deepEqual(state.sync, { other: 1, aioAiometadataOwn: { prof_kid: true } })
  await rows.saveOwnRowsChoice(prisma, 'acc', 'prof_kid', false)
  assert.deepEqual(state.sync, { other: 1, aioAiometadataOwn: {} })
})
