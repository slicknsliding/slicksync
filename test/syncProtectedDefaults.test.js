// Cinemeta and Local Files stay on an account through a sync even when their
// name isn't the stock English one - they're known by id and address too.
const test = require('node:test')
const assert = require('node:assert/strict')

async function desired(userAddons, { unsafeMode = false } = {}) {
  const helpers = require('../server/utils/helpers')
  const { getDesiredAddons } = require('../server/utils/sync')
  const original = helpers.getGroupAddons
  helpers.getGroupAddons = async () => [
    { id: 'a1', transportUrl: 'https://catalogs.example.com/manifest.json', transportName: 'Catalogs', manifest: { id: 'example.catalogs', name: 'Catalogs', resources: ['catalog'] } },
  ]
  try {
    const deps = {
      prisma: { group: { findMany: async () => [{ id: 'g1' }] }, appAccount: { findUnique: async () => ({ sync: '{}' }) } },
      getAccountId: () => 'acc', decrypt: (x) => x, parseAddonIds: () => [], parseProtectedAddons: () => [], canonicalizeManifestUrl: (u) => u,
      _prefetchedUserAddons: userAddons, unsafeMode,
    }
    const r = await getDesiredAddons({ id: 'mia', excludedAddons: null, protectedAddons: null }, {}, deps)
    return r.addons.map((a) => a.manifest?.name || a.transportName)
  } finally {
    helpers.getGroupAddons = original
  }
}

const renamedCinemeta = { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', transportName: '', manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta (FR)' } }
const localFilesByUrl = { transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', transportName: '', manifest: { id: 'local.other', name: 'Fichiers locaux' } }
const random = { transportUrl: 'https://random.example.com/manifest.json', transportName: '', manifest: { id: 'example.random', name: 'Random' } }

test('a renamed Cinemeta is kept by its id, Local Files by its address', async () => {
  const names = await desired([renamedCinemeta, random, localFilesByUrl])
  assert.ok(names.includes('Cinemeta (FR)'))
  assert.ok(names.includes('Fichiers locaux'))
  assert.ok(names.includes('Catalogs'))
  assert.ok(!names.includes('Random'), 'an ordinary addon outside the group still goes')
})

test('kept addons stay where they were on the account', async () => {
  const names = await desired([renamedCinemeta, random])
  assert.equal(names[0], 'Cinemeta (FR)')
})

test('unsafe mode protects nothing by default, as before', async () => {
  const names = await desired([renamedCinemeta, random])
  assert.ok(names.includes('Cinemeta (FR)'))
  const unsafe = await desired([renamedCinemeta, random], { unsafeMode: true })
  assert.ok(!unsafe.includes('Cinemeta (FR)'))
})
