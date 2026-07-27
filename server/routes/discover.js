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
  // "Because you watched X" rows for Discover's For You tab, built from
  // SlickTrax's actual watch-time signal rather than just "what did you
  // play most recently." Algorithm:
  //   1. Score every item the account has real WatchActivity for by its
  //      SUMMED watchTimeSeconds over the lookback window, exponentially
  //      decayed by age (a show binged 3 months ago should fade, not sit
  //      permanently at the top; something you're mid-binge on right now
  //      should dominate over a single movie watched once ages ago). Items
  //      with real watch history but no WatchActivity coverage yet (older
  //      data) get a small flat baseline instead of being invisible.
  //   2. Watchlist adds are folded in too, at a fraction of a real watch's
  //      weight — "I want to see this" is a real taste signal, just a
  //      weaker one than time actually spent watching.
  //   3. Fetch genres (cached) for the top-scored candidates, then sum each
  //      candidate's score into every genre it carries — genre affinity
  //      driven by weighted watch time, not by whichever 3 titles happen to
  //      be most recent.
  //   4. Take the top genres by aggregate score, one row each. Each row's
  //      seed (for the "Because you watched X" label) is the highest-scored
  //      candidate carrying that genre.
  //   5. For each seed, fetch Cinemeta Top Rated in that genre (falling back
  //      to Popular if too few survive filtering), excluding anything
  //      already watched OR already on the watchlist — no point suggesting
  //      what you've already decided to watch.
  // Returns { rows: [{ reason, genre, seedId, seedType, items[] }] }.
  router.get('/recommendations', async (req, res) => {
    try {
      if (!prisma || !getAccountId) return res.json({ rows: [] })
      const accountId = getAccountId(req) || 'default'

      // Respect the SlickTrax opt-out — a disabled feature should never
      // trigger the metadata + catalog fetches this endpoint does,
      // regardless of what the client sends.
      try {
        const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
        let cfg = acc?.sync
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
        if (cfg && typeof cfg === 'object' && cfg.enableRecommendations === false) {
          return res.json({ rows: [] })
        }
      } catch {}

      const MAX_ROWS = 3
      const ITEMS_PER_ROW = 12
      const CANDIDATE_POOL = 40 // how many top-scored items get a genre lookup
      const ACTIVITY_LOOKBACK_DAYS = 90
      const HALF_LIFE_DAYS = 21 // score halves every 3 weeks of age
      const BASELINE_SECONDS = 600 // flat weight for real watches with no WatchActivity coverage (pre-dates the table, or a same-poll edge case)
      const WATCHLIST_WEIGHT_SECONDS = 900 // an intent signal, deliberately lighter than any real viewing

      const lookbackDate = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

      const [movies, episodes, overrides, activity, watchlist, notInterested] = await Promise.all([
        prisma.movieWatchHistory.findMany({
          where: { accountId },
          orderBy: { watchedAt: 'desc' },
          take: 200,
          distinct: ['itemId'],
        }),
        prisma.episodeWatchHistory.findMany({
          where: { accountId },
          orderBy: { watchedAt: 'desc' },
          take: 200,
          distinct: ['showId'],
        }),
        prisma.manualWatchOverride.findMany({
          where: { accountId },
          select: { itemId: true, watched: true },
        }),
        prisma.watchActivity.findMany({
          where: { accountId, date: { gte: lookbackDate } },
          select: { itemId: true, itemType: true, watchTimeSeconds: true, date: true },
        }),
        prisma.watchlistItem.findMany({ where: { accountId }, select: { itemId: true, itemType: true, name: true } }).catch(() => []),
        prisma.notInterestedItem.findMany({ where: { accountId }, select: { itemId: true, itemType: true } }).catch(() => []),
      ])

      // Title/type for every candidate, from whichever source names it first.
      const itemMeta = new Map()
      for (const m of movies) itemMeta.set(m.itemId, { name: m.itemName, type: 'movie' })
      for (const e of episodes) itemMeta.set(e.showId, { name: e.showName, type: 'series' })
      for (const w of watchlist) if (!itemMeta.has(w.itemId)) itemMeta.set(w.itemId, { name: w.name, type: w.itemType })

      if (itemMeta.size === 0) return res.json({ rows: [] })

      // The "already watched" / "already on watchlist" sets powering the
      // exclusion filter. Manual overrides set to true also count as
      // watched; set to false REMOVES from the watched set (unwatched
      // override wins over real history).
      const watchedIds = new Set([
        ...movies.map((m) => m.itemId),
        ...episodes.map((e) => e.showId),
      ])
      for (const o of overrides) {
        if (o.watched) watchedIds.add(o.itemId)
        else watchedIds.delete(o.itemId)
      }
      const watchlistIds = new Set(watchlist.map((w) => w.itemId))
      // SlickTrax "Not interested" feedback - excluded the same way watched/
      // watchlisted items already are (never a seed, never a recommended
      // item), plus notInterestedKeys below feeds computeNotInterestedPenalties
      // to also downweight items merely SIMILAR to what was dismissed.
      const notInterestedIds = new Set(notInterested.map((n) => n.itemId))
      const notInterestedKeys = notInterested.map((n) => `${n.itemType === 'series' ? 'series' : 'movie'}:${n.itemId}`)

      // Real watch-time weight, decayed by age so recent viewing still
      // matters more than ancient history without ignoring it outright.
      const now = Date.now()
      const scoreByItem = new Map()
      for (const a of activity) {
        const ageDays = (now - new Date(a.date).getTime()) / (24 * 60 * 60 * 1000)
        const decay = Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS)
        scoreByItem.set(a.itemId, (scoreByItem.get(a.itemId) || 0) + a.watchTimeSeconds * decay)
        if (!itemMeta.has(a.itemId)) itemMeta.set(a.itemId, { name: null, type: a.itemType })
      }
      for (const m of movies) if (!scoreByItem.has(m.itemId)) scoreByItem.set(m.itemId, BASELINE_SECONDS)
      for (const e of episodes) if (!scoreByItem.has(e.showId)) scoreByItem.set(e.showId, BASELINE_SECONDS)
      for (const w of watchlist) scoreByItem.set(w.itemId, (scoreByItem.get(w.itemId) || 0) + WATCHLIST_WEIGHT_SECONDS)

      // Collaborative signal: a modest boost for titles OTHER household
      // members also spent real time on, so the seed picked for a genre row
      // reflects actual shared taste rather than just whichever single
      // viewer's score happens to be highest. See recommendationEngine.js's
      // own header for why this is a boost on top of genre/Cinemeta
      // discovery rather than a full replacement.
      //
      // affinity/pairwiseOverlaps/usersById are hoisted out of this try
      // block (not just local consts) because the row-building loop below
      // reuses them to attribute a seed to a real pairwise match ("Sarah
      // and Mike both loved X") instead of re-deriving the same vectors/
      // affinity a second time.
      let affinity = null
      let pairwiseOverlaps = []
      let usersById = new Map()
      try {
        const {
          buildUserVectors, computeItemSimilarity, collaborativeBoost, computePairwiseOverlap,
          computeNotInterestedPenalties, applyNotInterestedPenalty,
        } = require('../utils/recommendationEngine')
        const { vectors, itemMeta: vectorItemMeta } = await buildUserVectors(prisma, accountId)
        if (vectors.size > 0) {
          affinity = computeItemSimilarity(vectors)
          const COLLAB_BOOST_WEIGHT = 0.5
          // Only meaningful with 2+ real vectors (a single person can't have
          // cross-person affinity), but the not-interested penalty below
          // still applies even for a single-user household, so affinity is
          // still built either way - it'll just be empty for one user.
          const penalties = computeNotInterestedPenalties(affinity, notInterestedKeys)
          for (const [id, score] of scoreByItem) {
            const meta = itemMeta.get(id)
            if (!meta) continue
            const key = `${meta.type === 'series' ? 'series' : 'movie'}:${id}`
            let next = score
            if (vectors.size > 1) {
              const boost = collaborativeBoost(affinity, key)
              if (boost > 0) next += boost * COLLAB_BOOST_WEIGHT
            }
            next = applyNotInterestedPenalty(next, penalties.get(key) || 0)
            if (next !== score) scoreByItem.set(id, next)
          }
        }
        if (vectors.size > 1) {
          pairwiseOverlaps = computePairwiseOverlap(vectors, vectorItemMeta)
          if (pairwiseOverlaps.length > 0) {
            const userRows = await prisma.user.findMany({
              where: { id: { in: [...vectors.keys()] } },
              select: { id: true, username: true, email: true },
            })
            usersById = new Map(userRows.map((u) => [u.id, u.username || u.email || 'someone']))
          }
        }
      } catch (e) {
        console.warn('Collaborative boost/not-interested penalty/attribution skipped:', e?.message)
      }

      const ranked = [...scoreByItem.entries()]
        .filter(([id]) => !notInterestedIds.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, CANDIDATE_POOL)
        .map(([id, score]) => ({ id, score, ...(itemMeta.get(id) || { type: 'movie' }) }))
        .filter((c) => c.type === 'movie' || c.type === 'series')

      if (ranked.length === 0) return res.json({ rows: [] })

      // Pull genres for each ranked candidate in parallel (fetchMetadata is
      // cached, so repeat calls for the same id are free) — also backfills
      // the name for anything that only came from WatchActivity.
      const { fetchMetadata } = require('../utils/notify')
      const withGenres = await Promise.all(ranked.map(async (c) => {
        try {
          const meta = await fetchMetadata(c.id, c.type)
          return { ...c, name: c.name || meta?.name || null, genres: Array.isArray(meta?.genres) ? meta.genres : [] }
        } catch { return { ...c, genres: [] } }
      }))

      // Aggregate weighted score per genre across every candidate carrying it.
      const genreScore = new Map()
      for (const c of withGenres) {
        for (const g of c.genres) genreScore.set(g, (genreScore.get(g) || 0) + c.score)
      }
      const topGenres = [...genreScore.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)

      const rows = []
      const usedSeedIds = new Set()
      for (const genre of topGenres) {
        if (rows.length >= MAX_ROWS) break
        // Seed = the highest-scored candidate carrying this genre — the
        // strongest real reason to attribute the row to.
        const seed = withGenres
          .filter((c) => c.genres.includes(genre) && c.name && !usedSeedIds.has(c.id))
          .sort((a, b) => b.score - a.score)[0]
        if (!seed) continue
        usedSeedIds.add(seed.id)
        // Top Rated in that genre, filtered to unwatched and not already on
        // the watchlist. Fall back to Popular if too few survive filtering.
        let items = await fetchCatalog(seed.type, { catalog: 'imdbRating', genre })
        let filtered = items.filter((i) => !watchedIds.has(i.id) && !watchlistIds.has(i.id) && !notInterestedIds.has(i.id))
        if (filtered.length < 4) {
          const popular = await fetchCatalog(seed.type, { catalog: 'top', genre })
          const seenIds = new Set(filtered.map((i) => i.id))
          for (const p of popular) {
            if (!watchedIds.has(p.id) && !watchlistIds.has(p.id) && !notInterestedIds.has(p.id) && !seenIds.has(p.id)) filtered.push(p)
          }
        }
        filtered = filtered.slice(0, ITEMS_PER_ROW)
        if (filtered.length === 0) continue

        // Real household match behind this seed ("Sarah and Mike both loved
        // X") beats the generic fallback whenever one exists - see
        // findAttributionForSeed's own comment for why this isn't scoped to
        // a single "current user" the way a personalized feed would be.
        let reason = `Because you watched ${seed.name}`
        if (affinity && pairwiseOverlaps.length > 0) {
          try {
            const { findAttributionForSeed } = require('../utils/recommendationEngine')
            const seedKey = `${seed.type === 'series' ? 'series' : 'movie'}:${seed.id}`
            const attribution = findAttributionForSeed(seedKey, pairwiseOverlaps, affinity)
            if (attribution) {
              const nameA = usersById.get(attribution.userA) || 'someone'
              const nameB = usersById.get(attribution.userB) || 'someone else'
              reason = `${nameA} and ${nameB} both loved ${seed.name}`
            }
          } catch (e) {
            console.warn('Attribution lookup skipped:', e?.message)
          }
        }

        rows.push({
          reason,
          genre,
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

  // POST /api/discover/not-interested { itemId, itemType }
  // SlickTrax feedback: excludes this item from future /recommendations
  // (never a seed, never a recommended item) and downweights similar items
  // via the household's own item-item affinity map. Household-wide, not
  // per-user - see NotInterestedItem's schema comment.
  router.post('/not-interested', async (req, res) => {
    try {
      if (!prisma || !getAccountId) return res.status(503).json({ error: 'Not available' })
      const accountId = getAccountId(req) || 'default'
      const { itemId, itemType } = req.body || {}
      if (!itemId || (itemType !== 'movie' && itemType !== 'series')) {
        return res.status(400).json({ error: 'itemId and itemType (movie|series) are required' })
      }
      const { markNotInterested } = require('../utils/notInterested')
      await markNotInterested(prisma, accountId, itemId, itemType)
      res.json({ success: true })
    } catch (error) {
      console.error('Error marking not interested:', error)
      res.status(500).json({ error: 'Failed to save feedback' })
    }
  })

  // GET /api/discover/taste-overlap
  // "You and X" - real behavioral overlap between every pair of managed
  // users on this account, from actual watch-time (MovieWatchHistory /
  // EpisodeWatchHistory), not genre tags. Similarity is cosine similarity
  // across each pair's full weighted watch vectors; "shared favorites" is
  // capped per pair (top 5) by min(timeA, timeB) per title, so a title only
  // one side actually spent real time on doesn't count as shared. See
  // recommendationEngine.js for the actual math.
  router.get('/taste-overlap', async (req, res) => {
    try {
      if (!prisma || !getAccountId) return res.json({ pairs: [] })
      const accountId = getAccountId(req) || 'default'

      const { buildUserVectors, computePairwiseOverlap } = require('../utils/recommendationEngine')
      const { vectors, itemMeta } = await buildUserVectors(prisma, accountId)
      if (vectors.size < 2) return res.json({ pairs: [] })

      const users = await prisma.user.findMany({
        where: { id: { in: [...vectors.keys()] } },
        select: { id: true, username: true, avatarUrl: true, useGravatar: true, colorIndex: true, email: true },
      })
      const userById = new Map(users.map((u) => [u.id, u]))

      const pairs = computePairwiseOverlap(vectors, itemMeta)
        .filter((p) => userById.has(p.userA) && userById.has(p.userB) && p.sharedCount > 0)
        .map((p) => ({
          userA: userById.get(p.userA),
          userB: userById.get(p.userB),
          similarity: Math.round(p.similarity * 100),
          sharedCount: p.sharedCount,
          shared: p.shared,
        }))

      res.json({ pairs })
    } catch (error) {
      console.error('Error computing taste overlap:', error)
      res.status(500).json({ error: 'Failed to compute taste overlap' })
    }
  })

  return router;
};
