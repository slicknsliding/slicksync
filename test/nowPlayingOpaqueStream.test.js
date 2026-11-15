// Now Playing for a stream with no readable name (a usenet download named by
// a hash) that a person signed in to an AIOStreams server is playing through
// a login shared with other profiles. The name can't be matched to anyone's
// app, so the stream went to one of the login's profiles with a guess of the
// last thing that profile left unfinished ("Probably - resumed from Continue
// Watching", a different film, under the wrong person) - while that person's
// own app had recorded the real film during this very stream.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')

const NOW = Date.now()
const START = new Date(NOW - 140 * 60 * 1000) // the stream opened 2h20m ago
const FILM = { id: 'tt0000101', name: 'The Long Voyage', type: 'movie' }
const OTHER = { id: 'tt0000202', name: 'A Different Film', type: 'movie' }

// One AIOStreams login ("household") owns the Nuvio and Stremio profiles (same
// email); the server person signs in to the AIOStreams server on their own.
const nuvioPerson = { id: 'nuvio-1', username: 'Nuvio person', providerType: 'nuvio', email: 'household@example.com' }
const stremioPerson = { id: 'stremio-1', username: 'Stremio person', providerType: 'stremio', email: 'household@example.com' }
const serverPerson = { id: 'server-1', username: 'Server person', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', email: 'server-person@example.com' }
const USERS = [nuvioPerson, stremioPerson, serverPerson]

const OPAQUE_URL = 'usenet:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f:7:'
function opaqueStream(overrides = {}) {
  return {
    id: 'p-opaque', aiostreamsUser: 'household', clientIp: '192.0.2.77', url: OPAQUE_URL,
    filename: 'aZbY09cXdW18eVfU27gTh36iSj45kRlQ.mkv', displayName: 'aZbY09cXdW18eVfU27gTh36iSj45kRlQ',
    metadataItemId: null, metadataName: null, metadataItemType: null,
    isActive: true, startTime: START, lastSeenAt: new Date(NOW - 20 * 1000), updatedAt: new Date(NOW - 10 * 1000),
    requestCount: 8, ...overrides,
  }
}

// What the server person's app recorded: it reported the film for a while
// during this stream, then the server stopped listing it (55 minutes ago).
const serverSession = (overrides = {}) => ({
  accountId: 'acc', userId: serverPerson.id, itemId: FILM.id, itemName: FILM.name, itemType: 'movie', videoId: FILM.id,
  startTime: new Date(NOW - 60 * 60 * 1000), endTime: new Date(NOW - 55 * 60 * 1000), updatedAt: new Date(NOW - 37 * 60 * 1000),
  isActive: false, lastPosition: 3215000, totalDuration: 0, ...overrides,
})
// The Nuvio profile's last unfinished title, from days ago: what the guess picked.
const nuvioUnfinished = {
  accountId: 'acc', userId: nuvioPerson.id, itemId: OTHER.id, itemName: OTHER.name, itemType: 'movie', videoId: OTHER.id,
  startTime: new Date(NOW - 3 * 86400e3), endTime: new Date(NOW - 3 * 86400e3 + 3600e3), updatedAt: new Date(NOW - 3 * 86400e3 + 3600e3),
  isActive: false, lastPosition: 2400000, totalDuration: 6300000,
}

// Answers each query the merge makes the way the database would.
function fakePrisma({ live = [opaqueStream()], sessions = [serverSession(), nuvioUnfinished] } = {}) {
  return {
    proxyStreamSession: {
      findMany: async ({ where }) => {
        if (where.url) return live.filter((r) => where.url.in.includes(r.url)) // the same file played before
        return where.isActive ? live : []
      },
    },
    watchSession: {
      findMany: async ({ where }) => sessions.filter((s) => {
        if (s.accountId !== where.accountId) return false
        if (where.userId?.in && !where.userId.in.includes(s.userId)) return false
        if (typeof where.userId === 'string' && s.userId !== where.userId) return false
        if (where.OR) {
          const since = where.OR[0].endTime.gte
          if (!((s.endTime && s.endTime >= since) || (s.isActive && s.startTime >= where.OR[1].startTime.gte))) return false
        }
        if (where.lastPosition && !(s.lastPosition >= where.lastPosition.gte)) return false
        if (where.updatedAt && !(s.updatedAt >= where.updatedAt.gte)) return false
        return true
      }).sort((a, b) => b.updatedAt - a.updatedAt),
    },
    dismissedContinueWatching: { findFirst: async () => null },
  }
}

const confirming = { isConfirming: () => true }

test('the app went quiet: the stream is the server person and their film, not a guess under the login\'s profile', async () => {
  const result = await mergeProxyNowPlaying(fakePrisma(), 'acc', USERS, [], confirming)
  assert.equal(result.length, 1, 'one card for one viewing')
  const card = result[0]
  assert.equal(card.user.id, serverPerson.id, 'the person whose app recorded it during this stream')
  assert.equal(card.item.id, FILM.id, 'the film their app recorded')
  assert.notEqual(card.item.guessed, true, 'known, not guessed')
})

test('the app went quiet but the stream kept reading: still playing, counted on from the app\'s last word', async () => {
  const [card] = await mergeProxyNowPlaying(fakePrisma(), 'acc', USERS, [], confirming)
  const quietAt = serverSession().endTime.getTime()
  assert.notEqual(card.paused, true, 'the stream read 55 minutes past the app going quiet')
  assert.equal(card.lastPosition, 3215000)
  assert.equal(card.positionAt, quietAt, 'the estimate counts on from where the app last put it')
  assert.equal(card.positionEstimated, true, 'shown as an estimate')
})

test('the app went quiet and the stream stopped reading then too: paused at that spot', async () => {
  const quietAt = serverSession().endTime
  const live = [opaqueStream({ lastSeenAt: new Date(quietAt.getTime() + 30 * 1000) })]
  const [card] = await mergeProxyNowPlaying(fakePrisma({ live }), 'acc', USERS, [], confirming)
  assert.equal(card.user.id, serverPerson.id)
  assert.equal(card.paused, true)
  assert.equal(card.positionAt, null)
  assert.equal(card.reportedAtTimestamp, quietAt.getTime(), '"paused N min ago" counts from the pause')
})

test('someone on a real Jellyfin server is not given a stream that went through AIOStreams', async () => {
  const onJellyfin = USERS.map((u) => (u.id === serverPerson.id ? { ...u, jellyfinServerKind: 'jellyfin' } : u))
  const result = await mergeProxyNowPlaying(fakePrisma(), 'acc', onJellyfin, [], confirming)
  assert.equal(result.length, 1)
  assert.equal(result[0].user.id, nuvioPerson.id)
})

test('a film another stream is showing by name is not this stream\'s', async () => {
  const named = {
    ...opaqueStream(), id: 'p-named', url: 'https://example.com/named', filename: 'The.Long.Voyage.mkv', displayName: 'The Long Voyage',
    metadataItemId: FILM.id, metadataName: FILM.name, metadataItemType: 'movie', aiostreamsUser: 'someone-else',
  }
  const result = await mergeProxyNowPlaying(fakePrisma({ live: [opaqueStream(), named] }), 'acc', USERS, [], confirming)
  const hashCard = result.find((c) => c.user.id === nuvioPerson.id)
  assert.ok(hashCard, "the hash-named stream stays with the login's profile")
  assert.notEqual(hashCard.item.id, FILM.id)
})

test("the app is reporting it live: that card alone, no guessed second card under the login's profile", async () => {
  const appCard = {
    user: { id: serverPerson.id, username: serverPerson.username },
    item: { ...FILM }, videoId: FILM.id, lastPosition: 3215000, totalDuration: null,
    watchedAtTimestamp: NOW - 4 * 60 * 1000, positionAt: NOW - 2000, reportedAtTimestamp: NOW - 20000, source: 'jellyfin',
  }
  const result = await mergeProxyNowPlaying(fakePrisma({ sessions: [nuvioUnfinished] }), 'acc', USERS, [appCard], confirming)
  assert.equal(result.length, 1, 'one card for one viewing')
  assert.equal(result[0].user.id, serverPerson.id)
  assert.equal(result[0].source, 'jellyfin', "the app's own card")
})

test('nobody else recorded anything during the stream: the guess for the login\'s profile stays', async () => {
  const result = await mergeProxyNowPlaying(fakePrisma({ sessions: [nuvioUnfinished] }), 'acc', USERS, [], confirming)
  assert.equal(result.length, 1)
  assert.equal(result[0].user.id, nuvioPerson.id)
  assert.equal(result[0].item.guessed, true)
})

test('the server person\'s film ended before this stream opened: an earlier viewing, not this one', async () => {
  const earlier = serverSession({ startTime: new Date(START.getTime() - 3 * 3600e3), endTime: new Date(START.getTime() - 2 * 3600e3), updatedAt: new Date(START.getTime() - 2 * 3600e3) })
  const result = await mergeProxyNowPlaying(fakePrisma({ sessions: [earlier, nuvioUnfinished] }), 'acc', USERS, [], confirming)
  assert.equal(result.length, 1)
  assert.equal(result[0].user.id, nuvioPerson.id)
})
