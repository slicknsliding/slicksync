// A person's Home names their titles even before the Library page has warmed
// the library cache (server/utils/portalActivityMetadata.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { portalActivityMetadata } = require('../server/utils/portalActivityMetadata')

test('a cold Home looks titles up instead of showing their ids', async () => {
  const calls = []
  const map = await portalActivityMetadata([], [{ itemId: 'tt2661044:1:2', itemType: 'series', watchTimeSeconds: 300 }], async (id, type) => {
    calls.push([id, type])
    return { title: 'Northern Lines', poster: 'https://example.invalid/poster.jpg' }
  })
  assert.deepEqual(calls, [['tt2661044', 'series']])
  assert.equal(map.get('tt2661044:1:2').name, 'Northern Lines')
  assert.equal(map.get('tt2661044').poster, 'https://example.invalid/poster.jpg')
})

test('known titles are reused, and a failed lookup leaves the title out', async () => {
  const map = await portalActivityMetadata([{ _id: 'tt1', name: 'Known film', poster: 'poster.jpg' }], [
    { itemId: 'tt1', itemType: 'movie' }, { itemId: 'tt2', itemType: 'movie' },
  ], async (id) => { assert.equal(id, 'tt2'); throw new Error('offline') })
  assert.equal(map.get('tt1').name, 'Known film')
  assert.equal(map.get('tt2'), undefined)
})

test('lookups are bounded and start with the most-watched title', async () => {
  const calls = []
  const activities = Array.from({ length: 30 }, (_, i) => ({ itemId: `tt${1000 + i}`, itemType: 'movie', watchTimeSeconds: i }))
  await portalActivityMetadata([], activities, async (id) => { calls.push(id); return { title: id } })
  assert.equal(calls.length, 12)
  assert.equal(calls[0], 'tt1029')
})
