// A proxy connection counts as playing once data has kept flowing through it
// for 45 seconds, or once it has made 20 requests (server/utils/proxyPlaying.js).
// The numbers below are from a real household's record: warm-ups Nuvio made
// while a title's page was open, beside real viewings.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MIN_PLAYING_SECONDS, MANY_REQUESTS, isPlayingConnection } = require('../server/utils/proxyPlaying')

const T0 = Date.parse('2026-10-05T00:57:24Z')
// A connection that carried data for `seconds`, over `requests` requests.
const conn = (seconds, requests) => ({ requestCount: requests, startTime: new Date(T0), lastSeenAt: new Date(T0 + seconds * 1000) })

test('warm-ups are not viewings - including the two-request ones that fooled Now Playing', () => {
  // Stranger Things, opened in Nuvio: four sources warmed up.
  for (const [s, r] of [[0, 1], [0, 1], [2, 2], [3, 2]]) assert.equal(isPlayingConnection(conn(s, r)), false, `${s}s / ${r} requests`)
  // Nuvio's longest warm-ups carried data for about 20 seconds.
  for (const [s, r] of [[20, 1], [10, 2], [17, 3], [5, 3]]) assert.equal(isPlayingConnection(conn(s, r)), false, `${s}s / ${r} requests`)
})

test('real viewings count, however few requests they made', () => {
  for (const [s, r] of [[3394, 3], [879, 4], [613, 1150], [485, 1192], [461, 1213], [88, 3], [65, 2]]) {
    assert.equal(isPlayingConnection(conn(s, r)), true, `${s}s / ${r} requests`)
  }
})

test('the cut-offs, and an older AIOStreams that only moves lastSeen per request', () => {
  assert.equal(MIN_PLAYING_SECONDS, 45)
  assert.equal(isPlayingConnection(conn(44, 1)), false)
  assert.equal(isPlayingConnection(conn(45, 1)), true)
  assert.equal(isPlayingConnection(conn(0, MANY_REQUESTS - 1)), false)
  assert.equal(isPlayingConnection(conn(0, MANY_REQUESTS)), true)
  // A polled stream (startedAt, ms numbers) reads the same as a stored row.
  assert.equal(isPlayingConnection({ requests: 2, startedAt: T0, lastSeenAt: T0 + 3000 }), false)
  assert.equal(isPlayingConnection({ requests: 2, startedAt: T0, lastSeenAt: T0 + 60000 }), true)
  for (const bad of [null, undefined, 3, {}]) assert.equal(isPlayingConnection(bad), false)
})

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

test('the "started watching" notification waits for a playing connection', () => {
  const src = read('server/utils/proxyStreamMonitor.js')
  assert.match(src, /const playingNow = isPlayingConnection\(row\)/)
  assert.match(src, /isPlayingConnection\(existingRow\)/)
  assert.match(src, /if \(notifyActivity && playingNow && !wasPlaying && \(!existingRow \|\| existingRow\.isActive\)\)/)
})

test('Now Playing and the sync-mismatch warning only read playing connections', () => {
  const now = read('server/utils/proxyNowPlaying.js')
  assert.equal((now.match(/\.filter\(isPlayingConnection\)/g) || []).length, 2, 'both the live and the recently-closed query')
  assert.match(read('server/utils/watchSyncMismatch.js'), /\.filter\(isPlayingConnection\)/)
})
