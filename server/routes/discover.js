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

      // This page has no single logged-in "current user" of its own (it's
      // the admin's account-wide view - see findAttributionForSeed's own
      // comment), so "personal" vs "shared" recommendations both need an
      // explicit pick from the caller rather than an implicit "me."
      // personal + one userId = that person's own watch history only.
      // shared + two userIds = combined watch signal from exactly those two,
      // with the existing collaborative-boost/pairwise-attribution logic
      // naturally scoped down to just them (nothing else changes - see
      // scopedUserIds usage below). No mode/userId at all = the original
      // household-wide behavior, unchanged, for any caller that doesn't
      // send these params.
      const mode = req.query.mode === 'shared' ? 'shared' : 'personal'
      const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : null
      const userId2 = typeof req.query.userId2 === 'string' && req.query.userId2 ? req.query.userId2 : null
      // Which type of row to build - matches Discover's own Movies/Series
      // toggle. Filtered in BEFORE ranking/slicing to CANDIDATE_POOL below,
      // not after - filtering after would starve the pool if the highest-
      // scored items that poll happened to skew the other type.
      const requestedType = req.query.type === 'series' ? 'series' : 'movie'
      const scopedUserIds = mode === 'shared' && userId && userId2 && userId !== userId2
        ? [userId, userId2]
        : (mode === 'personal' && userId ? [userId] : null)
      const scopedNamesById = new Map()
      if (scopedUserIds) {
        try {
          const rows = await prisma.user.findMany({ where: { id: { in: scopedUserIds } }, select: { id: true, username: true, email: true } })
          for (const u of rows) scopedNamesById.set(u.id, u.username || u.email || 'someone')
        } catch {}
      }

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

      // Overrides/watchlist/notInterested stay account-wide regardless of
      // mode - neither model has a userId column (both deliberately
      // household-wide, see their own schema comments), and "already
      // watched/wishlisted/dismissed by anyone in the household" is still
      // the right exclusion even for a personal or shared row.
      const [movies, episodes, overrides, activity, watchlist, notInterested] = await Promise.all([
        prisma.movieWatchHistory.findMany({
          where: scopedUserIds ? { accountId, userId: { in: scopedUserIds } } : { accountId },
          orderBy: { watchedAt: 'desc' },
          take: 200,
          distinct: ['itemId'],
        }),
        prisma.episodeWatchHistory.findMany({
          where: scopedUserIds ? { accountId, userId: { in: scopedUserIds } } : { accountId },
          orderBy: { watchedAt: 'desc' },
          take: 200,
          distinct: ['showId'],
        }),
        prisma.manualWatchOverride.findMany({
          where: { accountId },
          select: { itemId: true, watched: true },
        }),
        prisma.watchActivity.findMany({
          where: scopedUserIds ? { accountId, userId: { in: scopedUserIds }, date: { gte: lookbackDate } } : { accountId, date: { gte: lookbackDate } },
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
        const { vectors: allVectors, itemMeta: vectorItemMeta } = await buildUserVectors(prisma, accountId)
        // Scoped down to just the requested user(s) - buildUserVectors has
        // no userId filter of its own (it always reads the whole account),
        // so this is where personal/shared mode actually take effect for
        // the collaborative-boost/attribution layer. Personal mode leaves
        // exactly one entry, which makes every `vectors.size > 1` check
        // below naturally false - no separate "skip this for personal mode"
        // branch needed, the existing household-mode gates already do it.
        const vectors = scopedUserIds
          ? new Map([...allVectors].filter(([uid]) => scopedUserIds.includes(uid)))
          : allVectors
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
        .map(([id, score]) => ({ id, score, ...(itemMeta.get(id) || { type: 'movie' }) }))
        .filter((c) => c.type === requestedType)
        .sort((a, b) => b.score - a.score)
        .slice(0, CANDIDATE_POOL)

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
        // Personal/shared mode (scopedUserIds set) name the actual person/
        // pair explicitly instead - "you" doesn't fit when the admin picked
        // a specific managed user (or two) rather than reading their own
        // account-wide feed.
        let reason = scopedUserIds && scopedUserIds.length === 1
          ? `Because ${scopedNamesById.get(scopedUserIds[0]) || 'they'} watched ${seed.name}`
          : scopedUserIds && scopedUserIds.length === 2
            ? `Because ${scopedNamesById.get(scopedUserIds[0]) || 'they'} and ${scopedNamesById.get(scopedUserIds[1]) || 'they'} watched ${seed.name}`
            : `Because you watched ${seed.name}`
        // hasRealSignal - same definition /similar uses: does the item-item
        // affinity map have any real neighbors for THIS specific seed, i.e.
        // did actual cross-item viewing behavior (not just this seed's own
        // decayed watch-time score) touch this row at all. Every row here
        // already starts from something genuinely watched, so this isn't
        // "watched vs not" - it's "confirmed by real behavioral overlap
        // (this account's own rewatch patterns, or another household
        // member's) vs riding on this one seed's score alone." A found
        // pairwise attribution is strictly stronger evidence of the same
        // thing, so it also counts.
        const seedKey = `${seed.type === 'series' ? 'series' : 'movie'}:${seed.id}`
        let hasRealSignal = !!(affinity && affinity.get(seedKey)?.size > 0)
        if (affinity && pairwiseOverlaps.length > 0) {
          try {
            const { findAttributionForSeed } = require('../utils/recommendationEngine')
            const attribution = findAttributionForSeed(seedKey, pairwiseOverlaps, affinity)
            if (attribution) {
              const nameA = usersById.get(attribution.userA) || 'someone'
              const nameB = usersById.get(attribution.userB) || 'someone else'
              reason = `${nameA} and ${nameB} both loved ${seed.name}`
              hasRealSignal = true
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
          hasRealSignal,
          items: filtered,
        })
      }

      res.json({ rows })
    } catch (error) {
      console.error('Error building recommendations:', error)
      res.status(500).json({ error: 'Failed to build recommendations' })
    }
  })

  // GET /api/discover/similar?id=X&type=movie|series
  // "More Like This" for the detail popup - ANY item, not just Discover's
  // For You rows (that's /recommendations, which seeds off the household's
  // own top-scored watch history; this seeds off whatever single item the
  // popup happens to be open on, including titles nobody's watched yet).
  //
  // Real household affinity is used to WEIGHT which genre(s) to search,
  // never to supply the displayed items directly - a first version did the
  // latter and got it wrong: the item-item affinity map (computeItemSimilarity,
  // same one /recommendations' collaborative boost reads) only has entries
  // for titles someone has actually spent real time on, since that's the
  // literal definition of "affinity neighbor" here - two titles the same
  // person watched. Showing those directly meant "More Like This" was
  // guaranteed to recommend already-watched content back whenever real
  // signal existed, which is the opposite of the point. So: look at what
  // genres the top real neighbors carry, bias the actual Cinemeta pull
  // toward those genres (on top of the seed's own), then filter the result
  // against the WHOLE household's watch history same as /recommendations
  // does - every displayed item is guaranteed unwatched by anyone here.
  router.get('/similar', async (req, res) => {
    try {
      if (!prisma || !getAccountId) return res.json({ items: [], hasRealSignal: false })
      const accountId = getAccountId(req) || 'default'
      const { id, type } = req.query
      if (!id || (type !== 'movie' && type !== 'series')) {
        return res.status(400).json({ error: 'id and type (movie|series) are required' })
      }

      // Same opt-out /recommendations respects - this reuses the identical
      // engine, so a household that turned SlickTrax off shouldn't have it
      // silently running here either.
      try {
        const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
        let cfg = acc?.sync
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
        if (cfg && typeof cfg === 'object' && cfg.enableRecommendations === false) {
          return res.json({ items: [], hasRealSignal: false })
        }
      } catch {}

      const MAX_ITEMS = 16
      const MAX_GENRES_TRIED = 3
      const SEED_GENRE_VOTES = 3 // the seed's own genre(s) anchor the ranking - neighbor genres supplement, don't override
      const seedKey = `${type}:${id}`

      const [movies, episodes, overrides, notInterested] = await Promise.all([
        prisma.movieWatchHistory.findMany({ where: { accountId }, select: { itemId: true } }),
        prisma.episodeWatchHistory.findMany({ where: { accountId }, select: { showId: true } }),
        prisma.manualWatchOverride.findMany({ where: { accountId }, select: { itemId: true, watched: true } }),
        prisma.notInterestedItem.findMany({ where: { accountId }, select: { itemId: true } }).catch(() => []),
      ])
      // Watched-status resolution matches /recommendations exactly - manual
      // overrides set to true also count as watched; set to false REMOVES
      // from the watched set (unwatched override wins over real history).
      const watchedIds = new Set([...movies.map((m) => m.itemId), ...episodes.map((e) => e.showId)])
      for (const o of overrides) {
        if (o.watched) watchedIds.add(o.itemId)
        else watchedIds.delete(o.itemId)
      }
      const notInterestedIds = new Set(notInterested.map((n) => n.itemId))
      const excludeIds = new Set([id, ...watchedIds, ...notInterestedIds])

      const { buildUserVectors, computeItemSimilarity } = require('../utils/recommendationEngine')
      const { vectors } = await buildUserVectors(prisma, accountId)
      const affinity = computeItemSimilarity(vectors)
      const neighbors = affinity.get(seedKey)

      const { fetchMetadata } = require('../utils/notify')
      const genreVotes = new Map()
      const seedMeta = await fetchMetadata(id, type).catch(() => null)
      for (const g of (Array.isArray(seedMeta?.genres) ? seedMeta.genres : [])) {
        genreVotes.set(g, (genreVotes.get(g) || 0) + SEED_GENRE_VOTES)
      }

      const hasRealSignal = !!(neighbors && neighbors.size > 0)
      if (neighbors) {
        // Top 5 real neighbors by affinity weight - just enough to bias the
        // genre pick without turning this into 5 extra metadata calls' worth
        // of latency for a popup that should feel instant.
        const topNeighbors = [...neighbors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        for (const [key] of topNeighbors) {
          const neighborId = key.slice(key.indexOf(':') + 1)
          const neighborType = key.startsWith('series:') ? 'series' : 'movie'
          try {
            const meta = await fetchMetadata(neighborId, neighborType)
            for (const g of (Array.isArray(meta?.genres) ? meta.genres : [])) {
              genreVotes.set(g, (genreVotes.get(g) || 0) + 1)
            }
          } catch {}
        }
      }

      const topGenres = [...genreVotes.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, MAX_GENRES_TRIED)

      const items = []
      const seenIds = new Set([id])
      for (const genre of topGenres) {
        if (items.length >= MAX_ITEMS) break
        let candidates = await fetchCatalog(type, { catalog: 'imdbRating', genre })
        if (candidates.length === 0) candidates = await fetchCatalog(type, { catalog: 'top', genre })
        for (const c of candidates) {
          if (items.length >= MAX_ITEMS) break
          if (seenIds.has(c.id) || excludeIds.has(c.id)) continue
          seenIds.add(c.id)
          items.push(c)
        }
      }

      res.json({ items, hasRealSignal })
    } catch (error) {
      console.error('Error building similar items:', error)
      res.status(500).json({ error: 'Failed to build similar items' })
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

  // --- Cast/crew deep-dive (optional; requires a TMDb API key) -------------
  // Cinemeta has no people database, so a person's filmography can only come
  // from TMDb. The key is opt-in: per-account (Settings, sync.tmdbApiKey)
  // takes precedence, else the TMDB_API_KEY env var. With neither, these
  // endpoints return 503 and the frontend hides the feature entirely.
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w342'
  async function resolveTmdbKey(req) {
    try {
      const accountId = (typeof getAccountId === 'function' ? getAccountId(req) : null) || 'default'
      const acc = await prisma?.appAccount?.findUnique({ where: { id: accountId }, select: { sync: true } })
      let cfg = acc?.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
      const fromSettings = cfg && typeof cfg === 'object' && typeof cfg.tmdbApiKey === 'string' ? cfg.tmdbApiKey.trim() : ''
      if (fromSettings) return fromSettings
    } catch {}
    return (process.env.TMDB_API_KEY || '').trim()
  }

  // GET /api/discover/person/:id - a TMDb person's film/TV credits, newest
  // first, deduped, with poster + year + role. tmdbId/mediaType are returned
  // so the frontend can resolve an IMDb id on click (see /imdb-id below) and
  // open the existing Cinemeta-backed detail modal.
  router.get('/person/:id', async (req, res) => {
    try {
      const key = await resolveTmdbKey(req)
      if (!key) return res.status(503).json({ error: 'TMDb key not configured' })
      const personId = String(req.params.id).replace(/[^0-9]/g, '')
      if (!personId) return res.status(400).json({ error: 'Invalid person id' })

      const url = `https://api.themoviedb.org/3/person/${personId}/combined_credits?api_key=${encodeURIComponent(key)}`
      const rsp = await fetch(url)
      if (!rsp.ok) return res.status(502).json({ error: 'TMDb request failed' })
      const data = await rsp.json()

      const seen = new Set()
      const credits = [...(data.cast || []), ...(data.crew || [])]
        .filter((c) => c && (c.media_type === 'movie' || c.media_type === 'tv') && (c.poster_path || c.title || c.name))
        .map((c) => {
          const date = c.release_date || c.first_air_date || ''
          return {
            tmdbId: c.id,
            mediaType: c.media_type, // 'movie' | 'tv'
            title: c.title || c.name || 'Untitled',
            year: date ? date.slice(0, 4) : null,
            poster: c.poster_path ? `${TMDB_IMG}${c.poster_path}` : null,
            role: c.character || c.job || null,
            popularity: typeof c.popularity === 'number' ? c.popularity : 0,
            _sort: date || '0000',
          }
        })
        .filter((c) => { const k = `${c.mediaType}:${c.tmdbId}`; if (seen.has(k)) return false; seen.add(k); return true })
        .sort((a, b) => b._sort.localeCompare(a._sort))
        .slice(0, 60)
        .map(({ _sort, popularity, ...rest }) => rest)

      res.json({ person: { id: Number(personId), name: data.name || null }, credits })
    } catch (error) {
      console.error('Error fetching person credits:', error)
      res.status(500).json({ error: 'Failed to fetch person credits' })
    }
  })

  // GET /api/discover/imdb-id?tmdbId=X&type=movie|tv - resolve a TMDb title to
  // its IMDb id, so a person-credit click can open the existing detail modal
  // (which is Cinemeta/tt-id based). One extra call, made only on click - the
  // person endpoint stays a single TMDb request.
  router.get('/imdb-id', async (req, res) => {
    try {
      const key = await resolveTmdbKey(req)
      if (!key) return res.status(503).json({ error: 'TMDb key not configured' })
      const tmdbId = String(req.query.tmdbId || '').replace(/[^0-9]/g, '')
      const type = req.query.type === 'tv' ? 'tv' : 'movie'
      if (!tmdbId) return res.status(400).json({ error: 'Invalid tmdbId' })
      const rsp = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${encodeURIComponent(key)}`)
      if (!rsp.ok) return res.status(502).json({ error: 'TMDb request failed' })
      const data = await rsp.json()
      res.json({ imdbId: data.imdb_id || null, type: type === 'tv' ? 'series' : 'movie' })
    } catch (error) {
      console.error('Error resolving imdb id:', error)
      res.status(500).json({ error: 'Failed to resolve imdb id' })
    }
  })

  return router;
};
