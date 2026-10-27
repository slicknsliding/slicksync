// Now Playing: a card only Nuvio's own saves stand behind shows for 5
// minutes after that save, and only the newest per person
// (server/utils/metricsBuilder.js nuvioOnlyCards).
const test = require('node:test')
const assert = require('node:assert/strict')
const { nuvioOnlyCards } = require('../server/utils/metricsBuilder')

const now = Date.parse('2026-10-27T20:00:00Z')
const card = (user, title, minutesAgo, extra = {}) => ({ user: { id: user }, item: { name: title }, nuvioSavedAt: now - minutesAgo * 60000, ...extra })

test('a Nuvio save shows for 5 minutes, then the card goes', () => {
  assert.equal(nuvioOnlyCards([card('a', 'Film', 4)], now).length, 1)
  assert.equal(nuvioOnlyCards([card('a', 'Film', 5)], now).length, 0)
  assert.equal(nuvioOnlyCards([card('a', 'Film', 18)], now).length, 0)
})

test('starting something else replaces the older card', () => {
  const shown = nuvioOnlyCards([card('a', 'First', 3), card('a', 'Second', 1), card('b', 'Other', 2)], now)
  assert.deepEqual(shown.map((r) => r.item.name).sort(), ['Other', 'Second'])
})

test('cards with a live signal are never touched', () => {
  const live = { user: { id: 'a' }, item: { name: 'Proxy stream' }, source: 'aiostreams-proxy' }
  const jelly = { user: { id: 'c' }, item: { name: 'Jellyfin' }, source: 'jellyfin' }
  assert.equal(nuvioOnlyCards([live, jelly, card('a', 'Old', 30)], now).length, 2)
})
