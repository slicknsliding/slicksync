// An API key is found without decrypting every stored key on each request:
// made-up keys used to cost work that grew with every account.
const test = require('node:test')
const assert = require('node:assert/strict')

const { createKeyIndex, markKeysChanged } = require('../server/utils/apiKeyIndex')

function setup(rows) {
  const counts = { decrypt: 0, loadAll: 0 }
  const keys = createKeyIndex({
    loadAll: async () => { counts.loadAll++; return rows.map((r) => ({ ...r })) },
    loadOne: async (id) => rows.find((r) => r.id === id) || null,
    decryptRow: (row) => { counts.decrypt++; return row.key },
  })
  return { keys, counts }
}

test('a stored key is found, and made-up keys do not decrypt everything each time', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, key: `key-${i}` }))
  const { keys, counts } = setup(rows)
  assert.equal((await keys.lookup('key-7'))?.id, 'u7')
  const after = counts.decrypt
  for (let i = 0; i < 100; i++) assert.equal(await keys.lookup(`made-up-${i}`), null)
  assert.equal(counts.loadAll, 1, 'no rebuild for a burst of made-up keys')
  assert.equal(counts.decrypt, after, 'a made-up key decrypts nothing')
})

test('a key made a moment ago is found at once', async () => {
  const rows = [{ id: 'u1', key: 'old' }]
  const { keys } = setup(rows)
  assert.equal((await keys.lookup('old'))?.id, 'u1')
  rows.push({ id: 'u2', key: 'brand-new' })
  markKeysChanged()
  assert.equal((await keys.lookup('brand-new'))?.id, 'u2')
})

test('a key removed or rotated stops working at once', async () => {
  const rows = [{ id: 'u1', key: 'first' }]
  const { keys } = setup(rows)
  assert.equal((await keys.lookup('first'))?.id, 'u1')
  rows[0].key = 'second'
  assert.equal(await keys.lookup('first'), null)
  rows.length = 0
  assert.equal(await keys.lookup('second'), null)
})
