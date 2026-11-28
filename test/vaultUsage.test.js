'use strict'
// Where a Vault key is used: the key rotation's matching, read-only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { matchableSecret, addonIdsCarrying, usageCounts, configCarriesSecret, aioConfigsUsing } = require('../server/utils/vaultUsage')

const KEY = 'AbCdEf1234567890XyZ'
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

test('a plain key is found in an address, raw or inside a base64 config', () => {
  const addons = [
    { id: 'a', url: `https://torrentio.example/realdebrid=${KEY}/manifest.json` },
    { id: 'b', url: `https://comet.example/${b64(JSON.stringify({ debridApiKey: KEY, other: 1 }))}/manifest.json` },
    { id: 'c', url: 'https://cinemeta.example/manifest.json' },
  ]
  assert.deepEqual(addonIdsCarrying(addons, KEY), ['a', 'b'])
})

test('a secret shorter than the rotation minimum is ignored', () => {
  const addons = [{ id: 'a', url: 'https://x.example/short123/manifest.json' }]
  assert.deepEqual(addonIdsCarrying(addons, 'short123'), [])
  assert.deepEqual(addonIdsCarrying(addons, ''), [])
  assert.deepEqual(addonIdsCarrying(addons, null), [])
})

test('a Usenet provider matches on its password, not its user name', () => {
  const login = JSON.stringify({ username: 'sam-the-user', password: 'a-long-newsgroup-password' })
  assert.equal(matchableSecret('usenet_provider', login), 'a-long-newsgroup-password')
  assert.equal(matchableSecret('debrid', KEY), KEY)
  assert.equal(matchableSecret('note', 'anything at all here'), null)
  assert.equal(matchableSecret('usenet_provider', 'plain-text-secret-value'), 'plain-text-secret-value')
  assert.deepEqual(addonIdsCarrying([{ id: 'a', url: 'https://x.example/?p=a-long-newsgroup-password' }], matchableSecret('usenet_provider', login)), ['a'])
})

test('usage counts: entries used at least once, notes and unused ones left out', async () => {
  const entries = [
    { id: 'e1', category: 'debrid', encryptedSecret: `enc:${KEY}` },
    { id: 'e2', category: 'usenet_provider', encryptedSecret: `enc:${JSON.stringify({ username: 'u', password: 'a-long-newsgroup-password' })}` },
    { id: 'e3', category: 'debrid', encryptedSecret: 'enc:never-used-anywhere-key' },
    { id: 'e4', category: 'note', encryptedSecret: `enc:${KEY}` },
  ]
  const addons = [
    { id: 'a1', name: 'One', manifestUrl: `url:https://x.example/${KEY}/manifest.json` },
    { id: 'a2', name: 'Two', manifestUrl: `url:https://y.example/?k=${KEY}&p=a-long-newsgroup-password` },
  ]
  let asked = null
  const prisma = {
    vaultEntry: { findMany: async ({ where }) => { asked = where; return entries } },
    addon: { findMany: async () => addons },
  }
  const counts = await usageCounts(prisma, 'acc', {}, {
    decrypt: (v) => v.replace(/^enc:/, ''),
    getDecryptedManifestUrl: (a) => a.manifestUrl.replace(/^url:/, ''),
  })
  assert.deepEqual(counts, { e1: 2, e2: 1 })
  assert.deepEqual(asked, { accountId: 'acc' })
})

test('an AIOStreams configuration carries a key as a debrid key, IPTV password or playlist address', () => {
  assert.equal(configCarriesSecret({ services: [{ id: 'realdebrid', credentials: { apiKey: KEY } }] }, KEY), true)
  assert.equal(configCarriesSecret({ presets: [{ type: 'xtream', options: { password: KEY } }] }, KEY), true)
  assert.equal(configCarriesSecret({ presets: [{ type: 'm3u', options: { playlist: ` ${KEY} ` } }] }, KEY), true)
  assert.equal(configCarriesSecret({ services: [{ id: 'torbox', credentials: { apiKey: 'other-key-value-12345' } }] }, KEY), false)
  assert.equal(configCarriesSecret({ services: [{ credentials: { apiKey: 'short' } }] }, 'short'), false)
})

test('who carries the key: only configurations that answer in time, one entry per person', async () => {
  const people = [
    { id: 'u1', username: 'Ann', jellyfinServerUrl: 'https://aio.example/jellyfin', aioConfigId: 'cfg-1', aioConfigPassword: 'pw1' },
    { id: 'u2', username: 'Ben', jellyfinServerUrl: 'https://aio.example/jellyfin', aioConfigId: 'cfg-1', aioConfigPassword: 'pw1' },
    { id: 'u3', username: 'Cy', jellyfinServerUrl: 'https://aio.example/jellyfin', aioConfigId: 'cfg-2', aioConfigPassword: 'pw2' },
    { id: 'u4', username: 'Di', jellyfinServerUrl: 'https://aio.example/jellyfin', aioConfigId: 'cfg-3', aioConfigPassword: 'pw3' },
  ]
  let where = null
  const prisma = { user: { findMany: async (q) => { where = q.where; return people } } }
  const read = async ({ account }) => {
    if (account === 'cfg-1') return { services: [{ credentials: { apiKey: KEY } }] }
    if (account === 'cfg-2') return { services: [{ credentials: { apiKey: 'something-else-entirely' } }] }
    return new Promise(() => {}) // never answers
  }
  const found = await aioConfigsUsing(prisma, 'acc', { secret: KEY, decrypt: (v) => v, timeoutMs: 50, read })
  assert.deepEqual(found.map((p) => p.username).sort(), ['Ann', 'Ben'])
  assert.equal(where.accountId, 'acc')
})
