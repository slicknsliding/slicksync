const test = require('node:test')
const assert = require('node:assert/strict')
const { setProfileVariant, variantIdFor, profileManifestUrl } = require('../server/utils/aioProfileVariants')

const TOKEN = 'tok_0123456789abcdef'
const owner = {
  id: 'u1', username: 'Home', accountId: 'acc', jellyfinServerUrl: 'https://aio.example.com/jellyfin',
  aioConfigId: '0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b', aioConfigPassword: 'enc', traxToken: TOKEN, watchStateEnabled: true,
}
const kid = { id: 'prof_kid', name: 'Kid' }
const decrypt = () => 'pw'
const prisma = { user: { updateMany: async () => ({}) } }

function baseConfig() {
  return {
    addonName: 'Mine',
    presets: [
      { type: 'custom', instanceId: 'cin', enabled: true, options: { name: 'Cinemeta', manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json' } },
      { type: 'custom', instanceId: 'slk', enabled: true, options: { name: 'SlickTrax', manifestUrl: `https://ss.example.com/trax/${TOKEN}/aio/manifest.json` } },
    ],
    variants: [{ id: 'theirs', script: 'set addonName = "x"' }],
    jellyfin: { personas: [{ id: 'sam', name: 'Sam' }, { id: 'kid', name: 'Kid', variants: ['theirs'] }] },
  }
}

// Stands in for AIOStreams: GET returns the stored configuration, PUT replaces it.
function fakeAioStreams(config) {
  const state = { config, puts: 0 }
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      state.puts++
      state.config = JSON.parse(opts.body).config
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { userData: JSON.parse(JSON.stringify(state.config)) } }) }
  }
  return state
}

test('variant ids stay inside what AIOStreams accepts', () => {
  assert.equal(variantIdFor('kid'), 'slicksync-kid')
  assert.ok(variantIdFor('a-very-long-persona-id-that-goes-on').length <= 32)
  assert.equal(profileManifestUrl(`https://ss.example.com/base/trax/${TOKEN}/aio/manifest.json`, TOKEN, 'p1'), `https://ss.example.com/base/trax/${TOKEN}/aio/p/p1/manifest.json`)
})

test('on: adds only SlickSync\'s variant to that profile, everything else as it was', async () => {
  const aio = fakeAioStreams(baseConfig())
  await setProfileVariant(prisma, decrypt, owner, kid, true)
  const c = aio.config
  assert.equal(aio.puts, 1)
  assert.deepEqual(c.presets, baseConfig().presets)
  assert.equal(c.addonName, 'Mine')
  assert.deepEqual(c.variants.map((v) => v.id), ['theirs', 'slicksync-kid'])
  assert.match(c.variants[1].script, new RegExp(`^set presets\\[instanceId=slk\\]\\.options\\.manifestUrl = "https://ss\\.example\\.com/trax/${TOKEN}/aio/p/prof_kid/manifest\\.json"$`))
  assert.deepEqual(c.jellyfin.personas.find((p) => p.id === 'kid').variants, ['theirs', 'slicksync-kid'])
  assert.equal(c.jellyfin.personas.find((p) => p.id === 'sam').variants, undefined)

  // Already set up: nothing written again.
  await setProfileVariant(prisma, decrypt, owner, kid, true)
  assert.equal(aio.puts, 1)
})

test('off: removes only SlickSync\'s variant', async () => {
  const aio = fakeAioStreams(baseConfig())
  await setProfileVariant(prisma, decrypt, owner, kid, true)
  await setProfileVariant(prisma, decrypt, owner, kid, false)
  assert.deepEqual(aio.config, baseConfig())
})

test('refuses clearly when it cannot be done', async () => {
  fakeAioStreams(baseConfig())
  await assert.rejects(setProfileVariant(prisma, decrypt, { ...owner, aioConfigPassword: null }, kid, true), /configuration password/)
  await assert.rejects(setProfileVariant(prisma, decrypt, owner, { id: 'p', name: 'Nobody' }, true), /isn't a household user/)
  const noLink = baseConfig()
  noLink.presets = noLink.presets.filter((p) => p.instanceId !== 'slk')
  fakeAioStreams(noLink)
  await assert.rejects(setProfileVariant(prisma, decrypt, owner, kid, true), /watch history link isn't in/)
})
