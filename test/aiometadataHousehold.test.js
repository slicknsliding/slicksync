// AIOMetadata household users (server/utils/aiometadataHousehold.js): the
// configuration's address, and the Jellyfin user id AIOMetadata gives each
// household user - which is how a profile here is matched to one there.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { configOf, userIdFor, canManage } = require('../server/utils/aiometadataHousehold')

test('the configuration and the instance, from the address people sign in to', () => {
  assert.deepEqual(configOf('https://meta.example.com/jellyfin/0f8fad5b-d9cb-469f-a165-70867728950e'), { base: 'https://meta.example.com', uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' })
  assert.deepEqual(configOf('https://example.com/aiom/jellyfin/abc/'), { base: 'https://example.com/aiom', uuid: 'abc' })
  assert.equal(configOf('https://example.com/web'), null)
})

test('a household user’s id is AIOMetadata’s own: md5 of the configuration and the user', () => {
  const uuid = '0F8FAD5B-D9CB-469F-A165-70867728950E'
  const expected = crypto.createHash('md5').update('0f8fad5bd9cb469fa16570867728950e|user|kid').digest('hex')
  assert.equal(userIdFor(uuid, 'kid'), expected)
})

test('only someone on AIOMetadata with its configuration password can be managed', () => {
  assert.equal(canManage({ providerType: 'jellyfin', jellyfinServerKind: 'aiometadata', aioConfigId: 'x', aioConfigPassword: 'enc' }), true)
  assert.equal(canManage({ providerType: 'jellyfin', jellyfinServerKind: 'aiometadata', aioConfigId: 'x' }), false)
  assert.equal(canManage({ providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', aioConfigId: 'x', aioConfigPassword: 'enc' }), false)
})
