const test = require('node:test')
const assert = require('node:assert/strict')
const { createJellyfinProvider, stremioIdFromProviderIds, decodePackedId, encodePackedId } = require('../server/providers/jellyfin')
const { normalizeServerUrl, serverKindOf, identityEmail, displayServer } = require('../server/providers/jellyfinAuth')
const jellyfinLive = require('../server/utils/jellyfinLive')

test('provider ids: IMDb first, then TMDb and TVDB, whatever the key casing', () => {
  assert.equal(stremioIdFromProviderIds({ Imdb: 'tt0133093', Tmdb: '603' }), 'tt0133093')
  assert.equal(stremioIdFromProviderIds({ tmdb: '603' }), 'tmdb:603')
  assert.equal(stremioIdFromProviderIds({ Tvdb: '81189' }), 'tvdb:81189')
  assert.equal(stremioIdFromProviderIds({ Imdb: '' }), null)
  assert.equal(stremioIdFromProviderIds(null), null)
})

test('packed ids: the ids AIOStreams builds decode to the title and episode, and encode back', () => {
  // Read from a live AIOStreams 2.35 server: Breaking Bad S01E02, and a movie.
  assert.deepEqual(decodePackedId('a141020000000dca4300010002000000'), { kind: 'episode', base: 'tt0903747', season: 1, episode: 2 })
  assert.deepEqual(decodePackedId('a1110100000069caf6ffffffff000000'), { kind: 'movie', base: 'tt6933238', season: null, episode: null })
  assert.equal(encodePackedId({ kind: 'episode', base: 'tt0903747', season: 1, episode: 2 }), 'a141020000000dca4300010002000000')
  assert.equal(encodePackedId({ kind: 'movie', base: 'tt6933238' }), 'a1110100000069caf6ffffffff000000')
  // A real Jellyfin's ids are random; nothing to decode.
  assert.equal(decodePackedId('c9f640a2e4aaa99571b293c11501718d'), null)
})

test('addresses: what people paste is trimmed to a base every API path can follow', () => {
  assert.equal(normalizeServerUrl('jellyfin.example.com/web/index.html#!/home'), 'https://jellyfin.example.com')
  assert.equal(normalizeServerUrl('http://192.168.1.5:8096/'), 'http://192.168.1.5:8096')
  assert.equal(normalizeServerUrl('https://aio.example.com/jellyfin/u/family'), 'https://aio.example.com/jellyfin/u/family')
  assert.equal(normalizeServerUrl('ftp://nope'), '')
  assert.equal(normalizeServerUrl(''), '')
})

test('server kind: AIOMetadata names itself; AIOStreams carries its extension block', () => {
  assert.equal(serverKindOf({ ServerName: 'AIOMetadata', aiostreams: {} }), 'aiometadata')
  assert.equal(serverKindOf({ ServerName: 'AIOStreams', aiostreams: { features: {} } }), 'aiostreams')
  assert.equal(serverKindOf({ ServerName: 'living room', ProductName: 'Jellyfin Server' }), 'jellyfin')
})

test('display: an AIOStreams picker address never shows its encrypted password', () => {
  const picker = 'https://aio.example.com/jellyfin/0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b/' + 'x'.repeat(120)
  assert.equal(displayServer(picker).includes('x'.repeat(41)), false)
  assert.equal(identityEmail('https://jf.example.com', 'ABC123'), 'abc123@jf.example.com')
})

function fakeServer(routes) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url) => {
    const { pathname, searchParams } = new URL(url)
    calls.push(pathname + (searchParams.toString() ? '?' + searchParams : ''))
    const key = Object.keys(routes).find((k) => (pathname + '?' + searchParams).includes(k))
    const body = key ? routes[key](searchParams) : { Items: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  return { calls, restore: () => { global.fetch = original } }
}

test('library: played, in-progress and playing titles become one entry per movie and per show', async () => {
  const now = new Date().toISOString()
  const server = fakeServer({
    '/UserItems/Resume': () => ({ Items: [
      { Type: 'Movie', Id: 'm1', Name: 'The Matrix', RunTimeTicks: 60000000000, ProviderIds: { Imdb: 'tt0133093' }, UserData: { PlaybackPositionTicks: 18000000000, Played: false, LastPlayedDate: '2026-10-01T10:00:00Z' } },
    ] }),
    'Filters=IsPlayed': () => ({ Items: [
      { Type: 'Episode', Id: 'e1', SeriesId: 's1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 30000000000, UserData: { PlaybackPositionTicks: 0, Played: true, PlayCount: 1, LastPlayedDate: '2026-09-30T10:00:00Z' } },
    ] }),
    'Filters=IsFavorite': () => ({ Items: [
      { Type: 'Series', Id: 'fav', Name: 'Severance', ProviderIds: { Imdb: 'tt11280740' } },
    ] }),
    '/Sessions': () => ([
      { UserId: 'u1', LastActivityDate: now, PlayState: { PositionTicks: 600000000, IsPaused: false }, NowPlayingItem: { Type: 'Episode', Id: 'e2', SeriesId: 's1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 30000000000 } },
    ]),
    'Ids=s1': () => ({ Items: [{ Id: 's1', Name: 'Breaking Bad', ProviderIds: { Imdb: 'tt0903747' } }] }),
  })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://jf.test', token: 't', userId: 'u1', serverId: 'srv-test-1', slicksyncUserId: 'person-1' })
    const library = await provider.getLibrary()
    const byId = Object.fromEntries(library.map((i) => [i._id, i]))

    // A show carries the episode it is on now: the one playing beats the one played yesterday.
    assert.equal(byId.tt0903747.type, 'series')
    assert.equal(byId.tt0903747.state.video_id, 'tt0903747:1:2')
    assert.equal(byId.tt0903747.state.timeOffset, 60000)
    assert.equal(byId.tt0903747._jf.live, true)

    // A resume point is where playback is, in milliseconds.
    assert.equal(byId.tt0133093.state.timeOffset, 1800000)
    assert.equal(byId.tt0133093.state.duration, 6000000)
    assert.equal(byId.tt0133093.state.wallClockCapped, true)

    // A favourite with nothing watched is a library bookmark.
    assert.deepEqual(byId.tt11280740.state, {})

    // What plays is handed to Now Playing.
    const live = jellyfinLive.liveViewings(['person-1'])
    assert.equal(live.length, 1)
    assert.equal(live[0].videoId, 'tt0903747:1:2')
    assert.equal(live[0].season, 1)
  } finally {
    server.restore()
    jellyfinLive.forgetUser('person-1')
  }
})

test('library: played with no resume point left is reported as finished, at the end', async () => {
  const server = fakeServer({
    'Filters=IsPlayed': () => ({ Items: [
      { Type: 'Movie', Id: 'm1', Name: 'Inception', RunTimeTicks: 88800000000, ProviderIds: { Imdb: 'tt1375666' }, UserData: { PlaybackPositionTicks: 0, Played: true, PlayCount: 2, LastPlayedDate: '2026-09-29T21:00:00Z' } },
    ] }),
  })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://jf.test', token: 't', userId: 'u1', serverId: 'srv-test-2', slicksyncUserId: 'person-2' })
    const [movie] = await provider.getLibrary()
    assert.equal(movie.state.timeOffset, movie.state.duration)
    assert.equal(movie.state.flaggedWatched, 1)
    assert.equal(movie.state.timesWatched, 2)
    assert.equal(movie.state.lastWatched, '2026-09-29T21:00:00.000Z')
  } finally {
    server.restore()
    jellyfinLive.forgetUser('person-2')
  }
})

test('live: a viewing is announced once, when it first appears', () => {
  jellyfinLive.drainStarts()
  const viewing = { itemId: 'tt0133093', itemType: 'movie', videoId: null, itemName: 'The Matrix', positionMs: 1000, durationMs: 6000000 }
  jellyfinLive.recordLive('person-3', [viewing])
  jellyfinLive.recordLive('person-3', [{ ...viewing, positionMs: 61000 }])
  const starts = jellyfinLive.drainStarts().filter((s) => s.userId === 'person-3')
  assert.equal(starts.length, 1)
  jellyfinLive.recordLive('person-3', [])
  assert.equal(jellyfinLive.liveViewings(['person-3']).length, 0)
  jellyfinLive.forgetUser('person-3')
})

test('household: each profile is read with its own sign-in and its viewing carries the profile name', async () => {
  const original = global.fetch
  const seen = []
  global.fetch = async (url, opts) => {
    const { pathname, searchParams } = new URL(url)
    const auth = String(opts?.headers?.Authorization || '')
    const token = /Token="([^"]+)"/.exec(auth)?.[1]
    seen.push(`${token} ${pathname}`)
    let body = { Items: [] }
    if (pathname.endsWith('/Items') && searchParams.get('Filters') === 'IsPlayed') {
      body = token === 'kid-token'
        ? { Items: [{ Type: 'Movie', Id: 'k1', Name: 'Paddington', RunTimeTicks: 57000000000, ProviderIds: { Imdb: 'tt1109624' }, UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: '2026-10-02T18:00:00Z' } }] }
        : { Items: [{ Type: 'Movie', Id: 'o1', Name: 'Heat', RunTimeTicks: 102000000000, ProviderIds: { Imdb: 'tt0113277' }, UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: '2026-10-01T21:00:00Z' } }] }
    }
    if (pathname.endsWith('/Sessions')) body = token === 'kid-token'
      ? [{ UserId: 'kid', PlayState: { PositionTicks: 300000000 }, NowPlayingItem: { Type: 'Movie', Id: 'k2', Name: 'Moana', RunTimeTicks: 64000000000, ProviderIds: { Imdb: 'tt3521164' } } }]
      : []
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  try {
    const provider = createJellyfinProvider({
      serverUrl: 'https://aio.test/jellyfin', token: 'owner-token', userId: 'owner', serverKind: 'aiostreams', serverId: 'srv-household', slicksyncUserId: 'person-h',
      resolveProfiles: async () => [{ jellyfinUserId: 'kid', name: 'Kid', token: 'kid-token' }],
    })
    const library = await provider.getLibrary()
    const byId = Object.fromEntries(library.map((i) => [i._id, i]))
    assert.equal(byId.tt0113277.state.profileLabel, undefined, 'the person\'s own viewing has no profile label')
    assert.equal(byId.tt1109624.state.profileLabel, 'Kid')
    assert.equal(byId.tt3521164._jf.live, true)
    assert.ok(seen.some((s) => s.startsWith('kid-token ') && s.endsWith('/Items')), 'the profile is read with its own token')
    const live = jellyfinLive.liveViewings(['person-h'])
    assert.equal(live.length, 1)
    assert.equal(live[0].itemId, 'tt3521164')
  } finally {
    global.fetch = original
    jellyfinLive.forgetUser('person-h')
  }
})

test('ids split into title, season and episode - a prefixed id keeps its prefix', () => {
  const { splitStremioId } = require('../server/providers/jellyfin')
  assert.deepEqual(splitStremioId('tt0903747:1:2'), { base: 'tt0903747', season: '1', episode: '2' })
  assert.deepEqual(splitStremioId('tt0133093'), { base: 'tt0133093', season: undefined, episode: undefined })
  // Read as show "tmdb", season 209867 before this existed.
  assert.deepEqual(splitStremioId('tmdb:209867'), { base: 'tmdb:209867', season: undefined, episode: undefined })
  assert.deepEqual(splitStremioId('tmdb:209867:1:3'), { base: 'tmdb:209867', season: '1', episode: '3' })
  assert.deepEqual(splitStremioId('kitsu:46676:1'), { base: 'kitsu:46676', season: '1', episode: undefined })
})
