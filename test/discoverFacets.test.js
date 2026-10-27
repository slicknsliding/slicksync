// Discover's filters (server/utils/discoverFacets.js) and the facts on a
// person's page (server/utils/personFacts.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const f = require('../server/utils/discoverFacets')
const { personFacts, shortBiography } = require('../server/utils/personFacts')

const item = (id, releaseInfo, imdbRating, runtime) => ({ id, releaseInfo, imdbRating, runtime })

test('filters: only the ones asked for, and only real values', () => {
  assert.equal(f.parseFacets({}), null)
  assert.equal(f.parseFacets({ decade: '1950s', minRating: '11', length: 'huge' }), null)
  assert.deepEqual(f.parseFacets({ decade: '1990s', minRating: '7' }), { decade: '1990s', minRating: 7, length: null })
})

test('filters: decade, rating and length read what each title carries', () => {
  const nineties = item('a', '1994', '8.1', '154 min')
  assert.ok(f.matchesFacets(nineties, { decade: '1990s' }))
  assert.ok(!f.matchesFacets(nineties, { decade: '2000s' }))
  assert.ok(f.matchesFacets(item('b', '1972', '9', null), { decade: 'older' }))
  assert.ok(f.matchesFacets(nineties, { minRating: 8 }))
  assert.ok(!f.matchesFacets(item('c', '1994', '', '90 min'), { minRating: 6 }), 'no rating can not pass a rating filter')
  assert.ok(f.matchesFacets(nineties, { length: 'long' }))
  assert.ok(f.matchesFacets(item('d', '2001', '7', '1h 35min'), { length: 'mid' }))
  assert.ok(!f.matchesFacets(item('e', '2001', '7', null), { length: 'short' }), 'no runtime can not pass a length filter')
  assert.equal(f.yearOf(item('s', '2008–2013')), 2008)
})

test('a narrow filter reads ahead until it has a screenful, and says where it stopped', async () => {
  // 40 titles a page, one in ten from the 1990s.
  const pageFrom = async (at) => ({
    items: Array.from({ length: 40 }, (_, i) => item(`t${at + i}`, (at + i) % 10 === 0 ? '1995' : '2015', '7', '100 min')),
    cursor: at + 40,
  })
  const page = await f.filteredPage(pageFrom, 0, { decade: '1990s' })
  assert.ok(page.items.length >= f.FILTERED_TARGET)
  assert.equal(page.cursor, 40 * Math.ceil(f.FILTERED_TARGET / 4))
  assert.ok(page.items.every((i) => i.releaseInfo === '1995'))
})

test('reading ahead stops when the source stops moving', async () => {
  let calls = 0
  const stuck = async () => { calls++; return { items: [item('x', '2015', '7', '90 min')], cursor: 5 } }
  const page = await f.filteredPage(stuck, 5, { decade: '1990s' })
  assert.deepEqual(page, { items: [], cursor: 5 })
  assert.equal(calls, 1)
})

test('Both: movies and shows in turn, two positions in one cursor', async () => {
  const pageFor = async (type, at) => ({
    items: [item(`${type}${at}`, '2020'), item(`${type}${at + 1}`, '2020')],
    cursor: at + 2,
  })
  const first = await f.bothPage(pageFor, 0)
  assert.deepEqual(first.items.map((i) => i.id), ['movie0', 'series0', 'movie1', 'series1'])
  assert.equal(first.cursor, 2 * f.BOTH_SPLIT + 2)
  const second = await f.bothPage(pageFor, first.cursor)
  assert.deepEqual(second.items.map((i) => i.id), ['movie2', 'series2', 'movie3', 'series3'])
})

test('person card: what they do, born, and a short bio without Wikipedia asides', () => {
  const facts = personFacts({
    known_for_department: 'Acting',
    birthday: '1975-06-25',
    deathday: '',
    place_of_birth: 'Redwood City, California, USA',
    biography: 'Linda Edna Cardellini (/ˌkɑːrdəˈliːni/; born June 25, 1975) is an American actress. She is known for Freaks and Geeks (1999). She played Velma. She also did more.\n\nLater career detail.',
    combined_credits: { cast: [{}, {}], crew: [{ department: 'Production' }, { department: 'Production' }, { department: 'Production' }] },
  })
  assert.deepEqual(facts.knownFor, ['Acting', 'Producing'])
  assert.equal(facts.birthday, '1975-06-25')
  assert.equal(facts.deathday, null)
  assert.equal(facts.bio, 'Linda Edna Cardellini is an American actress. She is known for Freaks and Geeks (1999). She played Velma.')
  assert.equal(shortBiography('It made $15.4 billion worldwide. Then more.'), 'It made $15.4 billion worldwide. Then more.')
  assert.equal(shortBiography(''), null)
  const long = shortBiography(`Linda Cardellini is an American actress. ${'She is known for many roles on television and in film, '.repeat(8)}and more. Then this.`)
  assert.ok(long.startsWith('Linda Cardellini is an American actress. She is known'), 'a short opening takes the next sentence')
  assert.ok(long.endsWith('…') && long.length <= 340)
  assert.equal(
    shortBiography('Linda Edna Cardellini is an American actress.\n\nShe played Velma in Scooby-Doo. She was in Mad Men.\n\nFrom Wikipedia, the free encyclopedia'),
    'Linda Edna Cardellini is an American actress. She played Velma in Scooby-Doo. She was in Mad Men.',
  )
})

test('a title search keeps only the picked genre', () => {
  assert.ok(f.matchesGenre({ genres: ['Drama', 'Crime'] }, 'Crime'))
  assert.ok(f.matchesGenre({ genres: ['Science Fiction'] }, 'Sci-Fi'))
  assert.ok(f.matchesGenre({ genres: ['sci-fi'] }, 'Sci-Fi'))
  assert.ok(!f.matchesGenre({ genres: ['Comedy'] }, 'Crime'))
  assert.ok(!f.matchesGenre({}, 'Crime'))
  assert.ok(f.matchesGenre({}, ''))
})
