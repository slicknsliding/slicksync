// A proxy connection counts as playing from its second request
// (server/utils/proxyPlaying.js). The numbers below are from a real record:
// three sources of one episode opened within 2ms by an app warming them up,
// one request each, beside real viewings of 2 to 1,144 requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MIN_PLAYING_REQUESTS, isPlayingConnection } = require('../server/utils/proxyPlaying')

test('a source warmed up or checked - one request - is not a viewing', () => {
  for (const warmUp of [1, 1, 1]) assert.equal(isPlayingConnection(warmUp), false)
  assert.equal(isPlayingConnection(0), false)
  assert.equal(isPlayingConnection(undefined), false)
})

test('every real viewing in the record counts', () => {
  for (const real of [2, 4, 6, 97, 100, 596, 834, 1144]) assert.equal(isPlayingConnection(real), true, `${real} requests`)
  assert.equal(MIN_PLAYING_REQUESTS, 2)
})

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

test('the "started watching" notification waits for a playing connection', () => {
  const src = read('server/utils/proxyStreamMonitor.js')
  assert.match(src, /const playingNow = isPlayingConnection\(stream\.requests \?\? 1\)/)
  assert.match(src, /if \(notifyActivity && playingNow && !wasPlaying && \(!existingRow \|\| existingRow\.isActive\)\)/)
})

test('Now Playing and the sync-mismatch warning only read playing connections', () => {
  const now = read('server/utils/proxyNowPlaying.js')
  assert.equal((now.match(/requestCount: \{ gte: MIN_PLAYING_REQUESTS \}/g) || []).length, 2, 'both the live and the recently-closed query')
  assert.match(read('server/utils/watchSyncMismatch.js'), /requestCount: \{ gte: MIN_PLAYING_REQUESTS \}/)
})
