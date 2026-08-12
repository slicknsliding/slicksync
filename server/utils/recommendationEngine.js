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
 * Cross-references a recommendation row's seed against real pairwise
 * overlap data, so /recommendations can say "Sarah and Mike both loved X"
 * instead of the generic "Because you watched X" whenever there's a real
 * household match behind the seed - not just whenever the collaborative
 * boost nudged its score (that boost sums affinity across ALL users at once
 * and discards per-user attribution in the process, so it alone can't
 * answer "which two people" - this reads computePairwiseOverlap's per-pair
 * `shared` list instead, which keeps that attribution intact).
 *
 * NOT scoped to "the current user" - /recommendations is the ADMIN's
 * account-wide Discover page (aggregated across every managed user's watch
 * history, no per-viewer login of its own), so there's no single logged-in
 * "you" to filter pairs by the way a personalized per-user feed would.
 * Every pair is a candidate; the caller names both people in the pair.
 *
 * Two ways a match counts, checked in order:
 *   1. Direct: the seed itself is one of a pair's shared titles.
 *   2. Neighbor: a title in a pair's shared list is a strong affinity
 *      neighbor of the seed (same item-item map collaborativeBoost reads) -
 *      catches "recommended City B because of its similarity to City A,
 *      which Sarah and Mike both watched" even when the seed itself isn't
 *      something either of them has seen.
 * neighborThreshold is in the same accumulated-seconds units as the rest of
 * this file (affinity weights are min(secX, secY) sums, not a 0-1 ratio) -
 * defaults to half a single BASELINE_SECONDS watch's worth, so a barely-
 * touched neighbor link doesn't produce a confident-sounding attribution.
 *
 * @param {string} seedKey - "movie:<id>" / "series:<id>"
 * @param {Array} pairwiseOverlaps - computePairwiseOverlap's raw output (all pairs)
 * @param {Map<string, Map<string, number>>} affinity - computeItemSimilarity's output
 * @returns {{ userA: string, userB: string, similarity: number, sharedCount: number, matchedItem: object } | null}
 */
function findAttributionForSeed(seedKey, pairwiseOverlaps, affinity, { neighborThreshold = BASELINE_SECONDS / 2 } = {}) {
  const matches = []
  const neighbors = affinity.get(seedKey)

  for (const pair of pairwiseOverlaps) {
    const directHit = pair.shared.find((s) => s.key === seedKey)
    if (directHit) {
      matches.push({ userA: pair.userA, userB: pair.userB, similarity: pair.similarity, sharedCount: pair.sharedCount, matchedItem: directHit })
      continue
    }

    if (neighbors) {
      const neighborHit = pair.shared.find((s) => (neighbors.get(s.key) || 0) >= neighborThreshold)
      if (neighborHit) {
        matches.push({ userA: pair.userA, userB: pair.userB, similarity: pair.similarity, sharedCount: pair.sharedCount, matchedItem: neighborHit })
      }
    }
  }

  return matches.length > 0 ? pickStrongestAttribution(matches) : null
}

/** Strongest of several candidate attributions - highest similarity, then most shared titles. */
function pickStrongestAttribution(matches) {
  return [...matches].sort((a, b) => b.similarity - a.similarity || b.sharedCount - a.sharedCount)[0]
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

/**
 * SlickTrax "Not interested" feedback: for every item marked not-interested,
 * walk its affinity neighbors (the same item-item map collaborativeBoost
 * reads) and accumulate a penalty on each - so marking one title downweights
 * titles that keep co-occurring with it in real household viewing, not just
 * the exact marked title itself. decay < 1 keeps a similar item's penalty
 * smaller than the affinity weight that produced it, since "similar to
 * something you didn't want" is weaker evidence than the direct signal.
 * @returns {Map<string, number>} candidateKey -> raw penalty (uncapped)
 */
function computeNotInterestedPenalties(affinity, notInterestedKeys, { decay = 0.5 } = {}) {
  const penalties = new Map()
  for (const niKey of notInterestedKeys) {
    const neighbors = affinity.get(niKey)
    if (!neighbors) continue
    for (const [neighborKey, weight] of neighbors) {
      penalties.set(neighborKey, (penalties.get(neighborKey) || 0) + weight * decay)
    }
  }
  return penalties
}

/**
 * Applies a not-interested penalty to a candidate's score, capped so it can
 * never fully zero out (or invert the sign of) a positive score - a title
 * merely similar to something dismissed should rank lower, not disappear
 * outright the way a direct not-interested match already does via the
 * candidate filter in /recommendations.
 */
function applyNotInterestedPenalty(score, penalty, { maxPenaltyRatio = 0.9 } = {}) {
  if (!penalty || penalty <= 0 || score <= 0) return score
  const cappedPenalty = Math.min(penalty, score * maxPenaltyRatio)
  return score - cappedPenalty
}

/**
 * SlickTrax reactions (😊/😞) and personal ratings, generalized into ONE
 * signed adjustment: a real thumb on the scale for /recommendations'
 * scoreByItem, not just a decorative badge on the detail modal. Positive
 * weight boosts a title's odds of being picked as a "Because you watched X"
 * seed (and its close neighbors' odds too); negative weight suppresses both,
 * the mirror image of computeNotInterestedPenalties above - in fact
 * "not interested" is exactly this same walk with a fixed negative weight,
 * left as its own separate, unchanged function above rather than rewritten
 * on top of this one, since it already shipped and works.
 *
 * Weights are in the same accumulated-seconds units as the rest of this
 * file (BASELINE_SECONDS=600, WATCHLIST_WEIGHT_SECONDS=900 in discover.js)
 * so a reaction/rating sits in the same scale as real watch-time and
 * watchlist-intent signals instead of dominating or being drowned out by
 * them. REACTION_WEIGHTS: binary and symmetric (happy/sad, no middle tier -
 * the original 3-tier 👍/❤️/👎 version was pulled from the UI for reading as
 * clutter; the weight scheme follows the UI back down to two states).
 * Ratings convert on a line through the midpoint of the 1-10 scale (5.5)
 * scaled so a perfect 10 lands at "happy"'s weight and a 1 lands at "sad"'s -
 * a 5 or 6 comes out near-zero, correctly read as "no strong opinion" rather
 * than a mild boost or penalty.
 */
const REACTION_WEIGHTS = { happy: 1200, sad: -1200 }
const RATING_SCALE = 1200 / 4.5 // so rating=10 -> +1200 (happy), rating=1 -> -1200

function ratingToWeight(rating) {
  return (rating - 5.5) * RATING_SCALE
}

/**
 * @param {Map<string, Map<string, number>>} affinity - computeItemSimilarity's output
 * @param {Array<{ key: string, weight: number }>} signedEntries - e.g. [{ key: 'movie:tt123', weight: 900 }]
 * @param {number} decay - how much of a neighbor's affinity weight carries over, same shape/default as computeNotInterestedPenalties
 * @returns {Map<string, number>} candidateKey -> signed adjustment (direct entries included at full weight)
 */
function computeSignedAdjustments(affinity, signedEntries, { decay = 0.5 } = {}) {
  const adjustments = new Map()
  for (const { key, weight } of signedEntries) {
    if (!weight) continue
    adjustments.set(key, (adjustments.get(key) || 0) + weight)
    const neighbors = affinity.get(key)
    if (!neighbors) continue
    const sign = weight > 0 ? 1 : -1
    for (const [neighborKey, affinityWeight] of neighbors) {
      adjustments.set(neighborKey, (adjustments.get(neighborKey) || 0) + sign * affinityWeight * decay)
    }
  }
  return adjustments
}

/** Reaction rows (server/utils/titleFeedback.js's getAllReactions) -> signed entries for computeSignedAdjustments. */
function reactionsToSignedEntries(reactions) {
  return reactions
    .filter((r) => REACTION_WEIGHTS[r.reaction])
    .map((r) => ({ key: `${r.itemType === 'series' ? 'series' : 'movie'}:${r.itemId}`, weight: REACTION_WEIGHTS[r.reaction] }))
}

/**
 * Rating rows (getAllRatings) -> signed entries. A series can carry several
 * rows (an overall one plus per-season ones) - averaged into ONE weight per
 * title, since the affinity graph operates at the whole-title level, not
 * per-season; a blended "how do you feel about this show" is the right
 * single signal to feed it (e.g. a great overall rating pulled down by one
 * rough season averages out, rather than the show's contribution to scoring
 * just being whichever row happened to load last).
 */
function ratingsToSignedEntries(ratings) {
  const sums = new Map() // key -> { total, count }
  for (const r of ratings) {
    const key = `${r.itemType === 'series' ? 'series' : 'movie'}:${r.itemId}`
    const entry = sums.get(key) || { total: 0, count: 0 }
    entry.total += ratingToWeight(r.rating)
    entry.count += 1
    sums.set(key, entry)
  }
  return [...sums.entries()].map(([key, { total, count }]) => ({ key, weight: total / count }))
}

module.exports = {
  buildUserVectors,
  computePairwiseOverlap,
  computeItemSimilarity,
  collaborativeBoost,
  computeNotInterestedPenalties,
  applyNotInterestedPenalty,
  findAttributionForSeed,
  pickStrongestAttribution,
  computeSignedAdjustments,
  reactionsToSignedEntries,
  ratingsToSignedEntries,
  REACTION_WEIGHTS,
  ratingToWeight,
}
