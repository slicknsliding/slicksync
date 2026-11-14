// Now Playing when the stream's login matches nobody and a person's own app
// reports the title: someone signed in to an AIOStreams or Jellyfin server
// played a film through a login whose fallback list names other people. The
// stream used to show as a second card under a fallback person ("Playing in
// Nuvio") next to the app's own card, and after a pause as one card under
// that person whose time kept climbing past the real spot.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')

const START = new Date(Date.now() - 6 * 60 * 1000)
const FILM = { id: 'tt35538033', name: 'Resident Evil', type: 'movie' }

const nuvioPerson = { id: 'nuvio-1', username: 'Nuvio person', providerType: 'nuvio' }
const stremioPerson = { id: 'stremio-1', username: 'Stremio person', providerType: 'stremio' }
const serverPerson = { id: 'server-1', username: 'Server person', providerType: 'jellyfin' }
const USERS = [nuvioPerson, stremioPerson, serverPerson]

function stream(overrides = {}) {
  return {
    id: 'p1', aiostreamsUser: 'household', url: 'https://example.com/a', filename: 'Resident.Evil.2026.mkv',
    displayName: 'Resident Evil (2026)', metadataItemId: FILM.id, metadataName: FILM.name, metadataItemType: 'movie',
    isActive: true, startTime: START, lastSeenAt: new Date(START.getTime() + 60000), updatedAt: new Date(Date.now() - 5000),
    requestCount: 5, ...overrides,
  }
}

// The fake applies the merge's own filters: live rows or recently ended ones,
// and watch sessions the app ended or began since the stream opened.
function fakePrisma({ live = [stream()], sessions = [] } = {}) {
  return {
    proxyStreamSession: { findMany: async ({ where }) => (where.isActive ? live : []) },
    watchSession: {
      findMany: async ({ where }) => {
        const since = where.OR[0].endTime.gte
        return sessions.filter((s) => s.accountId === where.accountId && where.userId.in.includes(s.userId) &&
          ((s.endTime && s.endTime >= since) || (s.isActive && s.startTime >= since)))
      },
    },
  }
}

// The login's fallback list names the Nuvio and Stremio people, not the server one.
const ORIGINAL_FALLBACK = process.env.AIOSTREAMS_FALLBACK_USER_IDS
process.env.AIOSTREAMS_FALLBACK_USER_IDS = 'nuvio-1,stremio-1'
test.after(() => {
  if (ORIGINAL_FALLBACK === undefined) delete process.env.AIOSTREAMS_FALLBACK_USER_IDS
  else process.env.AIOSTREAMS_FALLBACK_USER_IDS = ORIGINAL_FALLBACK
})
const withFallback = (fn) => fn()

const serverCard = (extra = {}) => ({
  user: { id: serverPerson.id, username: serverPerson.username },
  item: { ...FILM },
  videoId: FILM.id,
  lastPosition: 540000,
  totalDuration: null,
  positionAt: Date.now() - 2000,
  reportedAtTimestamp: Date.now() - 20000,
  source: 'jellyfin',
  ...extra,
})

test('playing: the app reporting the film is the one card, not a second one under a fallback person', async () => {
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma(), 'acc', USERS, [serverCard()], { isConfirming: () => true }))
  assert.equal(result.length, 1, 'one card for one viewing')
  assert.equal(result[0].user.id, serverPerson.id)
  assert.equal(result[0].source, 'jellyfin', "the app's own card, with its real position")
  assert.equal(result[0].lastPosition, 540000)
})

test('playing: a pause the server reports stays a pause', async () => {
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma(), 'acc', USERS, [serverCard({ paused: true })], { isConfirming: () => true }))
  assert.equal(result.length, 1)
  assert.equal(result[0].paused, true)
})

test('paused: the app went quiet after saving its spot - the stream shows that spot, paused, under that person', async () => {
  const pausedAt = new Date(Date.now() - 3 * 60 * 1000)
  const sessions = [{
    accountId: 'acc', userId: serverPerson.id, itemId: FILM.id, itemName: FILM.name, itemType: 'movie', videoId: FILM.id,
    startTime: new Date(START.getTime() + 2 * 60 * 1000), endTime: pausedAt, updatedAt: new Date(), isActive: false,
    lastPosition: 692000, totalDuration: 0,
  }]
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma({ sessions }), 'acc', USERS, [], { isConfirming: () => true }))
  assert.equal(result.length, 1)
  const card = result[0]
  assert.equal(card.user.id, serverPerson.id, 'not the fallback person')
  assert.equal(card.paused, true)
  assert.equal(card.lastPosition, 692000, 'where the app paused it')
  assert.equal(card.positionAt, null, 'nothing counts on from a pause')
  assert.equal(card.reportedAtTimestamp, pausedAt.getTime(), '"paused 3 min ago" counts from the pause')
})

test('paused: a session that ended before this stream opened is an earlier viewing, not this one', async () => {
  const sessions = [{
    accountId: 'acc', userId: serverPerson.id, itemId: FILM.id, itemName: FILM.name, itemType: 'movie', videoId: FILM.id,
    startTime: new Date(START.getTime() - 3 * 3600 * 1000), endTime: new Date(START.getTime() - 2 * 3600 * 1000), updatedAt: new Date(), isActive: false,
    lastPosition: 692000, totalDuration: 0,
  }]
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma({ sessions }), 'acc', USERS, [], { isConfirming: () => true }))
  assert.equal(result.length, 1)
  assert.notEqual(result[0].user.id, serverPerson.id)
  assert.notEqual(result[0].paused, true)
})

test("paused: a fallback person whose own record has the film keeps it", async () => {
  const sessions = [{
    accountId: 'acc', userId: serverPerson.id, itemId: FILM.id, itemName: FILM.name, itemType: 'movie', videoId: FILM.id,
    startTime: new Date(START.getTime() + 60000), endTime: new Date(Date.now() - 60000), updatedAt: new Date(), isActive: false,
    lastPosition: 692000, totalDuration: 0,
  }]
  const nuvioCard = { user: { id: nuvioPerson.id, username: nuvioPerson.username }, item: { ...FILM }, videoId: FILM.id, lastPosition: 300000, totalDuration: 6000000, reportedAtTimestamp: Date.now() - 60000 }
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma({ sessions }), 'acc', USERS, [nuvioCard], { isConfirming: () => true }))
  assert.equal(result.length, 1)
  assert.equal(result[0].user.id, nuvioPerson.id)
})

test("a login matched to its owner's profiles by email still goes to the person whose app reports it", async () => {
  const owned = [
    { ...nuvioPerson, email: 'household@example.com' },
    { ...stremioPerson, email: 'household@example.com' },
    { ...serverPerson, email: 'someone@example.com' },
  ]
  const playing = await mergeProxyNowPlaying(fakePrisma(), 'acc', owned, [serverCard()], { isConfirming: () => true })
  assert.equal(playing.length, 1)
  assert.equal(playing[0].user.id, serverPerson.id)
  const sessions = [{
    accountId: 'acc', userId: serverPerson.id, itemId: FILM.id, itemName: FILM.name, itemType: 'movie', videoId: FILM.id,
    startTime: new Date(START.getTime() + 60000), endTime: new Date(Date.now() - 60000), updatedAt: new Date(), isActive: false,
    lastPosition: 692000, totalDuration: 0,
  }]
  const paused = await mergeProxyNowPlaying(fakePrisma({ sessions }), 'acc', owned, [], { isConfirming: () => true })
  assert.equal(paused.length, 1)
  assert.equal(paused[0].user.id, serverPerson.id)
  assert.equal(paused[0].paused, true)
  assert.equal(paused[0].lastPosition, 692000)
})

test('a login that names its person is left to that person', async () => {
  const named = [...USERS, { id: 'named-1', username: 'household', providerType: 'nuvio' }]
  const result = await withFallback(() => mergeProxyNowPlaying(fakePrisma(), 'acc', named, [], { isConfirming: () => true }))
  assert.equal(result.length, 1)
  assert.equal(result[0].user.id, 'named-1')
})

test('a live report moved on to now says so, so the card does not count the time since twice', () => {
  const live = require('../server/utils/jellyfinLive')
  live.recordLive('np-user', [{ itemId: 'tt1', itemType: 'movie', videoId: 'tt1', itemName: 'X', positionMs: 60000, durationMs: 6000000, paused: false }])
  const [v] = live.liveViewings(['np-user'])
  assert.equal(v.positionMs - 60000, v.positionAt - v.observedAt, 'moved on by exactly the time since the pass, to positionAt')
  live.forgetUser('np-user')
})
