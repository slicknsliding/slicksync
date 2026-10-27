// A person's Home: recently watched folds back-to-back episodes of one show
// (server/utils/memberHome.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { recentlyWatchedGroups } = require('../server/utils/memberHome')

const at = (h) => new Date(Date.parse('2026-10-27T20:00:00Z') - h * 3600e3)
const prisma = (episodes, movies) => ({
  episodeWatchHistory: { findMany: async () => episodes },
  movieWatchHistory: { findMany: async () => movies },
})

test('episodes in a row become one entry with their range', async () => {
  const eps = [5, 4, 3, 2, 1].map((n, i) => ({ showId: 'tt1', itemName: 'Northern Lines', poster: null, season: 3, episode: n, watchedAt: at(i) }))
  const groups = await recentlyWatchedGroups(prisma(eps, [{ itemId: 'tt9', itemName: 'Glass Meridian', poster: null, watchedAt: at(10) }]), 'a', 'u')
  assert.equal(groups.length, 2)
  assert.deepEqual([groups[0].name, groups[0].season, groups[0].fromEpisode, groups[0].toEpisode, groups[0].count], ['Northern Lines', 3, 1, 5, 5])
  assert.equal(groups[1].type, 'movie')
})

test('a film between episodes splits the show; five entries at most', async () => {
  const eps = [{ showId: 'tt1', itemName: 'A', season: 1, episode: 2, watchedAt: at(0) }, { showId: 'tt1', itemName: 'A', season: 1, episode: 1, watchedAt: at(3) }]
  const movies = [{ itemId: 'tt9', itemName: 'M', watchedAt: at(1) }, ...[5, 6, 7, 8].map((h) => ({ itemId: 'tt' + h, itemName: 'M' + h, watchedAt: at(h) }))]
  const groups = await recentlyWatchedGroups(prisma(eps, movies), 'a', 'u')
  assert.equal(groups.length, 5)
  assert.deepEqual(groups.slice(0, 3).map((g) => g.name), ['A', 'M', 'A'])
})
