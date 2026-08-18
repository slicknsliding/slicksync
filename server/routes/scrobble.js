const express = require('express')

// Trakt-compatible scrobble API - lets third-party players that already
// know how to scrobble to Trakt (Infuse, Kodi's Trakt plugin, various VLC/
// mobile-player integrations) write into SlickTrax's history instead, by
// pointing their "custom Trakt server" base URL at this instance and using
// a SlickSync-issued per-user API key as the bearer token. Request bodies
// deliberately mirror Trakt's own real shape ({ movie: { ids: { imdb } } }
// or { show: { ids: { imdb } }, episode: { season, number } }, progress as
// a 0-100 percentage) so an app's existing Trakt integration needs no
// changes beyond the base URL and token.
//
// /start and /pause are ephemeral, matching Trakt's own semantics - they
// don't write history, just acknowledge (a player may call them many times
// per session as progress updates). Only /stop, when progress crosses the
// same 80% "counts as watched" threshold Trakt itself uses, actually writes
// a MovieWatchHistory/EpisodeWatchHistory row. This is a deliberately
// separate, simpler writer from metricsProcessor.js's recordMovieWatch/
// recordEpisodeWatch - those are tuned for continuous LIBRARY POLLING
// (inferring whether something is "actually watched" from partial,
// possibly-stale position data across many polls), which doesn't apply
// here: a scrobble stop is one discrete, explicit "I just finished this"
// event, not something to infer.
module.exports = ({ prisma }) => {
  const router = express.Router()

  const { createUserApiKeyMiddleware } = require('../middleware/userApiKey')
  router.use(createUserApiKeyMiddleware(prisma))
  // Scrobbling has no session-based fallback the way admin UI routes do -
  // the middleware above only sets req.appUserId on a valid key and
  // otherwise silently continues, so a missing/invalid key must be
  // rejected explicitly here rather than falling through to an
  // account-wide, no-specific-user write.
  router.use((req, res, next) => {
    if (!req.appUserId) return res.status(401).json({ error: 'invalid_grant', error_description: 'Missing or invalid API key' })
    next()
  })

  // Resolves the { movie: {...} } | { show: {...}, episode: {...} } body
  // shape into { itemId, itemType, season, episode, title } - itemId is
  // always the IMDb id (the one identifier every provider in this codebase
  // already keys on), even though Trakt's real API accepts tmdb/trakt/slug
  // ids too - imdb is required here, since that's the only id scheme the
  // rest of SlickSync's watch-tracking tables use.
  function resolveScrobbleTarget(body) {
    if (body?.movie?.ids?.imdb) {
      return { itemId: body.movie.ids.imdb, itemType: 'movie', title: body.movie.title || null, season: null, episode: null }
    }
    if (body?.show?.ids?.imdb && body?.episode) {
      const season = Number(body.episode.season)
      const episode = Number(body.episode.number)
      if (!Number.isFinite(season) || !Number.isFinite(episode)) return null
      return { itemId: body.show.ids.imdb, itemType: 'series', title: body.show.title || null, season, episode }
    }
    return null
  }

  async function handleEphemeral(req, res) {
    const target = resolveScrobbleTarget(req.body)
    if (!target || !/^tt\d+$/.test(target.itemId)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'movie.ids.imdb or show.ids.imdb + episode.season/number is required' })
    }
    const progress = Number(req.body?.progress)
    res.json({
      action: req.path.replace('/', ''),
      progress: Number.isFinite(progress) ? progress : 0,
      [target.itemType]: target.itemType === 'movie' ? req.body.movie : req.body.show,
    })
  }

  router.post('/start', handleEphemeral)
  router.post('/pause', handleEphemeral)

  const WATCHED_THRESHOLD_PERCENT = 80

  router.post('/stop', async (req, res) => {
    try {
      const target = resolveScrobbleTarget(req.body)
      if (!target || !/^tt\d+$/.test(target.itemId)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'movie.ids.imdb or show.ids.imdb + episode.season/number is required' })
      }
      const progress = Number(req.body?.progress)
      const accountId = req.appAccountId || 'default'
      const userId = req.appUserId
      const watched = Number.isFinite(progress) && progress >= WATCHED_THRESHOLD_PERCENT

      if (!watched) {
        return res.json({ action: 'stop', progress: Number.isFinite(progress) ? progress : 0, [target.itemType]: target.itemType === 'movie' ? req.body.movie : req.body.show })
      }

      const { fetchMetadata } = require('../utils/notify')
      const { resolveSinglePoster } = require('../utils/libraryHelpers')
      const { resolveOmdbKeyForAccount } = require('../utils/listImport')
      const omdbApiKey = await resolveOmdbKeyForAccount(prisma, accountId).catch(() => null)

      let title = target.title
      let poster = null
      let episodeName = null
      if (target.itemType === 'movie') {
        if (!title) {
          const meta = await fetchMetadata(target.itemId, 'movie', null, omdbApiKey).catch(() => null)
          title = meta?.title || null
        }
        if (!title) return res.status(422).json({ error: 'unprocessable', error_description: 'Could not resolve a title for this IMDb id' })
        poster = await resolveSinglePoster(target.itemId, 'movie', null)

        await prisma.movieWatchHistory.upsert({
          where: { accountId_userId_itemId: { accountId, userId, itemId: target.itemId } },
          create: { accountId, userId, itemId: target.itemId, itemName: title, poster, profileLabel: 'Scrobbled', completed: true, watchedAt: new Date() },
          update: { itemName: title, poster: poster || undefined, completed: true, watchedAt: new Date() },
        })
      } else {
        const videoId = `${target.itemId}:${target.season}:${target.episode}`
        if (!title) {
          const meta = await fetchMetadata(target.itemId, 'series', videoId, omdbApiKey).catch(() => null)
          title = meta?.title || null
          episodeName = meta?.episode?.title || null
        }
        if (!title) return res.status(422).json({ error: 'unprocessable', error_description: 'Could not resolve a title for this IMDb id' })
        poster = await resolveSinglePoster(target.itemId, 'series', null)

        await prisma.episodeWatchHistory.upsert({
          where: { accountId_userId_videoId: { accountId, userId, videoId } },
          create: { accountId, userId, showId: target.itemId, showName: title, videoId, season: target.season, episode: target.episode, episodeName, poster, profileLabel: 'Scrobbled', completed: true, watchedAt: new Date() },
          update: { showName: title, episodeName: episodeName || undefined, poster: poster || undefined, completed: true, watchedAt: new Date() },
        })
      }

      res.status(201).json({
        action: 'stop',
        progress,
        [target.itemType]: target.itemType === 'movie' ? req.body.movie : req.body.show,
      })
    } catch (error) {
      console.error('Error handling scrobble stop:', error)
      res.status(500).json({ error: 'server_error', error_description: 'Failed to record scrobble' })
    }
  })

  return router
}
