const test = require('node:test')
const assert = require('node:assert/strict')
const { searchCinemetaPosterByTitle } = require('../server/utils/libraryHelpers')

// Swap global.fetch for a stub that returns the given metas array.
function withStubbedFetch(metas, fn, { ok = true } = {}) {
  const original = global.fetch
  global.fetch = async () => ({ ok, json: async () => ({ metas }) })
  return (async () => {
    try { return await fn() } finally { global.fetch = original }
  })()
}

test('searchCinemetaPosterByTitle: exact title + matching year returns the poster and id', async () => {
  await withStubbedFetch(
    [{ name: 'Simpsley', releaseInfo: '2026', poster: 'https://p/simpsley.jpg', id: 'tt9999999', type: 'movie' }],
    async () => {
      const r = await searchCinemetaPosterByTitle('Simpsley', '2026', 'movie')
      assert.deepEqual(r, { poster: 'https://p/simpsley.jpg', id: 'tt9999999', type: 'movie' })
    }
  )
})

test('searchCinemetaPosterByTitle: matching title but wrong year returns null (correct-or-nothing)', async () => {
  await withStubbedFetch(
    [{ name: 'Send Help', releaseInfo: '2019', poster: 'https://p/wrong.jpg', id: 'tt1', type: 'movie' }],
    async () => {
      // The user wanted the 2026 "Send Help"; a 2019 same-title movie must not be used.
      const r = await searchCinemetaPosterByTitle('Send Help', '2026', 'movie')
      assert.equal(r, null)
    }
  )
})

test('searchCinemetaPosterByTitle: different title returns null even if year matches', async () => {
  await withStubbedFetch(
    [{ name: 'Send Help Now', releaseInfo: '2026', poster: 'https://p/x.jpg', id: 'tt2', type: 'movie' }],
    async () => {
      const r = await searchCinemetaPosterByTitle('Send Help', '2026', 'movie')
      assert.equal(r, null)
    }
  )
})

test('searchCinemetaPosterByTitle: year required but candidate has no year returns null', async () => {
  await withStubbedFetch(
    [{ name: 'Simpsley', poster: 'https://p/x.jpg', id: 'tt3', type: 'movie' }],
    async () => {
      const r = await searchCinemetaPosterByTitle('Simpsley', '2026', 'movie')
      assert.equal(r, null)
    }
  )
})

test('searchCinemetaPosterByTitle: no year supplied (series) falls back to exact-title match', async () => {
  await withStubbedFetch(
    [{ name: 'Chernobyl', releaseInfo: '2019', poster: 'https://p/chern.jpg', id: 'tt7366338', type: 'series' }],
    async () => {
      const r = await searchCinemetaPosterByTitle('Chernobyl', null, 'series')
      assert.equal(r.id, 'tt7366338')
      assert.equal(r.poster, 'https://p/chern.jpg')
    }
  )
})

test('searchCinemetaPosterByTitle: picks the correct year among multiple same-title candidates', async () => {
  await withStubbedFetch(
    [
      { name: 'Send Help', releaseInfo: '2019', poster: 'https://p/2019.jpg', id: 'tt-old', type: 'movie' },
      { name: 'Send Help', releaseInfo: '2026', poster: 'https://p/2026.jpg', id: 'tt-new', type: 'movie' },
    ],
    async () => {
      const r = await searchCinemetaPosterByTitle('Send Help', '2026', 'movie')
      assert.equal(r.id, 'tt-new')
      assert.equal(r.poster, 'https://p/2026.jpg')
    }
  )
})

test('searchCinemetaPosterByTitle: a non-OK HTTP response returns null', async () => {
  await withStubbedFetch([], async () => {
    const r = await searchCinemetaPosterByTitle('Anything', '2026', 'movie')
    assert.equal(r, null)
  }, { ok: false })
})
