// client/lib/playbackFreshness.ts: the "Live / Paused / Last seen" line under
// a Now Playing card.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

function load() {
  const clientDir = path.join(__dirname, '..', 'client')
  let ts
  try { ts = require(require.resolve('typescript', { paths: [clientDir] })) } catch { return null }
  const source = fs.readFileSync(path.join(clientDir, 'lib', 'playbackFreshness.ts'), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
  const mod = { exports: {} }
  new Function('module', 'exports', outputText)(mod, mod.exports)
  return mod.exports
}

const lib = load()
const NOW = 1_800_000_000_000
const ago = (ms) => NOW - ms
const opts = { skip: !lib }

test('a proxy stream reconfirmed seconds ago is live', opts, () => {
  const f = lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp: ago(8000) }, NOW)
  assert.deepEqual(f, { state: 'live', live: true, pulse: true, text: 'Live · updated 8 s ago' })
})

test('live counts in minutes once past a minute, and just now when brand new', opts, () => {
  assert.equal(lib.playbackFreshness({ source: 'jellyfin', reportedAtTimestamp: ago(90_000) }, NOW).text, 'Live · updated 1 min ago')
  assert.equal(lib.playbackFreshness({ source: 'jellyfin', reportedAtTimestamp: ago(1000) }, NOW).text, 'Live · updated just now')
})

test('live ends at the window, and a frozen proxy row is never live', opts, () => {
  assert.equal(lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp: ago(lib.LIVE_WINDOW_MS) }, NOW).state, 'live')
  const late = lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp: ago(lib.LIVE_WINDOW_MS + 1000) }, NOW)
  assert.equal(late.state, 'seen')
  assert.equal(late.text, 'Last seen 2 min ago')
  assert.equal(lib.playbackFreshness({ source: 'aiostreams-proxy', elapsedFrozen: true, reportedAtTimestamp: ago(5000) }, NOW).state, 'seen')
})

test('a row from a player the app cannot hear from never claims live', opts, () => {
  for (const source of [undefined, 'aiostreams']) {
    const f = lib.playbackFreshness({ source, reportedAtTimestamp: ago(5000) }, NOW)
    assert.equal(f.state, 'seen')
    assert.equal(f.live, false)
    assert.equal(f.text, 'Last seen just now')
  }
})

test('paused only when the player said so, whatever the source', opts, () => {
  assert.equal(lib.playbackFreshness({ source: 'jellyfin', paused: true, reportedAtTimestamp: ago(2 * 60_000 + 5000) }, NOW).text, 'Paused · 2 min ago')
  assert.equal(lib.playbackFreshness({ paused: true, reportedAtTimestamp: ago(3 * 3600_000) }, NOW).state, 'paused')
  assert.equal(lib.playbackFreshness({ source: 'jellyfin', paused: false, reportedAtTimestamp: ago(60_000) }, NOW).state, 'live')
})

test('last seen counts in minutes, hours and days', opts, () => {
  const text = (ms) => lib.playbackFreshness({ reportedAtTimestamp: ago(ms) }, NOW).text
  assert.equal(text(12 * 60_000), 'Last seen 12 min ago')
  assert.equal(text(59 * 60_000), 'Last seen 59 min ago')
  assert.equal(text(60 * 60_000), 'Last seen 1 hr ago')
  assert.equal(text(25 * 3600_000), 'Last seen 1 day ago')
  assert.equal(text(72 * 3600_000), 'Last seen 3 days ago')
})

test('a time a little ahead of this clock reads as now, a far one is ignored', opts, () => {
  assert.equal(lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp: NOW + 10_000 }, NOW).text, 'Live · updated just now')
  assert.equal(lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp: NOW + 10 * 60_000 }, NOW), null)
})

test('missing or garbage times give no line', opts, () => {
  for (const reportedAtTimestamp of [undefined, null, 0, -5, NaN, Infinity, '1700000000000']) {
    assert.equal(lib.playbackFreshness({ source: 'aiostreams-proxy', reportedAtTimestamp }, NOW), null)
  }
  assert.equal(lib.playbackFreshness(null, NOW), null)
  assert.equal(lib.playbackFreshness({ reportedAtTimestamp: ago(1000) }, NaN), null)
})

// --- AIOStreams apps: a start with nothing heard since, and pauses ----------

const MIN = 60_000
const apps = (over) => ({ source: 'aiostreams', ...over })

test('an AIOStreams start reads Playing, its own state, with a beating dot', opts, () => {
  const f = lib.playbackFreshness(apps({ reportedAtTimestamp: ago(4 * MIN), playingUntilTimestamp: NOW + 100 * MIN }), NOW)
  assert.deepEqual(f, { state: 'playing-estimated', live: false, pulse: true, text: 'Playing · started 4 min ago' })
  assert.equal(lib.playbackFreshness(apps({ reportedAtTimestamp: ago(1000), playingUntilTimestamp: NOW + MIN }), NOW).text, 'Playing · started just now')
})

test('Playing holds until the estimate passes, then Last seen with a grey dot', opts, () => {
  const at = ago(125 * MIN)
  assert.equal(lib.playbackFreshness(apps({ reportedAtTimestamp: at, playingUntilTimestamp: NOW }), NOW).state, 'playing-estimated')
  const after = lib.playbackFreshness(apps({ reportedAtTimestamp: at, playingUntilTimestamp: NOW - 1 }), NOW)
  assert.deepEqual(after, { state: 'seen', live: false, pulse: false, text: 'Last seen 2 hr ago' })
})

test('with no estimate from the server an AIOStreams row is just Last seen', opts, () => {
  assert.equal(lib.playbackFreshness(apps({ reportedAtTimestamp: ago(MIN), playingUntilTimestamp: undefined }), NOW).state, 'seen')
  assert.equal(lib.playbackFreshness(apps({ reportedAtTimestamp: ago(MIN), playingUntilTimestamp: NaN }), NOW).state, 'seen')
})

test('a pause shows Paused, then a start after it is Playing again', opts, () => {
  const paused = lib.playbackFreshness(apps({ paused: true, reportedAtTimestamp: ago(19 * MIN) }), NOW)
  assert.deepEqual(paused, { state: 'paused', live: false, pulse: false, text: 'Paused · 19 min ago' })
  const resumed = lib.playbackFreshness(apps({ reportedAtTimestamp: ago(MIN), playingUntilTimestamp: NOW + 50 * MIN }), NOW)
  assert.equal(resumed.state, 'playing-estimated')
})

test('only an AIOStreams-app row can be Playing; other sources ignore the estimate', opts, () => {
  assert.equal(lib.playbackFreshness({ source: 'jellyfin', paused: false, reportedAtTimestamp: ago(MIN), playingUntilTimestamp: NOW + MIN }, NOW).state, 'live')
  assert.equal(lib.playbackFreshness({ reportedAtTimestamp: ago(MIN), playingUntilTimestamp: NOW + MIN }, NOW).state, 'seen')
})
