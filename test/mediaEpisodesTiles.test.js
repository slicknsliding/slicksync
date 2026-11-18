// The details window's episode tiles: the episode list carries each episode's
// picture and summary, the show's usual length and where someone here stopped
// partway through; each episode's own length comes from TMDb only with a key.
// Made-up show id, titles and key.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const makeUsersRouter = require('../server/routes/users')

const SHOW = 'tt0000123'
const MIN = 60 * 1000
const realFetch = globalThis.fetch

const meta = {
  meta: {
    id: SHOW, type: 'series', name: 'Made-up Show', runtime: '41 min',
    videos: [
      { id: `${SHOW}:0:1`, season: 0, episode: 1, title: 'A special', released: '2026-09-01T00:00:00.000Z' },
      ...[1, 2, 3, 4, 5].map((n) => ({
        id: `${SHOW}:3:${n}`, season: 3, episode: n, title: `Episode title ${n}`, released: `2026-10-0${n}T00:00:00.000Z`,
        overview: `What happens in episode ${n}.`, thumbnail: `https://pictures.example/${n}.jpg`,
      })),
    ],
  },
}

function stubFetch(t, answer) {
  const seen = []
  globalThis.fetch = async (url) => { seen.push(String(url)); return answer(String(url)) }
  t.after(() => { globalThis.fetch = realFetch })
  return seen
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function serve(t, { sync = {}, sessions = [] } = {}) {
  const prisma = {
    appAccount: { findUnique: async () => ({ sync: JSON.stringify(sync) }), findFirst: async () => ({ sync: JSON.stringify(sync) }) },
    episodeWatchHistory: { findMany: async () => [{ season: 3, episode: 1 }, { season: 3, episode: 2 }] },
    watchSession: { findMany: async () => sessions },
  }
  const app = express()
  const pass = (v) => v
  app.use('/api/users', makeUsersRouter({ prisma, getAccountId: () => 'acc-1', decrypt: pass, encrypt: pass }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }))
  const base = `http://127.0.0.1:${server.address().port}/api/users`
  return async (path) => { const r = await realFetch(base + path); return { status: r.status, body: await r.json() } }
}

test('the episode list brings pictures, summaries, the usual length and the resume spot', async (t) => {
  stubFetch(t, (url) => (url.includes('/meta/series/') ? json(meta) : json({}, 404)))
  const get = await serve(t, {
    sessions: [
      // Newest first: episode 2 is watched already, so episode 4 is the spot.
      { videoId: `${SHOW}:3:2`, lastPosition: 10 * MIN, totalDuration: 41 * MIN },
      { videoId: `${SHOW}:3:4`, lastPosition: 23 * MIN, totalDuration: 41 * MIN },
    ],
  })
  const { status, body } = await get(`/media-episodes?itemId=${SHOW}`)
  assert.equal(status, 200)
  assert.equal(body.runtime, 41)
  assert.deepEqual(body.seasons.map((s) => s.season), [3], 'specials stay out')
  const e1 = body.seasons[0].episodes[0]
  assert.equal(e1.thumbnail, 'https://pictures.example/1.jpg')
  assert.equal(e1.overview, 'What happens in episode 1.')
  assert.equal(e1.watched, true)
  assert.deepEqual(body.resume, { season: 3, episode: 4, progressPercent: 56, remainingMinutes: 18 })
})

test('no resume spot when nobody stopped partway, or only near the end', async (t) => {
  stubFetch(t, (url) => (url.includes('/meta/series/') ? json(meta) : json({}, 404)))
  const get = await serve(t, { sessions: [{ videoId: `${SHOW}:3:4`, lastPosition: 40 * MIN, totalDuration: 41 * MIN }] })
  const { body } = await get(`/media-episodes?itemId=${SHOW}`)
  assert.equal(body.resume, null)
})

test("each episode's own length needs a TMDb key, and comes from TMDb's season", async (t) => {
  const prevEnv = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  t.after(() => { if (prevEnv === undefined) delete process.env.TMDB_API_KEY; else process.env.TMDB_API_KEY = prevEnv })

  const seen = stubFetch(t, (url) => {
    if (url.includes('/find/')) return json({ tv_results: [{ id: 777 }] })
    if (url.includes('/tv/777/season/3')) return json({ episodes: [{ episode_number: 1, runtime: 43 }, { episode_number: 2, runtime: 0 }, { episode_number: 3, runtime: 39 }] })
    return json({}, 404)
  })
  const without = await (await serve(t))(`/media-episodes/lengths?itemId=${SHOW}&season=3`)
  assert.deepEqual(without.body, { lengths: {} })
  assert.equal(seen.length, 0, 'no TMDb call without a key')

  const withKey = await (await serve(t, { sync: { tmdbApiKey: 'made-up-key' } }))(`/media-episodes/lengths?itemId=${SHOW}&season=3`)
  assert.deepEqual(withKey.body, { lengths: { 1: 43, 3: 39 } })

  const bad = await (await serve(t))(`/media-episodes/lengths?itemId=nope&season=3`)
  assert.equal(bad.status, 400)
})
