// A usenet stream whose file name is scrambled takes the name AIOStreams'
// library has for that download (server/utils/usenetStreamNames.js), and a
// stream the player let go of stops counting as playing
// (server/utils/proxyPlaying.js). Both from one real afternoon: a film that
// showed as another title, with the film before it still listed beside it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { nameScrambledUsenetStreams, usenetHash, forgetNamesForTests } = require('../server/utils/usenetStreamNames')
const { isReleasedStream, RELEASED_AFTER_MS } = require('../server/utils/proxyPlaying')
const { parseDisplayName } = require('../server/utils/proxyStreamMonitor')

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const scrambled = () => ({ transport: 'usenet', targetKey: `usenet:${HASH}:3:`, filename: 'eGLM3dX5fu0v3nObsmdPZ2k2ZcFFT5CW.mkv' })

test('a scrambled usenet name becomes the library name, and reads as its title', async () => {
  forgetNamesForTests()
  const streams = [scrambled()]
  await nameScrambledUsenetStreams(streams, async (hash) => {
    assert.equal(hash, HASH)
    return 'Other.Mommy.2026.2160p.MA.WEB-DL.DDP5.1.Atmos.H.265-Kitsune'
  })
  assert.equal(streams[0].filename, 'Other.Mommy.2026.2160p.MA.WEB-DL.DDP5.1.Atmos.H.265-Kitsune')
  assert.equal(parseDisplayName(streams[0].filename), 'Other Mommy (2026)')
})

test('asked once per download, and a stream that has its name is left alone', async () => {
  forgetNamesForTests()
  let asked = 0
  const lookup = async () => { asked += 1; return 'Other.Mommy.2026.2160p.WEB-DL' }
  await nameScrambledUsenetStreams([scrambled()], lookup)
  await nameScrambledUsenetStreams([scrambled()], lookup)
  assert.equal(asked, 1)
  const named = [{ transport: 'usenet', targetKey: `usenet:${HASH}:0:`, filename: 'The.Mongoose.2026.2160p.AMZN.WEB-DL.mkv' }]
  await nameScrambledUsenetStreams(named, async () => { throw new Error('must not be asked') })
  assert.equal(named[0].filename, 'The.Mongoose.2026.2160p.AMZN.WEB-DL.mkv')
})

test('no name to be had: the stream stays as it is, and is asked again later', async () => {
  forgetNamesForTests()
  let asked = 0
  const t0 = Date.parse('2026-11-22T22:20:00Z')
  const failing = async () => { asked += 1; throw new Error('AIOStreams did not answer') }
  const s1 = [scrambled()]
  await nameScrambledUsenetStreams(s1, failing, t0)
  assert.equal(s1[0].filename, 'eGLM3dX5fu0v3nObsmdPZ2k2ZcFFT5CW.mkv')
  await nameScrambledUsenetStreams([scrambled()], failing, t0 + 60 * 1000)
  assert.equal(asked, 1, 'not asked again within minutes of a miss')
  const s3 = [scrambled()]
  await nameScrambledUsenetStreams(s3, async () => 'Other.Mommy.2026.2160p.WEB-DL', t0 + 6 * 60 * 1000)
  assert.equal(s3[0].filename, 'Other.Mommy.2026.2160p.WEB-DL')
  // A library name that is itself scrambled is no name.
  forgetNamesForTests()
  const s4 = [scrambled()]
  await nameScrambledUsenetStreams(s4, async () => 'hpHmBqcd6wQ411nRRtEqMc04xYz')
  assert.equal(s4[0].filename, 'eGLM3dX5fu0v3nObsmdPZ2k2ZcFFT5CW.mkv')
})

test('only usenet keys carry a hash', () => {
  assert.equal(usenetHash(`usenet:${HASH}:3:`), HASH)
  assert.equal(usenetHash('https://example.com/file.mkv'), null)
  assert.equal(usenetHash(null), null)
})

test('a stream the player let go of is not playing; a paused or older-server one still is', () => {
  // The film that had finished: nothing open, quiet for over a minute.
  assert.equal(isReleasedStream({ activeReads: 0, idleMs: 62000 }), true)
  assert.equal(isReleasedStream({ activeReads: 0, idleMs: RELEASED_AFTER_MS }), true)
  // A seek or a reconnect: nothing open for a moment.
  assert.equal(isReleasedStream({ activeReads: 0, idleMs: 4000 }), false)
  // Paused or buffered up: the request stays open however long it is quiet.
  assert.equal(isReleasedStream({ activeReads: 1, idleMs: 30 * 60 * 1000 }), false)
  // An AIOStreams that does not say.
  assert.equal(isReleasedStream({ requests: 3 }), false)
  assert.equal(isReleasedStream(null), false)
})
