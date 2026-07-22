const express = require('express');
const { fetchCatalog } = require('../utils/discover');

// Discover - browse/search Cinemeta's real catalogs and preview results
// through the same MediaDetailModal used elsewhere. Mostly a stateless
// proxy to Cinemeta; the /recommendations endpoint added below is the one
// account-scoped read (reads watch history to seed suggestions), so this
// router now takes prisma + getAccountId.
module.exports = ({ prisma, getAccountId } = {}) => {
  const router = express.Router();

  // GET /api/discover/browse?type=movie|series&catalog=top|year|imdbRating&genre=X&skip=N
  router.get('/browse', async (req, res) => {
    try {
      const { type = 'movie', catalog = 'top', genre, skip } = req.query
      if (type !== 'movie' && type !== 'series') {
        return res.status(400).json({ error: 'type must be movie or series' })
      }
      const items = await fetchCatalog(type, {
        catalog,
        genre: genre || undefined,
        skip: skip ? Number(skip) : undefined
      })
      res.json(items)
    } catch (error) {
      console.error('Error fetching discover catalog:', error)
      res.status(500).json({ error: 'Failed to fetch catalog' })
    }
  })

  // GET /api/discover/search?type=movie|series&query=X
  // Search only works against the "top" catalog - that's the only one
  // Cinemeta's own manifest advertises search support for.
  router.get('/search', async (req, res) => {
    try {
      const { type = 'movie', query } = req.query
      if (type !== 'movie' && type !== 'series') {
        return res.status(400).json({ error: 'type must be movie or series' })
      }
      if (!query || !query.trim()) {
        return res.json([])
      }
      const items = await fetchCatalog(type, { catalog: 'top', search: query.trim() })
      res.json(items)
    } catch (error) {
      console.error('Error searching discover catalog:', error)
      res.status(500).json({ error: 'Failed to search catalog' })
    }
  })

  // GET /api/discover/recommendations
  // "Because you watched X" rows for the Dashboard. Algorithm:
  //   1. Take the account's most-recent movie + episode watches (deduped by
  //      show for series, since watching 8 episodes shouldn't crowd out
  //      recs from other titles).
  //   2. For each candidate, fetch its Cinemeta genres via the same cached
  //      fetchMetadata utility notifications already use.
  //   3. Pick up to 3 seeds whose genres haven't been used yet — one seed
  //      per row, one genre per row, no duplicate rows.
  //   4. For each seed, fetch Cinemeta Top Rated in that genre and filter
  //      out anything the user has already watched or manually marked
  //      watched. Cap items per row.
  // Returns { rows: [{ reason, genre, seedId, seedType, items[] }] }.
  router.get('/recommendations', async (req, res) => {
    try {
      if (!prisma || !getAccountId) return res.json({ rows: [] })
      const accountId = getAccountId(req) || 'default'
      const RECENT_WATCH_LOOKBACK = 12
      const MAX_ROWS = 3
      const ITEMS_PER_ROW = 12

      const [movies, episodes, overrides] = await Promise.all([
        prisma.movieWatchHistory.findMany({
          where: { accountId },
          orderBy: { watchedAt: 'desc' },
          take: RECENT_WATCH_LOOKBACK,
          distinct: ['itemId'],
        }),
        prisma.episodeWatchHistory.findMany({
          where: { accountId },
          orderBy: { watchedAt: 'desc' },
          take: RECENT_WATCH_LOOKBACK,
          distinct: ['showId'],
        }),
        prisma.manualWatchOverride.findMany({
          where: { accountId },
          select: { itemId: true, watched: true },
        }),
      ])

      // Blend movie + show candidates in reverse-chronological order.
      const seedCandidates = [
        ...movies.map((m) => ({ id: m.itemId, name: m.itemName, type: 'movie', at: m.watchedAt })),
        ...episodes.map((e) => ({ id: e.showId, name: e.showName, type: 'series', at: e.watchedAt })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at))

      if (seedCandidates.length === 0) return res.json({ rows: [] })

      // The "already watched" set powering the filter — real history +
      // any manual overrides. Overrides set to true also count as watched;
      // set to false REMOVES from the watched set (unwatched override).
      const watchedIds = new Set([
        ...movies.map((m) => m.itemId),
        ...episodes.map((e) => e.showId),
      ])
      for (const o of overrides) {
        if (o.watched) watchedIds.add(o.itemId)
        else watchedIds.delete(o.itemId)
      }

      // Pull genres for each seed candidate in parallel (fetchMetadata is
      // cached, so repeat calls for the same id are free).
      const { fetchMetadata } = require('../utils/notify')
      const withGenres = await Promise.all(seedCandidates.map(async (s) => {
        try {
          const meta = await fetchMetadata(s.id, s.type)
          return { ...s, genres: Array.isArray(meta?.genres) ? meta.genres : [] }
        } catch { return { ...s, genres: [] } }
      }))

      // Walk newest → oldest, picking one seed per fresh genre until we hit
      // MAX_ROWS. Skip seeds whose genres have all already been used, and
      // skip seeds with no genres at all.
      const rows = []
      const usedGenres = new Set()
      const usedSeedIds = new Set()
      for (const seed of withGenres) {
        if (rows.length >= MAX_ROWS) break
        if (usedSeedIds.has(seed.id)) continue
        const pickedGenre = seed.genres.find((g) => !usedGenres.has(g))
        if (!pickedGenre) continue
        usedGenres.add(pickedGenre)
        usedSeedIds.add(seed.id)
        // Top Rated in that genre, filtered to unwatched. Fall back to
        // Popular if Top Rated returns too few after filtering.
        let items = await fetchCatalog(seed.type, { catalog: 'imdbRating', genre: pickedGenre })
        let filtered = items.filter((i) => !watchedIds.has(i.id))
        if (filtered.length < 4) {
          const popular = await fetchCatalog(seed.type, { catalog: 'top', genre: pickedGenre })
          const seenIds = new Set(filtered.map((i) => i.id))
          for (const p of popular) {
            if (!watchedIds.has(p.id) && !seenIds.has(p.id)) filtered.push(p)
          }
        }
        filtered = filtered.slice(0, ITEMS_PER_ROW)
        if (filtered.length === 0) continue
        rows.push({
          reason: `Because you watched ${seed.name}`,
          genre: pickedGenre,
          seedId: seed.id,
          seedType: seed.type,
          items: filtered,
        })
      }

      res.json({ rows })
    } catch (error) {
      console.error('Error building recommendations:', error)
      res.status(500).json({ error: 'Failed to build recommendations' })
    }
  })

  return router;
};
