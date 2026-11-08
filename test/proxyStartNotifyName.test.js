// The "started watching" alert for a stream named only by an opaque id says
// what Now Playing says: the same file's earlier name, or the title they were
// partway through as a guess - never "a title SlickSync couldn't name yet"
// while the card shows the title.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

// Catch the push instead of sending it (stubbed before the monitor loads it).
const sent = []
const pushPath = path.join(__dirname, '../server/utils/pushNotifications.js')
require.cache[pushPath] = { id: pushPath, filename: pushPath, loaded: true, exports: { notifyPushForType: async (_p, _a, _type, msg) => { sent.push(msg) } } }
const { maybeNotifyStart } = require('../server/utils/proxyStreamMonitor')._test

const MIN = 60 * 1000
const START = new Date('2026-11-08T20:25:12Z')
const users = [{ id: 'user-1', username: 'NuvioSLICK', email: 'nuvio@example.invalid' }]

function fakePrisma({ row, earlier = [], sessions = [] }) {
  return {
    proxyStreamSession: {
      findMany: async ({ where }) => (where.url ? earlier.filter((e) => where.url.in.includes(e.url)) : []),
      findUnique: async () => row,
    },
    watchSession: { findMany: async () => sessions },
    dismissedContinueWatching: { findFirst: async () => null },
  }
}
const opaqueRow = (o = {}) => ({
  id: 'row-1', url: 'usenet:abc:1:', filename: 'gaIT5CXKja0GUpsv3FEiKwOk3ie7wQHg.mkv', displayName: 'gaIT5CXKja0GUpsv3FEiKwOk3ie7wQHg',
  posterUrl: null, metadataItemId: null, metadataItemType: null, metadataName: null, startTime: START, ...o,
})
const run = async (db, n) => {
  sent.length = 0
  await maybeNotifyStart(fakePrisma(db), 'acct-' + n, null, users, 'NuvioSLICK', 'row-1', db.row.displayName)
  return sent[0]
}

test('an unnamed stream: the title they were partway through, said as a guess', async () => {
  const msg = await run({
    row: opaqueRow(),
    sessions: [{ userId: 'user-1', itemId: 'tt35538033', itemName: 'Resident Evil', itemType: 'movie', poster: 'https://posters/re.jpg', lastPosition: 46 * MIN, totalDuration: 93 * MIN, updatedAt: new Date(START.getTime() - 10 * MIN) }],
  }, 1)
  assert.equal(msg.title, 'NuvioSLICK started watching')
  assert.equal(msg.body, 'Probably Resident Evil - resumed from Continue Watching')
  assert.equal(msg.icon, 'https://posters/re.jpg')
})

test('an unnamed stream of a file played before under its name: that name, for certain', async () => {
  const msg = await run({
    row: opaqueRow(),
    earlier: [{ id: 'old', url: 'usenet:abc:1:', filename: 'Resident.Evil.2026.mkv', displayName: 'Resident Evil (2026)', posterUrl: 'https://posters/p.jpg', metadataItemId: 'tt35538033', metadataItemType: 'movie', metadataName: 'Resident Evil' }],
  }, 2)
  assert.match(msg.body, /^Resident Evil/)
  assert.doesNotMatch(msg.body, /Probably/)
})

test('nothing to go on: it still says the title is not known yet', async () => {
  const msg = await run({ row: opaqueRow() }, 3)
  assert.equal(msg.body, 'a title SlickSync couldn’t name yet')
})

test('a named stream is unchanged', async () => {
  const msg = await run({ row: opaqueRow({ filename: 'Some.Film.2020.mkv', displayName: 'Some Film (2020)' }) }, 4)
  assert.equal(msg.body, 'Some Film (2020)')
})
