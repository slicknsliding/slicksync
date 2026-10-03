const test = require('node:test')
const assert = require('node:assert/strict')
const { orderedTraxRows, traxPathVersion, TRAX_MANIFEST_VERSION } = require('../server/routes/traxAddon')

const lists = [{ id: 'a', name: 'Kids picks' }, { id: 'b', name: 'Horror Night' }]

test('rows: with nothing chosen, everyone gets every row in the usual order', () => {
  const rows = orderedTraxRows(lists, null)
  assert.deepEqual(rows.map((r) => r.key), ['continue', 'watchlist', 'list:a', 'list:b'])
  assert.ok(rows.every((r) => !r.hidden))
})

test('rows: a chosen order comes first, rows nobody placed yet follow, hidden ones are marked', () => {
  const json = JSON.stringify({ order: ['list:a', 'continue'], hidden: ['list:b'] })
  const rows = orderedTraxRows(lists, json)
  assert.deepEqual(rows.map((r) => r.key), ['list:a', 'continue', 'watchlist', 'list:b'])
  assert.deepEqual(rows.filter((r) => r.hidden).map((r) => r.key), ['list:b'])
})

test('rows: a catalog that no longer exists is dropped from the order', () => {
  const rows = orderedTraxRows(lists, JSON.stringify({ order: ['list:gone', 'watchlist'], hidden: [] }))
  assert.deepEqual(rows.map((r) => r.key), ['watchlist', 'continue', 'list:a', 'list:b'])
})

test('address: unchanged without a choice, and different for each choice', () => {
  assert.equal(traxPathVersion({ traxRowsJson: null }), TRAX_MANIFEST_VERSION)
  const a = traxPathVersion({ traxRowsJson: JSON.stringify({ order: [], hidden: ['list:b'] }) })
  const b = traxPathVersion({ traxRowsJson: JSON.stringify({ order: [], hidden: ['list:a'] }) })
  assert.notEqual(a, b)
  assert.match(a, new RegExp(`^${TRAX_MANIFEST_VERSION.replace(/\./g, '\\.')}r[0-9a-f]{6}$`))
  // The path shim strips any version segment of this shape.
  assert.equal(`/tok/v${a}/manifest.json`.replace(/^\/([^/]+)\/v[0-9][\w.]*\//, '/$1/'), '/tok/manifest.json')
})
