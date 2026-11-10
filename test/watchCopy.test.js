// Copy watch history (server/utils/watchCopy): Stremio's watched bits, the
// never-backwards plan, each provider's write and undo, and a whole run.
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const bits = require('../server/utils/watchCopy/stremioWatched')
const { plan, planTitle } = require('../server/utils/watchCopy/plan')
const { ADAPTERS, forgetForTests } = require('../server/utils/watchCopy/adapters')
const watchCopy = require('../server/utils/watchCopy')

const SHOW = 'tt25274446'
const videos = (show, seasons) => seasons.flatMap(([s, n]) => Array.from({ length: n }, (_, i) => ({ id: `${show}:${s}:${i + 1}`, season: s, episode: i + 1 })))

function title(id, type, extra = {}) {
  return { id, type, name: id, poster: null, watchedAt: null, episodes: new Map(), resume: null, inLibrary: false, lastActivity: 1000, ...extra }
}

test('reads a real Stremio watched field: S1 1-9 and S2 1-5', () => {
  const ids = bits.orderVideos(videos(SHOW, [[1, 9], [2, 8]]))
  const watched = bits.readWatched(`${SHOW}:2:5:14:eJz7b8/AAAAEvQE/`, ids)
  assert.equal(watched.size, 14)
  assert.ok(watched.has(`${SHOW}:2:5`))
  assert.ok(!watched.has(`${SHOW}:2:6`))
})

test('a written field reads back the same, and survives a special added in front', () => {
  const ids = bits.orderVideos(videos(SHOW, [[1, 9], [2, 8]]))
  const want = new Set([`${SHOW}:1:1`, `${SHOW}:1:3`, `${SHOW}:2:2`])
  const field = bits.writeWatched(want, ids)
  assert.match(field, new RegExp(`^${SHOW}:2:2:11:`))
  assert.deepEqual([...bits.readWatched(field, ids)].sort(), [...want].sort())
  // Cinemeta later lists a special (season 0 sorts first): the anchor shifts the bits.
  const withSpecial = bits.orderVideos([{ id: `${SHOW}:0:1`, season: 0, episode: 1 }, ...videos(SHOW, [[1, 9], [2, 8]])])
  assert.deepEqual([...bits.readWatched(field, withSpecial)].sort(), [...want].sort())
})

test('bits are least-significant first, as stremio-core packs them', () => {
  const ids = ['a:1:1', 'a:1:2', 'a:1:3']
  const field = bits.writeWatched(['a:1:1', 'a:1:3'], ids)
  const packed = field.split(':').pop()
  assert.deepEqual([...zlib.inflateSync(Buffer.from(packed, 'base64'))], [0b101])
})

test('nothing watched writes no field', () => {
  assert.equal(bits.writeWatched([], ['a:1:1']), null)
})

test('plan: copies what is missing, keeps what is further along, never goes back', () => {
  const src = new Map([
    ['tt1', title('tt1', 'movie', { watchedAt: 5 })],
    ['tt2', title('tt2', 'series', { episodes: new Map([['1:1', 1], ['1:2', 2]]), resume: { season: 1, episode: 3, position: 600000, duration: 2400000, at: 3 } })],
    ['tt3', title('tt3', 'movie', { resume: { position: 100000, duration: 6000000, at: 4 } })],
    ['tt4', title('tt4', 'movie', { watchedAt: 9 })],
  ])
  const dst = new Map([
    ['tt2', title('tt2', 'series', { episodes: new Map([['1:1', 1]]) })],
    ['tt3', title('tt3', 'movie', { watchedAt: 7 })],
    ['tt4', title('tt4', 'movie', { watchedAt: 8 })],
  ])
  const out = plan(src, dst, {})
  const by = Object.fromEntries(out.items.map((i) => [i.key, i]))
  assert.equal(by.tt1.outcome, 'copy')
  assert.deepEqual(by.tt1.changes.markWatched, { at: 5 })
  assert.equal(by.tt2.outcome, 'copy')
  assert.deepEqual(by.tt2.changes.addEpisodes, [{ season: 1, episode: 2, at: 2 }])
  assert.equal(by.tt2.changes.resume.episode, 3)
  assert.equal(by.tt3.outcome, 'further')
  assert.equal(by.tt4.outcome, 'there')
  assert.deepEqual(out.totals, { found: 4, copy: 2, there: 1, further: 1, match: 0, missing: 0 })
})

test('plan: a resume point behind the destination is kept', () => {
  const src = title('tt2', 'series', { resume: { season: 1, episode: 2, position: 1, duration: 10, at: 1 } })
  const dst = title('tt2', 'series', { episodes: new Map([['1:4', 1]]) })
  assert.equal(planTitle(src, dst, {}).outcome, 'further')
})

test('plan: the same state on both sides is "already there", not "further along"', () => {
  const same = () => title('tt2', 'series', { episodes: new Map([['1:1', 1], ['1:8', 2]]), resume: { season: 1, episode: 3, position: 5, duration: 10, at: 1 } })
  assert.equal(planTitle(same(), same(), {}).outcome, 'there')
  const playing = () => title('tt3', 'series', { resume: { season: 2, episode: 1, position: 5, duration: 10, at: 1 } })
  assert.equal(planTitle(playing(), playing(), {}).outcome, 'there')
  const film = () => title('tt4', 'movie', { resume: { position: 5, duration: 100, at: 1 } })
  assert.equal(planTitle(film(), film(), {}).outcome, 'there')
})

test('plan: whole-show marks (Nuvio, live channels) copy', () => {
  const src = title('streamed:x', 'series', { watchedAt: 9 })
  assert.deepEqual(planTitle(src, null, {}).changes, { markWatched: { at: 9 } })
  assert.equal(planTitle(src, title('streamed:x', 'series', { watchedAt: 1 }), {}).outcome, 'there')
})

test('plan: with resume points off, a title that only has one is left out (not "already there")', () => {
  const src = new Map([
    ['tt1', title('tt1', 'movie', { resume: { position: 5, duration: 100, at: 1 } })],
    ['tt2', title('tt2', 'movie', { watchedAt: 3 })],
  ])
  const out = plan(src, new Map(), { resume: false })
  assert.deepEqual(out.items.map((i) => [i.key, i.outcome]), [['tt2', 'copy']])
})

test('plan: "Since" leaves older history out, and titles with no id need a match', () => {
  const src = new Map([
    ['tt1', title('tt1', 'movie', { watchedAt: 50, lastActivity: 50 })],
    ['tt2', title('tt2', 'movie', { watchedAt: 500, lastActivity: 500 })],
    ['name:x', title(null, 'movie', { name: 'X', watchedAt: 600, lastActivity: 600 })],
  ])
  const out = plan(src, new Map(), { sinceMs: 100 })
  assert.deepEqual(out.items.map((i) => [i.key, i.outcome]), [['name:x', 'match'], ['tt2', 'copy']])
})

test('plan: a real Jellyfin missing the title says so instead of copying', () => {
  const src = new Map([['tt1', title('tt1', 'movie', { watchedAt: 1 })]])
  const out = plan(src, new Map(), {}, { isPresent: () => false })
  assert.equal(out.items[0].outcome, 'missing')
})

test('Stremio write: marks episodes in the packed field and a movie watched; undo puts it back', async () => {
  forgetForTests()
  const fetch = async () => ({ ok: true, json: async () => ({ meta: { videos: videos(SHOW, [[1, 3]]) } }) })
  const library = [{ _id: SHOW, type: 'series', name: 'Show', removed: false, temp: false, _mtime: 'old', state: { watched: null, lastWatched: '2026-01-01T00:00:00Z' } }]
  const puts = []
  const provider = {
    getLibrary: async () => library,
    addLibraryItem: async (changes) => {
      puts.push(...changes)
      for (const c of changes) { const i = library.findIndex((x) => x._id === c._id); if (i >= 0) library[i] = c; else library.push(c) }
    },
  }
  const read = await ADAPTERS.stremio.read(provider, null, { fetch })
  const items = [
    { key: SHOW, id: SHOW, type: 'series', name: 'Show', changes: { addEpisodes: [{ season: 1, episode: 1, at: 0 }, { season: 1, episode: 2, at: 0 }] } },
    { key: 'tt9', id: 'tt9', type: 'movie', name: 'Film', changes: { markWatched: { at: Date.parse('2026-02-01T00:00:00Z') } } },
  ]
  const result = await ADAPTERS.stremio.write(provider, read, items, { fetch, now: Date.parse('2026-03-01T00:00:00Z') })
  assert.equal(result.written, 2)
  const show = library.find((x) => x._id === SHOW)
  assert.deepEqual([...bits.readWatched(show.state.watched, bits.orderVideos(videos(SHOW, [[1, 3]])))].sort(), [`${SHOW}:1:1`, `${SHOW}:1:2`])
  const film = library.find((x) => x._id === 'tt9')
  assert.equal(film.state.flaggedWatched, 1)
  assert.equal(film.removed, true) // history only - not added to their library
  const undone = await ADAPTERS.stremio.undo(provider, result.undo, { now: Date.parse('2026-03-02T00:00:00Z') })
  assert.equal(undone.restored, 2)
  assert.equal(library.find((x) => x._id === SHOW).state.watched, null)
  assert.equal(library.find((x) => x._id === 'tt9').state.flaggedWatched, 0)
  // Stremio has no delete: the item the copy made is left as type "other", which every Stremio app skips.
  assert.equal(library.find((x) => x._id === 'tt9').type, 'other')
  assert.equal(library.find((x) => x._id === SHOW).type, 'series', 'an item that existed before keeps its own type')
  // Copying that title again writes a normal item over it.
  const read2 = await ADAPTERS.stremio.read(provider, null, { fetch })
  assert.equal(read2.state.has('tt9'), false)
  await ADAPTERS.stremio.write(provider, read2, [items[1]], { fetch, now: Date.parse('2026-03-03T00:00:00Z') })
  assert.equal(library.find((x) => x._id === 'tt9').type, 'movie')
  assert.equal(library.find((x) => x._id === 'tt9').state.flaggedWatched, 1)
})

test('Stremio undo leaves a title alone when it changed after the copy', async () => {
  const library = [{ _id: 'tt9', type: 'movie', _mtime: 'later', state: {} }]
  const provider = { getLibrary: async () => library, addLibraryItem: async () => { throw new Error('should not write') } }
  const r = await ADAPTERS.stremio.undo(provider, { items: [{ id: 'tt9', before: null, mtime: 'copy' }] })
  assert.deepEqual(r, { restored: 0, kept: 1 })
})

test('Nuvio: read per profile, write upserts with real dates, undo deletes by key', async () => {
  const calls = []
  const provider = {
    getWatchState: async (p) => ({
      watched: [{ content_id: 'tt5', content_type: 'series', title: 'Show', season: 1, episode: 1, watched_at: 10 }],
      progress: [{ content_id: 'tt6', content_type: 'movie', video_id: 'tt6', position: 1000, duration: 10000, last_watched: 20 }],
      library: [{ content_id: 'tt7', content_type: 'movie', name: 'Saved' }],
      profile: p,
    }),
    pushWatchedItems: async (p, items) => calls.push(['watched', p, items]),
    pushWatchProgress: async (p, items) => calls.push(['progress', p, items]),
    pushLibraryItems: async (p, items) => calls.push(['library', p, items]),
    deleteWatchedItems: async (p, keys) => calls.push(['-watched', p, keys]),
    deleteWatchProgress: async (p, keys) => calls.push(['-progress', p, keys]),
    deleteLibraryItems: async (p, keys) => calls.push(['-library', p, keys]),
  }
  const read = await ADAPTERS.nuvio.read(provider, '2')
  assert.equal(read.profileId, 2)
  assert.ok(read.state.get('tt5').episodes.has('1:1'))
  assert.equal(read.state.get('tt6').resume.position, 1000)
  assert.equal(read.state.get('tt7').inLibrary, true)
  const r = await ADAPTERS.nuvio.write(provider, read, [
    { key: 'tt5', id: 'tt5', type: 'series', name: 'Show', changes: { addEpisodes: [{ season: 1, episode: 2, at: 99 }], resume: { season: 1, episode: 3, position: 5, duration: 50, at: 100 } } },
    { key: 'tt8', id: 'tt8', type: 'movie', name: 'Film', changes: { markWatched: { at: 77 }, addLibrary: true } },
  ], { now: 1000 })
  const watched = calls.find((c) => c[0] === 'watched')
  assert.equal(watched[1], 2)
  assert.deepEqual(watched[2].map((w) => [w.content_id, w.season, w.episode, w.watched_at]), [['tt5', 1, 2, 99], ['tt8', null, null, 77]])
  const pushes = calls.filter((c) => c[0] === 'progress')
  assert.equal(pushes[0][2][0].progress_key, 'tt5_s1e3')
  assert.equal(pushes[0][2][0].last_watched, 100)
  // Nuvio refused it (it isn't there on read-back), so it goes again dated now.
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1][2][0].last_watched, 1000)
  await ADAPTERS.nuvio.undo(provider, r.undo)
  assert.deepEqual(calls.find((c) => c[0] === '-progress')[2], ['tt5_s1e3'])
  assert.deepEqual(calls.find((c) => c[0] === '-library')[2], [{ content_id: 'tt8', content_type: 'movie' }])
})

test('Jellyfin write: played on the real date per episode, a profile kept, undo unmarks', async () => {
  const calls = []
  const provider = {
    titleIndex: async () => null,
    findItem: async (id) => (id === 'tt5' ? 'series5' : id === 'tt8' ? 'movie8' : null),
    episodesOf: async () => [{ itemId: 'e1', season: 1, episode: 1 }, { itemId: 'e2', season: 1, episode: 2 }],
    setPlayedAt: async (id, at, profile) => calls.push(['played', id, at, profile]),
    setPosition: async (id, pos, profile) => calls.push(['pos', id, pos, profile]),
    setPlayed: async (id, played, profile) => calls.push(['unplayed', id, played, profile]),
  }
  const r = await ADAPTERS.jellyfin.write(provider, { profile: 'Sam' }, [
    { key: 'tt5', id: 'tt5', type: 'series', changes: { addEpisodes: [{ season: 1, episode: 2, at: 42 }], resume: { season: 1, episode: 1, position: 9, at: 1 } } },
    { key: 'tt8', id: 'tt8', type: 'movie', changes: { markWatched: { at: 7 } } },
    { key: 'tt0', id: 'tt0', type: 'movie', changes: { markWatched: { at: 7 } } },
  ])
  assert.ok(calls.some((c) => c[0] === 'played' && c[1] === 'e2' && c[2] === 42 && c[3] === 'Sam'))
  assert.ok(calls.some((c) => c[0] === 'played' && c[1] === 'movie8'))
  assert.ok(calls.some((c) => c[0] === 'pos' && c[1] === 'e1' && c[2] === 9))
  assert.deepEqual(r.failed.map((f) => f.key), ['tt0'])
  await ADAPTERS.jellyfin.undo(provider, r.undo)
  assert.ok(calls.some((c) => c[0] === 'unplayed' && c[1] === 'e2' && c[2] === false && c[3] === 'Sam'))
})

test('another person can be either side: "<id>|<side>", scoped to the account', async () => {
  watchCopy.forgetForTests()
  const people = {
    u1: { id: 'u1', accountId: 'acc', username: 'Chris', providerType: 'nuvio', nuvioRefreshToken: 'r', nuvioUserId: 'n', nuvioProfileId: 1 },
    u2: { id: 'u2', accountId: 'acc', username: 'Sam', providerType: 'stremio', stremioAuthKey: 'k' },
    x9: { id: 'x9', accountId: 'other', username: 'Stranger', providerType: 'stremio', stremioAuthKey: 'k' },
  }
  const library = []
  const stremioProvider = { getLibrary: async () => library, addLibraryItem: async (c) => library.push(...c) }
  const nuvioProvider = { getWatchState: async () => ({ watched: [{ content_id: 'tt8', content_type: 'movie', title: 'Film', watched_at: 5 }], progress: [], library: [] }) }
  const runs = []
  const prisma = {
    user: {
      findFirst: async ({ where }) => { const u = people[where.id]; return u && u.accountId === where.accountId ? u : null },
      findMany: async ({ where }) => Object.values(people).filter((u) => u.accountId === where.accountId && u.id !== where.id.not),
    },
    userProviderCredential: { findMany: async () => [] },
    watchCopyRun: { create: async ({ data }) => { const r = { id: 'r1', state: 'done', createdAt: new Date(), ...data }; runs.push(r); return r } },
  }
  const deps = { createProvider: (row) => (row.providerType === 'nuvio' ? nuvioProvider : stremioProvider), decrypt: (t) => t, wait: true }
  const others = await watchCopy.others(prisma, 'acc', 'u1')
  assert.deepEqual(others.map((o) => [o.side, o.name, o.person.username]), [['u2|stremio', 'Stremio', 'Sam']])
  const job = await watchCopy.run(prisma, deps, 'acc', 'u1', { from: 'nuvio:1', to: 'u2|stremio' })
  assert.equal(job.state, 'done')
  assert.equal(library[0]._id, 'tt8')
  assert.equal(runs[0].toSide, 'u2|stremio')
  // Someone from another account is never reachable.
  await assert.rejects(watchCopy.preview(prisma, deps, 'acc', 'u1', { from: 'x9|stremio', to: 'nuvio:1' }), /Person not found/)
})

test('Jellyfin read: a title with no ids keeps what was watched, so it can be matched', async () => {
  const provider = { watchState: async () => [
    { itemId: 'a', type: 'movie', id: null, name: 'Mystery Film', played: true, playedAt: 7, positionMs: 0 },
    { itemId: 'b', type: 'episode', id: null, seriesName: 'Mystery Show', season: 1, episode: 2, played: true, playedAt: 8, positionMs: 0 },
  ] }
  const { state } = await ADAPTERS.jellyfin.read(provider, null)
  assert.equal(state.get('name:mystery film').watchedAt, 7)
  assert.ok(state.get('name:mystery show').episodes.has('1:2'))
  const out = plan(state, new Map(), {})
  assert.deepEqual(out.items.map((i) => i.outcome), ['match', 'match'])
})

test('a sign-in that stopped working is named in plain words', async () => {
  const prisma = {
    user: { findFirst: async () => ({ id: 'u1', accountId: 'acc', username: 'Mia', providerType: 'nuvio', nuvioRefreshToken: 'r', nuvioUserId: 'n' }) },
    userProviderCredential: { findMany: async () => [{ id: 'c1', providerType: 'stremio', stremioAuthKey: 'k' }] },
  }
  const expired = Object.assign(new Error('Provider authentication expired'), { code: 'PROVIDER_AUTH_EXPIRED' })
  const deps = { createProvider: (row) => (row.providerType === 'nuvio' ? { getWatchState: async () => { throw expired } } : { getLibrary: async () => [] }) }
  await assert.rejects(watchCopy.preview(prisma, deps, 'acc', 'u1', { from: 'stremio', to: 'nuvio:1' }), /Mia’s Nuvio sign-in needs reconnecting/)
})

test('AIOStreams/AIOMetadata: finished = a dated stop at the runtime; refused writes are sent again', async () => {
  const calls = []
  let landed = false
  const provider = {
    serverKind: 'aiostreams',
    titleIndex: async () => null,
    findItem: async () => 'm1',
    runtimeMs: async () => 7200000,
    setPosition: async (id, pos, profile, at) => calls.push(['pos', id, pos, at]),
    setPlayedAt: async (id, at) => { calls.push(['played', id, at]); landed = true },
    watchState: async () => [{ itemId: 'm1', played: landed, positionMs: 0 }],
  }
  await ADAPTERS.jellyfin.write(provider, { profile: null }, [{ key: 'tt1', id: 'tt1', type: 'movie', changes: { markWatched: { at: 42 } } }])
  assert.deepEqual(calls[0], ['pos', 'm1', 7200000, 42])
  // The server kept the newer activity it had (not played): sent again, dated now.
  assert.deepEqual(calls[1], ['played', 'm1', null])
})

test('AIOMetadata: finished is marked played directly (it keeps no date and a stop at the end stays a resume point)', async () => {
  const calls = []
  const provider = {
    serverKind: 'aiometadata',
    titleIndex: async () => null,
    findItem: async () => 'm1',
    runtimeMs: async () => 7200000,
    setPosition: async (...a) => calls.push(['pos', ...a]),
    setPlayedAt: async (id, at) => calls.push(['played', id, at]),
    watchState: async () => [{ itemId: 'm1', played: true, positionMs: 0 }],
  }
  await ADAPTERS.jellyfin.write(provider, { profile: null }, [{ key: 'tt1', id: 'tt1', type: 'movie', changes: { markWatched: { at: 42 } } }])
  assert.deepEqual(calls, [['played', 'm1', 42]])
})

test('Jellyfin-type read: stopped in the last tenth counts as finished', async () => {
  const provider = { watchState: async () => [{ itemId: 'a', type: 'movie', id: 'tt1', name: 'Film', played: false, playedAt: 5, positionMs: 95, durationMs: 100 }] }
  const { state } = await ADAPTERS.jellyfin.read(provider, null)
  assert.equal(state.get('tt1').watchedAt, 5)
  assert.equal(state.get('tt1').resume, null)
})

test('a whole run: Nuvio profile to Stremio, saved for undo, then undone', async () => {
  watchCopy.forgetForTests()
  forgetForTests()
  const runs = []
  const library = []
  const stremioProvider = {
    getLibrary: async () => library,
    addLibraryItem: async (changes) => { for (const c of changes) { const i = library.findIndex((x) => x._id === c._id); if (i >= 0) library[i] = c; else library.push(c) } },
  }
  const nuvioProvider = {
    getProfiles: async () => [{ profile_index: 1, name: 'Living room' }, { profile_index: 2, name: 'Kids' }],
    getWatchState: async () => ({ watched: [{ content_id: 'tt8', content_type: 'movie', title: 'Film', watched_at: 5 }], progress: [], library: [] }),
  }
  const prisma = {
    user: { findFirst: async () => ({ id: 'u1', accountId: 'acc', username: 'Chris', email: 'chris@example.com', providerType: 'stremio', stremioAuthKey: 'k' }) },
    userProviderCredential: { findMany: async () => [{ id: 'c1', providerType: 'nuvio', nuvioRefreshToken: 'r', nuvioUserId: 'n' }] },
    watchCopyRun: {
      create: async ({ data }) => { const row = { id: 'run1', state: 'done', createdAt: new Date(), ...data }; runs.push(row); return row },
      findFirst: async ({ where }) => runs.find((r) => (!where.id || r.id === where.id) && (!where.state || r.state === where.state)) || null,
      update: async ({ where, data }) => Object.assign(runs.find((r) => r.id === where.id), data),
    },
  }
  const deps = { createProvider: (row) => (row.providerType === 'nuvio' ? nuvioProvider : stremioProvider), decrypt: (t) => t, wait: true }
  const sides = await watchCopy.sides(prisma, deps, 'acc', 'u1')
  assert.deepEqual(sides.map((s) => s.name), ['Stremio', 'Nuvio'])
  assert.equal(sides[0].detail, 'c***@e***.com')
  assert.deepEqual(sides[1].profiles.map((p) => p.side), ['nuvio:1', 'nuvio:2'])
  const pv = await watchCopy.preview(prisma, deps, 'acc', 'u1', { from: 'nuvio:2', to: 'stremio' })
  assert.equal(pv.totals.copy, 1)
  const job = await watchCopy.run(prisma, deps, 'acc', 'u1', { from: 'nuvio:2', to: 'stremio' })
  assert.equal(job.state, 'done')
  assert.equal(library[0].state.flaggedWatched, 1)
  const last = await watchCopy.lastRun(prisma, 'acc', 'u1')
  assert.equal(last.copied, 1)
  await watchCopy.undo(prisma, deps, 'acc', 'u1', 'run1')
  assert.equal(library[0].state.flaggedWatched, 0)
  assert.equal(runs[0].state, 'undone')
  await assert.rejects(watchCopy.undo(prisma, deps, 'acc', 'u1', 'run1'), /Nothing to undo/)
})

test('Nuvio undo: keeps what was watched after the copy, and puts an earlier resume point back', async () => {
  const COPY = Date.parse('2026-10-20T12:00:00Z')
  const calls = []
  let state = {
    watched: [],
    progress: [{ progress_key: 'tt5_s1e3', content_id: 'tt5', position: 100, duration: 2000, last_watched: COPY - 86400000 }],
    library: [],
  }
  const provider = {
    getWatchState: async () => state,
    pushWatchedItems: async (_p, rows) => calls.push(['watched', rows.length]),
    pushWatchProgress: async (_p, rows) => calls.push(['progress', rows.map((r) => [r.progress_key, r.position])]),
    pushLibraryItems: async () => {},
    deleteWatchedItems: async (_p, rows) => calls.push(['unwatch', rows]),
    deleteWatchProgress: async (_p, keys) => calls.push(['unprogress', keys]),
    deleteLibraryItems: async () => {},
  }
  const read = await ADAPTERS.nuvio.read(provider, 1)
  state = {
    ...state,
    progress: [{ progress_key: 'tt5_s1e3', content_id: 'tt5', position: 900, duration: 2000, last_watched: COPY }],
  }
  const r = await ADAPTERS.nuvio.write(provider, read, [
    { key: 'tt5', id: 'tt5', type: 'series', changes: { addEpisodes: [{ season: 1, episode: 1, at: 5 }, { season: 1, episode: 2, at: 5 }], resume: { season: 1, episode: 3, position: 900, duration: 2000, at: COPY } } },
  ], { now: COPY })
  // Afterwards they watch episode 2 again for real.
  state = { watched: [{ content_id: 'tt5', season: 1, episode: 1, watched_at: 5 }, { content_id: 'tt5', season: 1, episode: 2, watched_at: COPY + 3600000 }], progress: state.progress, library: [] }
  calls.length = 0
  const out = await ADAPTERS.nuvio.undo(provider, r.undo)
  assert.deepEqual(calls.find((c) => c[0] === 'unwatch')[1], [{ content_id: 'tt5', season: 1, episode: 1 }])
  assert.deepEqual(calls.find((c) => c[0] === 'progress')[1], [['tt5_s1e3', 100]], 'the resume point from before the copy is back')
  assert.equal(calls.some((c) => c[0] === 'unprogress'), false)
  assert.equal(out.kept, 1)
})

test('Jellyfin undo: played since the copy stays played, a resume point goes back to where it was', async () => {
  const COPY = Date.parse('2026-10-20T12:00:00Z')
  const calls = []
  let rows = [{ itemId: 'm2', type: 'movie', id: 'tt2', played: false, positionMs: 60000, durationMs: 6000000, playedAt: COPY - 86400000 }]
  const provider = {
    watchState: async () => rows,
    titleIndex: async () => null,
    findItem: async (id) => ({ tt1: 'm1', tt2: 'm2' }[id] || null),
    setPlayedAt: async () => {},
    setPosition: async (id, pos) => calls.push(['pos', id, pos]),
    setPlayed: async (id, played) => calls.push(['played', id, played]),
  }
  const read = await ADAPTERS.jellyfin.read(provider, null)
  const r = await ADAPTERS.jellyfin.write(provider, read, [
    { key: 'tt1', id: 'tt1', type: 'movie', changes: { markWatched: { at: 5 } } },
    { key: 'tt2', id: 'tt2', type: 'movie', changes: { resume: { position: 3000000, at: COPY } } },
  ], { now: COPY })
  rows = [
    { itemId: 'm1', played: true, playedAt: COPY + 7200000, positionMs: 0 },
    { itemId: 'm2', played: false, playedAt: COPY, positionMs: 3000000 },
  ]
  calls.length = 0
  const out = await ADAPTERS.jellyfin.undo(provider, r.undo)
  assert.equal(calls.some((c) => c[0] === 'played'), false, 'm1 was watched again after the copy')
  assert.deepEqual(calls, [['pos', 'm2', 60000]])
  assert.equal(out.kept, 1)
})

test('a double-tap starts one copy, not two', async () => {
  watchCopy.forgetForTests()
  require('../server/utils/watchCopy/locks').forgetForTests()
  let release
  const gate = new Promise((r) => { release = r })
  const people = { u1: { id: 'u1', accountId: 'acc', username: 'Chris', providerType: 'nuvio', nuvioRefreshToken: 'r', nuvioUserId: 'n', nuvioProfileId: 1 } }
  const nuvioProvider = {
    getWatchState: async (p) => { await gate; return p === 1 ? { watched: [{ content_id: 'tt8', content_type: 'movie', title: 'Film', watched_at: 5 }], progress: [], library: [] } : { watched: [], progress: [], library: [] } },
    pushWatchedItems: async () => {}, pushWatchProgress: async () => {}, pushLibraryItems: async () => {},
  }
  const prisma = {
    user: { findFirst: async ({ where }) => people[where.id] || null },
    userProviderCredential: { findMany: async () => [] },
    watchCopyRun: { create: async ({ data }) => ({ id: 'r1', ...data }) },
  }
  const deps = { createProvider: () => nuvioProvider, decrypt: (t) => t, wait: true }
  const first = watchCopy.run(prisma, deps, 'acc', 'u1', { from: 'nuvio:1', to: 'nuvio:2' })
  await assert.rejects(watchCopy.run(prisma, deps, 'acc', 'u1', { from: 'nuvio:1', to: 'nuvio:2' }), /Already copying/)
  release()
  const job = await first
  assert.equal(job.state, 'done')
  assert.equal(require('../server/utils/watchCopy/locks').holder('acc|u1|nuvio'), null, 'the sign-in is free again')
})

test('cards: each side says watched, part-way (with how far) or not yet', () => {
  const { describe } = require('../server/utils/watchCopy/plan')
  assert.equal(describe(null).state, 'none')
  assert.equal(describe(title('tt1', 'movie', { watchedAt: 5 })).state, 'watched')
  const part = describe(title('tt1', 'movie', { resume: { position: 30 * 60000, duration: 120 * 60000 } }))
  assert.deepEqual([part.state, part.pct], ['partial', 25])
  const show = title('tt2', 'series', { episodes: new Map([['1:1', 1], ['1:2', 2]]) })
  assert.equal(describe(show).state, 'watched')
  assert.equal(describe({ ...show, resume: { season: 1, episode: 3, position: 60000, duration: 0 } }).pct, undefined, 'no length, no ring amount')
})

test('cards: a copy names what is specific to it, a plain mark says nothing', () => {
  const src = title('tt3', 'series', { episodes: new Map([['1:1', 1], ['1:2', 2]]), resume: { season: 1, episode: 3, position: 73 * 60000, duration: 90 * 60000 } })
  const movie = title('tt4', 'movie', { resume: { position: 12 * 60000, duration: 100 * 60000 } })
  const watched = title('tt5', 'movie', { watchedAt: 9 })
  const r = plan(new Map([['a', src], ['b', movie], ['c', watched]]), new Map(), {})
  const by = Object.fromEntries(r.items.map((i) => [i.key, i.detail]))
  assert.equal(by.a, '2 episodes · S1 E3 from 1 h 13 m')
  assert.equal(by.b, 'from 12 m')
  assert.equal(by.c, null)
})

test('Jellyfin undo: what the server refuses is counted and kept for another try', async () => {
  const calls = []
  let refuse = true
  const provider = {
    setPlayed: async (id) => { if (refuse && id === 'e2') throw new Error('refused'); calls.push(id) },
    setPosition: async () => { throw new Error('refused') },
  }
  const record = { profile: 'Sam', played: ['e1', 'e2'], positions: [{ itemId: 'e3', before: 0, set: 9 }] }
  const out = await ADAPTERS.jellyfin.undo(provider, record)
  assert.equal(out.failed, 2)
  assert.equal(out.restored, 1)
  assert.deepEqual(out.remaining, { played: ['e2'], positions: [{ itemId: 'e3', before: 0, set: 9 }] })
  refuse = false
  const again = await ADAPTERS.jellyfin.undo({ ...provider, setPosition: async () => {} }, { ...record, ...out.remaining })
  assert.equal(again.failed, 0)
  assert.deepEqual(calls, ['e1', 'e2'])
})
