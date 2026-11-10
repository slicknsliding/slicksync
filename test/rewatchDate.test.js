// A later viewing of a film or episode moves its watched date forward when it
// lasted a minute or more, measured by itself - not against the old total.
const test = require('node:test')
const assert = require('node:assert/strict')
const { movesWatchedAt } = require('../server/utils/metricsProcessor')

const existing = { watchedAt: new Date('2026-09-30T21:39:39Z'), durationSeconds: 1004 }

test('a first record always takes the date', () => {
  assert.equal(movesWatchedAt(null, null, 0), true)
})

test('a 6-minute rewatch weeks later moves the date (Police Story, Nov 9)', () => {
  assert.equal(movesWatchedAt(existing, { startTime: new Date('2026-11-09T22:00:33Z') }, 344), true)
})

test('a glance weeks later does not', () => {
  assert.equal(movesWatchedAt(existing, { startTime: new Date('2026-11-09T22:00:33Z') }, 17), false)
})

test('the same viewing moves it only as its total grows by a minute', () => {
  const same = { startTime: new Date('2026-09-30T21:19:45Z') }
  assert.equal(movesWatchedAt(existing, same, 1030), false)
  assert.equal(movesWatchedAt(existing, same, 1070), true)
})

test('no session start known: the old comparison', () => {
  assert.equal(movesWatchedAt(existing, null, 344), false)
  assert.equal(movesWatchedAt(existing, {}, 1100), true)
})
