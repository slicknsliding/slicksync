const test = require('node:test')
const assert = require('node:assert/strict')
const age = require('../server/utils/ageLimits')

test('ratings map to the age they are for; anything else is unrated', () => {
  assert.equal(age.ageOfRating('TV-Y'), 0)
  assert.equal(age.ageOfRating('pg'), 10)
  assert.equal(age.ageOfRating('PG-13'), 13)
  assert.equal(age.ageOfRating('TV-MA'), 18)
  assert.equal(age.ageOfRating('Not Rated'), null)
  assert.equal(age.ageOfRating('N/A'), null)
  assert.equal(age.ageOfRating(null), null)
})

test('a stream request names its title by its IMDb id - episodes by their show', () => {
  assert.equal(age.imdbIdOf('stream/movie/tt0111161.json'), 'tt0111161')
  assert.equal(age.imdbIdOf('stream/series/tt0903747%3A1%3A2.json'), 'tt0903747')
  assert.equal(age.imdbIdOf('stream/series/tt0903747:1:2.json'), 'tt0903747')
  assert.equal(age.imdbIdOf('stream/anime/kitsu:1.json'), null)
  assert.equal(age.imdbIdOf('catalog/movie/top.json'), null)
})

test('only the levels offered can be stored', () => {
  assert.deepEqual(age.cleanAgeLimit({ maxAge: 13 }), { maxAge: 13 })
  assert.deepEqual(age.cleanAgeLimit({ maxAge: 10, blockUnrated: true }), { maxAge: 10, blockUnrated: true })
  assert.equal(age.cleanAgeLimit({ maxAge: 12 }), null)
  assert.equal(age.cleanAgeLimit(null), null)
})

test('up to PG: PG plays, PG-13 and R don\'t, an unrated title plays unless unrated ones are blocked', async () => {
  const rated = { tt1: 'PG', tt2: 'PG-13', tt3: 'R', tt4: 'Not Rated' }
  const deps = { ratingOf: async (id) => rated[id] || null }
  const limit = { maxAge: 10 }
  const may = (path, l = limit) => age.mayPlay(null, 'acc', l, path, deps)
  assert.equal(await may('stream/movie/tt1.json'), true)
  assert.equal(await may('stream/movie/tt2.json'), false)
  assert.equal(await may('stream/series/tt3:1:1.json'), false)
  assert.equal(await may('stream/movie/tt4.json'), true)
  assert.equal(await may('stream/anime/kitsu:9.json'), true, 'no IMDb id: unrated')
  assert.equal(await may('stream/movie/tt4.json', { maxAge: 10, blockUnrated: true }), false)
  assert.equal(await may('stream/anime/kitsu:9.json', { maxAge: 10, blockUnrated: true }), false)
  assert.equal(await age.mayPlay(null, 'acc', null, 'stream/movie/tt3.json', deps), true, 'no limit at all')
})

test('who an age limit belongs to: Jellyfin keeps its own, AIOStreams has none, the rest are SlickSync\'s', () => {
  assert.equal(age.sourceFor({ providerType: 'nuvio' }).source, 'streams')
  assert.equal(age.sourceFor({ providerType: 'stremio' }).source, 'streams')
  assert.equal(age.sourceFor({ providerType: 'jellyfin', jellyfinServerKind: 'jellyfin' }).source, 'jellyfin')
  assert.equal(age.sourceFor({ providerType: 'jellyfin', jellyfinServerKind: 'aiometadata' }).source, 'streams')
  assert.equal(age.sourceFor({ providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' }).source, null)
  assert.equal(age.sourceFor({ providerType: 'nuvio', subject: { kind: 'nuvio-profile', sharesPrimary: true } }).source, null, 'a profile on the main profile\'s addons')
})
