// "Caught up to here" (server/utils/catchUp.js): History only - never watch
// time - and the person's own server.
const test = require('node:test')
const assert = require('node:assert/strict')
const catchUp = require('../server/utils/catchUp')

const NOW = Date.parse('2026-10-05T12:00:00Z')

function world({ history = [] } = {}) {
  const episodes = [...history]
  const writes = { watchActivity: 0 }
  const prisma = {
    user: { findFirst: async ({ where }) => ({ id: where.id, username: 'Mia', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'jellyfin', jellyfinServerUrl: 'https://jf.example.com', jellyfinUserId: 'u', jellyfinToken: 'enc' }) },
    episodeWatchHistory: {
      findMany: async ({ where }) => episodes.filter((e) => !where.showId || e.showId === where.showId),
      findUnique: async ({ where }) => episodes.find((e) => e.videoId === where.accountId_userId_videoId.videoId) || null,
      upsert: async ({ where, create, update }) => {
        const row = episodes.find((e) => e.videoId === where.accountId_userId_videoId.videoId)
        if (row) { Object.assign(row, update); return row }
        episodes.push(create); return create
      },
      deleteMany: async ({ where }) => {
        const keep = episodes.filter((e) => !Object.entries(where).every(([k, v]) => k === 'accountId' || k === 'userId' || e[k] === v))
        const count = episodes.length - keep.length
        episodes.splice(0, episodes.length, ...keep)
        return { count }
      },
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const e of episodes) if (e.videoId === where.videoId) { Object.assign(e, data); count++ }
        return { count }
      },
    },
    watchActivity: { create: async () => { writes.watchActivity++ }, createMany: async () => { writes.watchActivity++ } },
  }
  return { prisma, episodes, writes }
}

// Cinemeta's list for a show: S1E1-3 aired, S1E4 next week, plus a special.
const meta = async () => ({
  title: 'Frieren',
  poster: 'https://images.example.com/frieren.jpg',
  allEpisodes: [
    { season: 1, episode: 1, title: 'One', released: '2026-01-01T00:00:00Z' },
    { season: 1, episode: 2, title: 'Two', released: '2026-01-08T00:00:00Z' },
    { season: 1, episode: 3, title: 'Three', released: '2026-01-15T00:00:00Z' },
    { season: 1, episode: 4, title: 'Four', released: '2026-10-12T00:00:00Z' },
  ],
})

function fakeProvider({ playedUpTo = false } = {}) {
  const calls = { setPlayed: [], playedUpTo: [] }
  const server = [
    { itemId: 'e1', season: 1, episode: 1, title: 'One', premiere: '2026-01-01', played: true },
    { itemId: 'e2', season: 1, episode: 2, title: 'Two', premiere: '2026-01-08', played: false },
    { itemId: 'e3', season: 1, episode: 3, title: 'Three', premiere: '2026-01-15', played: false },
    { itemId: 'e4', season: 1, episode: 4, title: 'Four', premiere: '2026-10-12', played: false },
  ]
  return {
    calls,
    createProvider: () => ({
      listEpisodes: async () => server,
      playedUpTo: async (id) => { calls.playedUpTo.push(id); return playedUpTo },
      setPlayed: async (id) => { calls.setPlayed.push(id) },
    }),
  }
}

test('marks every aired episode up to the chosen one - in History, never as watch time', async () => {
  catchUp.forgetForTests()
  const w = world({ history: [{ showId: 'tt1', videoId: 'tt1:1:1', season: 1, episode: 1, completed: true, showName: 'Frieren', episodeName: 'One' }] })
  const p = fakeProvider()
  const job = await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 4 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW, wait: true })
  assert.equal(job.state, 'done')
  assert.equal(job.total, 3, 'S1E4 hasn\'t aired yet')
  assert.equal(job.alreadyWatched, 1)
  assert.equal(job.recorded, 2)
  const added = w.episodes.filter((e) => e.profileLabel === 'Caught up')
  assert.deepEqual(added.map((e) => e.videoId), ['tt1:1:2', 'tt1:1:3'])
  assert.ok(added.every((e) => e.completed === true && e.episodeName && e.showName === 'Frieren'))
  assert.equal(w.writes.watchActivity, 0, 'no watch time')
  // Real Jellyfin: one "played" per episode it doesn't already have.
  assert.deepEqual(p.calls.setPlayed.sort(), ['e2', 'e3'])
  assert.deepEqual(job.server, { state: 'done', marked: 2, total: 2, how: 'each' })
})

test('AIOStreams with PlayedUpTo: one call for the lot', async () => {
  catchUp.forgetForTests()
  const w = world()
  const p = fakeProvider({ playedUpTo: true })
  const job = await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 3 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW, wait: true })
  assert.deepEqual(p.calls.playedUpTo, ['e3'])
  assert.deepEqual(p.calls.setPlayed, [])
  assert.equal(job.server.how, 'played-up-to')
})

test('refuses nonsense, and a second run while one is going', async () => {
  catchUp.forgetForTests()
  const w = world()
  const p = fakeProvider()
  await assert.rejects(catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 0, episode: 1 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW }), /Pick the episode/)
  const first = await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 2 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW })
  assert.equal(first.state, 'running')
  await assert.rejects(catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 3 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW }), /Already marking/)
})

test('a show Cinemeta doesn\'t know (anime, TMDb-only) is listed from their server', async () => {
  catchUp.forgetForTests()
  const w = world()
  const p = fakeProvider()
  const list = await catchUp.episodesFor(w.prisma, () => 'tok', 'acc', 'mia', 'tmdb:209867', { fetchMeta: async () => null, createProvider: p.createProvider })
  assert.deepEqual(list.episodes.map((e) => `${e.season}:${e.episode}`), ['1:1', '1:2', '1:3', '1:4'])
})

test('the show picker only offers shows whose episodes can be listed', async () => {
  catchUp.forgetForTests()
  const w = world({ history: [
    { showId: 'tt1', showName: 'Frieren', season: 1, episode: 2, poster: null },
    { showId: 'tt1', showName: 'Frieren', season: 1, episode: 1, poster: null },
    { showId: 'tt7000013', showName: 'Made-up show', season: 1, episode: 1, poster: null },
    { showId: 'tmdb:209867', showName: 'Not on Cinemeta', season: 1, episode: 4, poster: null },
  ] })
  const fetchMeta = async (id) => (id === 'tt1' ? meta() : null)

  // No server of their own: only what Cinemeta can list.
  const findFirst = w.prisma.user.findFirst
  w.prisma.user.findFirst = async ({ where }) => ({ id: where.id, accountId: 'acc', providerType: 'nuvio', jellyfinToken: null })
  const shows = await catchUp.showsFor(w.prisma, 'acc', 'mia', { fetchMeta })
  assert.deepEqual(shows.map((s) => s.id), ['tt1'], 'a show nothing can list is never offered')
  assert.equal(shows[0].poster, 'https://images.example.com/frieren.jpg', 'the poster comes from Cinemeta when History has none')
  assert.deepEqual(shows[0].last, { season: 1, episode: 2 }, 'the newest episode they watched')

  // Their own server can list any show, so everything is offered.
  w.prisma.user.findFirst = findFirst
  const withServer = await catchUp.showsFor(w.prisma, 'acc', 'mia', { fetchMeta })
  assert.deepEqual(withServer.map((s) => s.id), ['tt1', 'tt7000013', 'tmdb:209867'])
})

test('the picker looks past unlistable shows, and asks about each only once', async () => {
  catchUp.forgetForTests()
  // Thirty made-up shows watched most recently, then two real ones.
  const history = Array.from({ length: 30 }, (_, i) => ({ showId: `tt70000${String(i).padStart(2, '0')}`, showName: `Made-up ${i}`, season: 1, episode: 1, poster: null }))
  history.push({ showId: 'tt1', showName: 'Frieren', season: 1, episode: 3, poster: null }, { showId: 'tt2', showName: 'Dungeon Meshi', season: 1, episode: 1, poster: null })
  const w = world({ history })
  w.prisma.user.findFirst = async ({ where }) => ({ id: where.id, accountId: 'acc', providerType: 'nuvio', jellyfinToken: null })
  const asked = []
  const fetchMeta = async (id) => { asked.push(id); return id === 'tt1' || id === 'tt2' ? meta() : null }
  const shows = await catchUp.showsFor(w.prisma, 'acc', 'mia', { fetchMeta })
  assert.deepEqual(shows.map((s) => s.id), ['tt1', 'tt2'])
  assert.equal(asked.length, 32)
  asked.length = 0
  await catchUp.showsFor(w.prisma, 'acc', 'mia', { fetchMeta })
  assert.deepEqual(asked, ['tt1', 'tt2'], 'the made-up ones are remembered as unlistable')
})

test('Undo takes back exactly what the run added, here and on their server', async () => {
  catchUp.forgetForTests()
  // E1 already watched, E2 started but not finished, E3 never opened.
  const w = world({ history: [
    { showId: 'tt1', videoId: 'tt1:1:1', season: 1, episode: 1, completed: true, showName: 'Frieren' },
    { showId: 'tt1', videoId: 'tt1:1:2', season: 1, episode: 2, completed: false, showName: 'Frieren' },
  ] })
  const p = fakeProvider()
  const calls = []
  const createProvider = () => ({ ...p.createProvider(), setPlayed: async (id, played) => { calls.push([id, played]) } })
  const job = await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 3 }, { fetchMeta: meta, createProvider, now: NOW, wait: true })
  assert.equal(job.canUndo, true)
  assert.deepEqual(w.episodes.map((e) => [e.videoId, e.completed]), [['tt1:1:1', true], ['tt1:1:2', true], ['tt1:1:3', true]])
  assert.deepEqual(calls, [['e2', true], ['e3', true]])

  calls.length = 0
  const after = await catchUp.undo(w.prisma, () => 'tok', 'acc', 'mia', { createProvider, wait: true })
  assert.equal(after.state, 'undone')
  assert.equal(after.canUndo, false)
  assert.deepEqual(w.episodes.map((e) => [e.videoId, e.completed]), [['tt1:1:1', true], ['tt1:1:2', false]], 'E1 stays watched, E2 back to started, E3 gone')
  assert.deepEqual(calls.sort(), [['e2', false], ['e3', false]], 'only what the run marked is unmarked there')
  await assert.rejects(catchUp.undo(w.prisma, () => 'tok', 'acc', 'mia', { createProvider }), /Nothing to undo/)
})

test('one episode can be marked not watched again', async () => {
  catchUp.forgetForTests()
  const w = world({ history: [
    { showId: 'tt1', videoId: 'tt1:1:1', season: 1, episode: 1, completed: true, showName: 'Frieren' },
    { showId: 'tt1', videoId: 'tt1:1:2', season: 1, episode: 2, completed: true, showName: 'Frieren' },
  ] })
  const calls = []
  const createProvider = () => ({ ...fakeProvider().createProvider(), setPlayed: async (id, played) => { calls.push([id, played]) } })
  const result = await catchUp.unmark(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 2 }, { createProvider })
  assert.deepEqual(result, { removed: 1, server: 'done' })
  assert.deepEqual(w.episodes.map((e) => e.videoId), ['tt1:1:1'])
  assert.deepEqual(calls, [['e2', false]])
})

test('Done clears a finished run and its Undo; a run still going is left alone', async () => {
  catchUp.forgetForTests()
  const w = world({ history: [{ showId: 'tt1', videoId: 'tt1:1:1', season: 1, episode: 1, completed: true, showName: 'Frieren' }] })
  const p = fakeProvider()
  const running = await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 2 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW })
  assert.equal(running.state, 'running')
  assert.equal(catchUp.dismiss('mia').state, 'running', 'not cleared mid-run')

  catchUp.forgetForTests()
  await catchUp.start(w.prisma, () => 'tok', 'acc', 'mia', { showId: 'tt1', season: 1, episode: 3 }, { fetchMeta: meta, createProvider: p.createProvider, now: NOW, wait: true })
  assert.equal(catchUp.status('mia').canUndo, true)
  assert.equal(catchUp.dismiss('mia'), null)
  assert.equal(catchUp.status('mia'), null, 'gone at the next opening too')
  await assert.rejects(catchUp.undo(w.prisma, () => 'tok', 'acc', 'mia', { createProvider: p.createProvider }), /Nothing to undo/)
})

test('on AIOStreams, filler and recap episodes are marked as such in the list', async () => {
  const w = world()
  const base = w.prisma.user.findFirst
  w.prisma.user.findFirst = async (args) => ({ ...(await base(args)), jellyfinServerKind: 'aiostreams' })
  const server = [
    { itemId: 'e1', season: 1, episode: 1, played: false },
    { itemId: 'e2', season: 1, episode: 2, played: false, filler: true },
    { itemId: 'e3', season: 1, episode: 3, played: false, recap: true },
  ]
  const list = await catchUp.episodesFor(w.prisma, () => 'tok', 'acc', 'mia', 'tt1', { fetchMeta: meta, createProvider: () => ({ listEpisodes: async () => server }) })
  assert.deepEqual(list.episodes.map((e) => e.kind || null), [null, 'filler', 'recap', null])
  assert.equal(list.episodes[0].title, 'One', 'Cinemeta still gives the titles')
})
