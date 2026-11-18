// Which profile Now Playing names (utils/profileLabels.js, metricsBuilder).
// A Nuvio account's profiles count as one person until separated, so the
// card must name the profile playing the title, not the one used last.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profilelabels-'))
process.env.LIBRARIES_CACHE_DIR = dir
// Runtime lookups would go to the network.
require('../server/utils/notify').fetchMetadata = async () => null

const { setCachedLibrary, clearCache } = require('../server/utils/libraryCache')
const { latestProfileLabels, nuvioProfileFor, profileName } = require('../server/utils/profileLabels')
const { buildNowPlaying } = require('../server/utils/metricsBuilder')

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const ACCOUNT = 'default'
const MIN = 60 * 1000
const wednesday = 'tt13443470'
const person = { id: 'u-nuvio', accountId: ACCOUNT, username: 'NuvioSLICK', email: 'nuvio@example.com', providerType: 'nuvio', isActive: true }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// History rows, newest first: Main Profile was used last, the markers are
// sources rather than profiles.
const HISTORY = [
  { userId: person.id, profileLabel: 'Caught up', createdAt: new Date(Date.now() - 1 * MIN) },
  { userId: person.id, profileLabel: 'Main Profile', createdAt: new Date(Date.now() - 60 * MIN) },
  { userId: person.id, profileLabel: 'Kids', createdAt: new Date(Date.now() - 600 * MIN) },
]

/** Enough of prisma for the label query: where.userId.in, profileLabel not/notIn, distinct userId. */
function watchActivityTable(rows) {
  return {
    findMany: async ({ where, distinct }) => {
      const notIn = where.profileLabel?.notIn || []
      const out = rows
        .filter((r) => where.userId.in.includes(r.userId) && r.profileLabel != null && !notIn.includes(r.profileLabel))
        .sort((a, b) => b.createdAt - a.createdAt)
      if (distinct?.includes('userId')) return out.filter((r, i) => out.findIndex((o) => o.userId === r.userId) === i)
      return out
    },
  }
}

function world(sessions) {
  const base = {
    watchSession: { findMany: async () => sessions },
    watchActivity: watchActivityTable(HISTORY),
    user: { findMany: async () => [person], findFirst: async () => person },
  }
  // Every other table answers empty.
  return new Proxy(base, {
    get: (target, name) => (name in target ? target[name] : new Proxy({}, { get: () => async () => [] })),
  })
}

const playingWednesday = () => ({
  userId: person.id, itemId: `${wednesday}:3:4`, itemName: 'Wednesday', itemType: 'series', videoId: `${wednesday}:3:4`,
  season: 3, episode: 4, poster: null, startTime: new Date(Date.now() - 10 * MIN), updatedAt: new Date(),
  isActive: true, lastPosition: 600000, totalDuration: 3000000,
})

test('a history label that is a source, not a profile, is never used as the profile', async () => {
  const latest = await latestProfileLabels({ watchActivity: watchActivityTable(HISTORY) }, ACCOUNT, [person.id])
  assert.equal(latest.get(person.id), 'Main Profile')
  for (const marker of ['Imported', 'Caught up', 'Scrobbled', 'AIOStreams']) assert.equal(profileName(marker), null)
  assert.equal(profileName('Kids'), 'Kids')
})

test('the library names the profile that last played a title, matched by the show for an episode', () => {
  const library = [{ _id: wednesday, state: { nuvioProfile: 'Kids' } }, { _id: 'tt0386676', state: { nuvioProfile: null } }]
  assert.equal(nuvioProfileFor(library, `${wednesday}:3:4`), 'Kids')
  assert.equal(nuvioProfileFor(library, 'tt0386676'), null)
  assert.equal(nuvioProfileFor(library, 'tt9999999'), null)
})

test('Now Playing names the profile playing the title, not the one the person used last', async () => {
  setCachedLibrary(ACCOUNT, person, [{ _id: wednesday, name: 'Wednesday', type: 'series', state: { nuvioProfile: 'Kids', lastWatched: new Date().toISOString() } }])
  await wait(100)
  const rows = await buildNowPlaying(world([playingWednesday()]), ACCOUNT, [person])
  const card = rows.find((r) => r.user.id === person.id)
  assert.ok(card, 'the card shows')
  assert.equal(card.profileLabel, 'Kids')
  clearCache(ACCOUNT, person)
})

test('Now Playing falls back to the profile used last when the library has no name for the title', async () => {
  setCachedLibrary(ACCOUNT, person, [{ _id: wednesday, name: 'Wednesday', type: 'series', state: { lastWatched: new Date().toISOString() } }])
  await wait(100)
  const rows = await buildNowPlaying(world([playingWednesday()]), ACCOUNT, [person])
  const card = rows.find((r) => r.user.id === person.id)
  assert.ok(card, 'the card shows')
  assert.equal(card.profileLabel, 'Main Profile')
  clearCache(ACCOUNT, person)
})
