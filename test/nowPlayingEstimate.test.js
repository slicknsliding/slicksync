// Now Playing estimates (server/utils/nowPlayingEstimate.js): runtime and the
// episode's name from metadata, a position estimated from when the stream
// started - and never over a real position or length.
const test = require('node:test')
const assert = require('node:assert/strict')
const est = require('../server/utils/nowPlayingEstimate')

const MIN = 60000
const meta = (runtime, episodeTitle) => async () => ({ runtime, episode: episodeTitle ? { title: episodeTitle } : undefined })
const settle = () => new Promise((r) => setTimeout(r, 5))
const row = (extra = {}) => ({ item: { id: 'tt0000001', type: 'movie', name: 'Sample' }, lastPosition: null, totalDuration: null, ...extra })

test('the first build only starts the lookup; the next one has the runtime', async () => {
  est._forget()
  const now = 1_000_000_000
  const fetch = meta('100 min')
  const first = est.addEstimate(row(), now - 30 * MIN, now, fetch)
  assert.equal(first.totalDuration, null, 'nothing yet: Now Playing never waits for a lookup')
  await settle()
  const second = est.addEstimate(row(), now - 30 * MIN, now, fetch)
  assert.equal(second.totalDuration, 100 * MIN)
  assert.equal(second.lastPosition, 30 * MIN)
  assert.equal(second.positionAt, now)
  assert.equal(second.positionEstimated, true)
  assert.equal(second.durationEstimated, true)
})

test('prepared first, a title just started has its bar on the very first build', async () => {
  est._forget()
  const now = 1_000_000_000
  const fetch = async () => { await new Promise((r) => setTimeout(r, 30)); return { runtime: '100 min' } }
  const rows = [row()]
  await est.prepareEstimates(rows, 1000, fetch)
  const first = est.addEstimate(rows[0], now - 30 * MIN, now, fetch)
  assert.equal(first.totalDuration, 100 * MIN)
  assert.equal(first.positionEstimated, true)
})

test('a slow lookup holds Now Playing up for the wait at most, and still lands for the next build', async () => {
  est._forget()
  const now = 1_000_000_000
  const fetch = async () => { await new Promise((r) => setTimeout(r, 300)); return { runtime: '100 min' } }
  const started = Date.now()
  await est.prepareEstimates([row()], 50, fetch)
  assert.ok(Date.now() - started < 250, 'waited no longer than asked')
  assert.equal(est.addEstimate(row(), now - 30 * MIN, now, fetch).totalDuration, null)
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(est.addEstimate(row(), now - 30 * MIN, now, fetch).totalDuration, 100 * MIN)
})

test('a real position and length always win', async () => {
  est._forget()
  const now = 2_000_000_000
  const fetch = meta('100 min')
  est.addEstimate(row(), now, now, fetch); await settle()
  const r = est.addEstimate(row({ lastPosition: 5 * MIN, totalDuration: 42 * MIN }), now - 60 * MIN, now, fetch)
  assert.equal(r.totalDuration, 42 * MIN)
  assert.equal(r.lastPosition, 5 * MIN)
  assert.equal(r.positionEstimated, undefined)
  assert.equal(r.durationEstimated, undefined)
})

test('a real position without a length gets only the length', async () => {
  est._forget()
  const now = 3_000_000_000
  const fetch = meta('1h 30min')
  est.addEstimate(row(), now, now, fetch); await settle()
  const r = est.addEstimate(row({ lastPosition: 20 * MIN }), now - 60 * MIN, now, fetch)
  assert.equal(r.totalDuration, 90 * MIN)
  assert.equal(r.lastPosition, 20 * MIN)
  assert.equal(r.durationEstimated, true)
  assert.equal(r.positionEstimated, undefined)
})

test('no estimate past the end, while paused, or for a title still being identified', async () => {
  est._forget()
  const now = 4_000_000_000
  const fetch = meta('60 min')
  est.addEstimate(row(), now, now, fetch); await settle()
  assert.equal(est.addEstimate(row(), now - 59 * MIN, now, fetch).totalDuration, null, 'past 97% of the runtime')
  assert.equal(est.addEstimate(row({ paused: true }), now - 10 * MIN, now, fetch).totalDuration, null)
  const pending = row(); pending.item.titlePending = true
  assert.equal(est.addEstimate(pending, now - 10 * MIN, now, fetch).totalDuration, null)
})

test('an episode gets its name; a title with no runtime gets no estimate', async () => {
  est._forget()
  const now = 5_000_000_000
  const ep = () => ({ item: { id: 'tt0000002', type: 'series', name: 'Show', season: 3, episode: 5 }, videoId: 'tt0000002:3:5', lastPosition: null, totalDuration: null })
  const fetch = meta(null, 'The Long Night')
  est.addEstimate(ep(), now, now, fetch); await settle()
  const r = est.addEstimate(ep(), now - 10 * MIN, now, fetch)
  assert.equal(r.item.episodeTitle, 'The Long Night')
  assert.equal(r.totalDuration, null)
})

test('a failed lookup leaves the row as it was', async () => {
  est._forget()
  const now = 6_000_000_000
  const fetch = async () => { throw new Error('offline') }
  est.addEstimate(row(), now, now, fetch); await settle()
  const r = est.addEstimate(row(), now - 10 * MIN, now, fetch)
  assert.equal(r.totalDuration, null)
  assert.equal(r.lastPosition, null)
})
