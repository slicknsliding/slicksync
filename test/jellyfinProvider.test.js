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

test('episodes: filler and recap come from AIOStreams\' field or AIOMetadata\'s tags; mixed episodes stay unmarked', async () => {
  const server = fakeServer({
    'IncludeItemTypes=Series': () => ({ Items: [{ Type: 'Series', Id: 's9', Name: 'Naruto', ProviderIds: { Imdb: 'tt0409591' } }] }),
    '/Shows/s9/Episodes': (q) => {
      assert.match(q.get('Fields') || '', /Tags/, 'asks for the tags')
      return { Items: [
        { Id: 'a', ParentIndexNumber: 1, IndexNumber: 1, Tags: [] },
        { Id: 'b', ParentIndexNumber: 1, IndexNumber: 2, Tags: ['Filler'] },
        { Id: 'c', ParentIndexNumber: 1, IndexNumber: 3, Tags: ['Recap'] },
        { Id: 'd', ParentIndexNumber: 1, IndexNumber: 4, Tags: ['Mixed Canon/Filler'] },
        { Id: 'e', ParentIndexNumber: 1, IndexNumber: 5, aiostreams: { filler: true } },
        { Id: 'f', ParentIndexNumber: 1, IndexNumber: 6, Tags: ['filler fan favourite'] },
      ] }
    },
  })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://jf.test', token: 't', userId: 'u1', serverId: 'srv-test-1' })
    const eps = await provider.listEpisodes('tt0409591')
    assert.deepEqual(eps.map((e) => [e.episode, e.filler, e.recap]), [
      [1, false, false], [2, true, false], [3, false, true], [4, false, false], [5, true, false], [6, false, false],
    ])
  } finally {
    server.restore()
  }
})

test('AIOMetadata: what plays on every device comes from /AIOStreams/Activity, kept to this viewer', async () => {
  const server = fakeServer({
    '/AIOStreams/Activity': () => ({ users: [], sessions: [
      { UserId: 'e1271701-4ac0-4111-8066-c21a15cba9a0', DeviceName: 'Living room TV', PlayState: { PositionTicks: 15000000000 }, NowPlayingItem: { Type: 'Movie', Id: 'm1', Name: 'The Matrix' } },
      { UserId: '2fc8a50e-4ce2-fa7e-5834-fe55ac1f8e08', DeviceName: 'Kid tablet', PlayState: { PositionTicks: 1 }, NowPlayingItem: { Type: 'Movie', Id: 'm2', Name: 'WALL-E' } },
    ] }),
    '/Sessions': () => ([]),
  })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://aiom.test/jellyfin/x', token: 't', userId: 'e12717014ac041118066c21a15cba9a0', serverKind: 'aiometadata' })
    const sessions = await provider.getNowPlaying()
    assert.deepEqual(sessions.map((s) => s.NowPlayingItem.Name), ['The Matrix'])
    assert.ok(server.calls.some((c) => c.includes('/AIOStreams/Activity')))
  } finally {
    server.restore()
  }
})

test('Play on a device: AIOMetadata from 4.0 offers each person their own devices and starts the title there; older ones and AIOStreams offer none', async () => {
  const sessions = [
    { Id: 'e1271701-tv', UserId: 'e1271701-4ac0-4111-8066-c21a15cba9a0', DeviceId: 'tv', DeviceName: 'Living room TV', Client: 'Jellyfin Android TV', SupportsRemoteControl: true },
    { Id: '2fc8a50e-tab', UserId: '2fc8a50e-4ce2-fa7e-5834-fe55ac1f8e08', DeviceId: 'tab', DeviceName: 'Kid tablet', Client: 'Jellyfin iOS', SupportsRemoteControl: true },
    { Id: 'e1271701-web', UserId: 'e1271701-4ac0-4111-8066-c21a15cba9a0', DeviceId: 'web', DeviceName: 'Browser', Client: 'Jellyfin Web', SupportsRemoteControl: false },
  ]
  const item = encodePackedId({ kind: 'movie', base: 'tt0133093' })
  const own = 'e12717014ac041118066c21a15cba9a0'
  // Each version on its own address: the answer is kept for a while per server.
  // As AIOMetadata answers: Version is the Jellyfin version it speaks (always
  // 12.x), its own is aiostreams.version.tag. No tag counts as too old.
  for (const [version, offered] of [['3.9.0', false], ['none', false], ['4.0.0', true], ['4.1.2', true]]) {
    const server = fakeServer({
      '/System/Info/Public': () => ({ ServerName: 'AIOMetadata', Version: '12.1.0', aiostreams: version === 'none' ? {} : { version: { tag: `v${version}` } } }),
      '/Sessions?': () => sessions,
      '/Playing': () => ({}),
    })
    try {
      const provider = createJellyfinProvider({ serverUrl: `https://aiom-${version}.test/jellyfin/x`, token: 't', userId: own, serverKind: 'aiometadata' })
      const devices = await provider.controllableSessions()
      if (!offered) {
        assert.deepEqual(devices, [], `${version}: no devices`)
        assert.ok(!server.calls.some((c) => c.includes('/Sessions')), `${version}: sessions not even asked`)
        await assert.rejects(provider.playOn('e1271701-tv', item), (e) => e.status === 400)
        assert.ok(!server.calls.some((c) => c.includes('/Playing')), `${version}: nothing started`)
        continue
      }
      // Only this person's devices that take commands: not the kid's tablet, not the browser.
      assert.deepEqual(devices, [{ id: 'e1271701-tv', device: 'Living room TV', client: 'Jellyfin Android TV', playing: null }], version)
      assert.equal(await provider.playOn('e1271701-tv', item), true)
      assert.ok(server.calls.includes(`/jellyfin/x/Sessions/e1271701-tv/Playing?playCommand=PlayNow&itemIds=${item}`), `${version}: Play sent to the device`)
    } finally {
      server.restore()
    }
  }

  // AIOStreams answers the commands but does nothing with them: never offered, never asked.
  const aio = fakeServer({ '/Sessions?': () => sessions })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://aio.test/jellyfin', token: 't', userId: own, serverKind: 'aiostreams' })
    assert.deepEqual(await provider.controllableSessions(), [])
    await assert.rejects(provider.playOn('e1271701-tv', item), (e) => e.status === 400)
    assert.deepEqual(aio.calls, [])
  } finally {
    aio.restore()
  }

  // A real Jellyfin is unchanged: its own ControllableByUserId answer, no version check.
  const jf = fakeServer({ '/Sessions?': () => sessions, '/Playing': () => ({}) })
  try {
    const provider = createJellyfinProvider({ serverUrl: 'https://jf.test', token: 't', userId: own, serverKind: 'jellyfin' })
    assert.deepEqual((await provider.controllableSessions()).map((d) => d.id), ['e1271701-tv', '2fc8a50e-tab'])
    assert.ok(!jf.calls.some((c) => c.includes('/System/Info')))
  } finally {
    jf.restore()
  }
})
