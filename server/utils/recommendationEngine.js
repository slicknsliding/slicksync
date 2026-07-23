// Real collaborative filtering over the household's own watch-time data -
// not genre tags. Two things this powers:
//   1. Pairwise taste overlap ("you and Sarah") - server/routes/discover.js's
//      /taste-overlap endpoint, surfaced on the Metrics page.
//   2. A collaborative boost blended into /recommendations' existing
//      genre-seed scoring, so the seed picked for a "Because you watched X"
//      row reflects actual cross-person overlap, not just whichever single
//      viewer's score happens to be highest.
//
// Deliberately NOT a full replacement of the existing genre/Cinemeta-backed
// discovery in /recommendations: pure item-based similarity can only ever
// recommend among titles someone in THIS household has already watched,
// which would starve "discover something nobody's seen yet" entirely for a
// household whose watch history is still small - classic large-scale
// collaborative filtering assumes far more users/items than a private
// instance has. The boost approach gets the real behavioral-overlap signal
// without losing Cinemeta as the actual candidate source.
//
// Weight source: verified live against real production data before this
// shipped, and the obvious first choice (MovieWatchHistory/EpisodeWatchHistory's
// own durationSeconds) turned out unusable - it's a proxy-correlation
// artifact only backfilled when a native watch merges with a matching
// AIOStreams-proxy session (see that field's own comment in
// schema.sqlite.prisma), and on this account it was null for 96-100% of
// real watch history. WatchActivity.watchTimeSeconds (deltas from native
// polling, no proxy dependency) covers more, but is STILL sparse for
// anything predating its own tracking - one real account had 558 real
// watch-history rows but WatchActivity coverage for only 2 distinct titles.
// So: every real watch (a MovieWatchHistory/EpisodeWatchHistory row exists
// at all) gets a flat BASELINE_SECONDS floor - same fallback amount
// /recommendations already uses for the same reason - with real
// WatchActivity seconds added on top when available, so a title watched a
// lot still outranks a watched-once one instead of tying at the baseline.
// For a show, baseline accrues per episode watched, so a full binge still
// meaningfully outweighs a one-episode drop even with zero WatchActivity
// coverage for either.
const BASELINE_SECONDS = 600

/**
 * Per-user "how much real time did they spend on each title" vectors, from
 * MovieWatchHistory + EpisodeWatchHistory (episodes summed per show - same
 * "one entry per title" shape the poster mosaic uses, not per-episode),
 * weighted per the BASELINE_SECONDS + WatchActivity scheme above.
 * @returns {Promise<{ vectors: Map<string, Map<string, number>>, itemMeta: Map<string, {name: string, poster: string|null, type: 'movie'|'series'}> }>}
 */
async function buildUserVectors(prisma, accountId) {
  const [movies, episodes, activity] = await Promise.all([
    prisma.movieWatchHistory.findMany({
      where: { accountId },
      select: { userId: true, itemId: true, itemName: true, poster: true },
    }),
    prisma.episodeWatchHistory.findMany({
      where: { accountId },
      select: { userId: true, showId: true, showName: true, poster: true },
    }),
    prisma.watchActivity.findMany({
      where: { accountId },
      select: { userId: true, itemId: true, itemType: true, watchTimeSeconds: true },
    }),
  ])

  const vectors = new Map()
  const itemMeta = new Map()

  const bump = (userId, key, seconds, name, poster, type) => {
    if (!vectors.has(userId)) vectors.set(userId, new Map())
    const v = vectors.get(userId)
    v.set(key, (v.get(key) || 0) + seconds)
    if (name && (!itemMeta.has(key) || !itemMeta.get(key).poster)) itemMeta.set(key, { name, poster: poster || null, type })
  }

  for (const m of movies) bump(m.userId, `movie:${m.itemId}`, BASELINE_SECONDS, m.itemName, m.poster, 'movie')
  for (const e of episodes) bump(e.userId, `series:${e.showId}`, BASELINE_SECONDS, e.showName, e.poster, 'series')

  // Real signal layered on top, only for titles we already have a real
  // watch-history row for (a WatchActivity row with no matching history
  // row would mean an id-format mismatch, not a real title to weight).
  for (const a of activity) {
    const key = `${a.itemType === 'series' ? 'series' : 'movie'}:${a.itemId}`
    if (!itemMeta.has(key)) continue
    bump(a.userId, key, a.watchTimeSeconds, null, null, null)
  }

  return { vectors, itemMeta }
}

/**
 * Cosine similarity across each pair's full weighted vectors, plus the top
 * shared titles ranked by min(timeA, timeB) - so a title only one person in
 * the pair actually spent real time on doesn't count as "shared," and a
 * rewatch-heavy person can't alone inflate a title the other side barely
 * watched.
 */
function computePairwiseOverlap(vectors, itemMeta, { topN = 5 } = {}) {
  const userIds = [...vectors.keys()]
  const pairs = []

  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const a = userIds[i]
      const b = userIds[j]
      const va = vectors.get(a)
      const vb = vectors.get(b)

      let dot = 0
      let magA = 0
      let magB = 0
      const shared = []

      for (const [key, secA] of va) {
        magA += secA * secA
        if (vb.has(key)) {
          const secB = vb.get(key)
          dot += secA * secB
          shared.push({ key, weight: Math.min(secA, secB) })
        }
      }
      for (const secB of vb.values()) magB += secB * secB

      if (shared.length === 0) continue

      const similarity = magA > 0 && magB > 0 ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
      shared.sort((x, y) => y.weight - x.weight)

      pairs.push({
        userA: a,
        userB: b,
        similarity,
        sharedCount: shared.length,
        shared: shared.slice(0, topN).map((s) => ({ key: s.key, ...(itemMeta.get(s.key) || {}) })),
      })
    }
  }

  return pairs.sort((x, y) => y.similarity - x.similarity)
}

/**
 * Item-item affinity: for every user, every pair of titles they both spent
 * real time on gets a bump of min(timeX, timeY) - so two titles that keep
 * showing up together across different people's real viewing (not just one
 * person's) build up a stronger link. Symmetric.
 * @returns {Map<string, Map<string, number>>}
 */
function computeItemSimilarity(vectors) {
  const affinity = new Map()
  const bump = (a, b, score) => {
    if (!affinity.has(a)) affinity.set(a, new Map())
    const m = affinity.get(a)
    m.set(b, (m.get(b) || 0) + score)
  }

  for (const v of vectors.values()) {
    const entries = [...v.entries()]
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [keyA, secA] = entries[i]
        const [keyB, secB] = entries[j]
        const score = Math.min(secA, secB)
        if (score <= 0) continue
        bump(keyA, keyB, score)
        bump(keyB, keyA, score)
      }
    }
  }

  return affinity
}

/** Total collaborative weight a title carries across the whole household. */
function collaborativeBoost(affinity, key) {
  const m = affinity.get(key)
  if (!m) return 0
  let total = 0
  for (const v of m.values()) total += v
  return total
}

module.exports = { buildUserVectors, computePairwiseOverlap, computeItemSimilarity, collaborativeBoost }
