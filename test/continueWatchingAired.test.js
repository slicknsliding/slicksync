// Continue Watching only offers a next episode that is out
// (server/utils/continueWatching.js hasAired).
const test = require('node:test')
const assert = require('node:assert/strict')
const { hasAired } = require('../server/utils/continueWatching')

test('an episode airing later is held back; aired or undated ones are offered', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  assert.equal(hasAired({ released: '2026-10-29T00:00:00.000Z' }, now), false)
  assert.equal(hasAired({ released: '2026-10-20T00:00:00.000Z' }, now), true)
  assert.equal(hasAired({ released: '2026-10-27T12:00:00.000Z' }, now), true)
  assert.equal(hasAired({ released: null }, now), true)
  assert.equal(hasAired({}, now), true)
  assert.equal(hasAired({ released: 'not a date' }, now), true)
})
