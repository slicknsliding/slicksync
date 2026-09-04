const express = require('express')

// Anime endpoints, backed by AniList (utils/anilist.js).
//
// Read-only and key-free: AniList's public GraphQL API needs no credentials,
// so nothing here spends anyone's quota or needs a Settings field. Every
// handler degrades to an empty/null answer rather than an error, because
// anime metadata is strictly additive - Cinemeta still provides the base
// record, and a bad day at AniList must never break a page.

module.exports = ({ getAccountId }) => {
  const router = express.Router()

  // This season's airing anime - the seasonal chart row.
  router.get('/seasonal', async (req, res) => {
    try {
      const { getSeasonalAnime, nextEpisodeCountdown } = require('../utils/anilist')
      const media = await getSeasonalAnime({
        season: typeof req.query.season === 'string' ? req.query.season.toUpperCase() : undefined,
        seasonYear: Number.isFinite(Number(req.query.year)) ? Number(req.query.year) : undefined,
        perPage: 40,
      })
      res.json({
        items: media.map((m) => ({
          anilistId: m.id,
          name: m.title?.english || m.title?.romaji || m.title?.native,
          poster: m.coverImage?.large || null,
          episodes: m.episodes ?? null,
          format: m.format || null,
          status: m.status || null,
          score: Number.isFinite(m.averageScore) ? m.averageScore : null,
          genres: Array.isArray(m.genres) ? m.genres.slice(0, 4) : [],
          nextEpisode: nextEpisodeCountdown(m),
          siteUrl: m.siteUrl || null,
        })),
      })
    } catch (e) {
      res.json({ items: [] })
    }
  })

  // Title lookup - used to attach anime data to a title the rest of the app
  // already knows about through Cinemeta.
  router.get('/lookup', async (req, res) => {
    try {
      const { searchAnime, nextEpisodeCountdown } = require('../utils/anilist')
      const title = String(req.query.title || '').trim()
      if (!title) return res.status(400).json({ error: 'title is required' })
      const year = Number.isFinite(Number(req.query.year)) ? Number(req.query.year) : undefined
      const media = await searchAnime(title, year)
      if (!media) return res.json({ found: false })
      res.json({
        found: true,
        anilistId: media.id,
        malId: media.idMal ?? null,
        name: media.title?.english || media.title?.romaji,
        episodes: media.episodes ?? null,
        status: media.status || null,
        nextEpisode: nextEpisodeCountdown(media),
        siteUrl: media.siteUrl || null,
      })
    } catch {
      res.json({ found: false })
    }
  })

  // Franchise watch order: the prequel/sequel line, with side stories and
  // movies kept separate rather than interleaved on a guess.
  router.get('/:anilistId/watch-order', async (req, res) => {
    try {
      const { getWatchOrder } = require('../utils/anilist')
      const order = await getWatchOrder(req.params.anilistId)
      if (!order) return res.status(404).json({ error: 'Not found on AniList' })
      const shape = (m) => ({
        anilistId: m.id,
        name: m.title?.english || m.title?.romaji,
        episodes: m.episodes ?? null,
        year: m.seasonYear ?? null,
        format: m.format || null,
      })
      res.json({
        mainLine: order.mainLine.map(shape),
        sideStories: order.sideStories.map(shape),
        movies: order.movies.map(shape),
      })
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Failed to build a watch order' })
    }
  })

  // Absolute -> season/episode. Answers null rather than guessing when the
  // chain's episode counts aren't known, since a wrong answer would put
  // someone's progress on the wrong episode.
  router.get('/:anilistId/episode', async (req, res) => {
    try {
      const { resolveAbsoluteEpisode } = require('../utils/anilist')
      const absolute = Number(req.query.absolute)
      const resolved = await resolveAbsoluteEpisode(req.params.anilistId, absolute)
      res.json({ resolved: resolved || null })
    } catch {
      res.json({ resolved: null })
    }
  })

  return router
}
