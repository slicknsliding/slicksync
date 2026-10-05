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
      upsert: async ({ create }) => { episodes.push(create); return create },
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
