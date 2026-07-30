/**
 * "What should we watch tonight" swipe-off - household/social roadmap idea.
 * Solves nightly picking paralysis with a Tinder-style elimination round
 * instead of a static recommendation list: everyone invited swipes yes/no on
 * the same pool, and the session resolves the instant one title has a yes
 * from every participant.
 *
 * Candidate pool: pulled from Cinemeta's Popular catalog (movies + series
 * mixed, same source Discover uses), filtered down to titles NONE of the
 * invited participants has already watched - a title everyone's already seen
 * makes a poor "what should we watch" suggestion regardless of how well it
 * matches taste. Kept simple/robust for v1 rather than pulling in the taste-
 * vector recommendation engine; genre-weighting toward the group's shared
 * taste is a natural follow-up, not required for the core mechanic to work.
 */
const { fetchCatalog } = require('./discover')

const POOL_SIZE = 24

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function getWatchedItemIds(prisma, accountId, userIds) {
  const [movies, episodes] = await Promise.all([
    prisma.movieWatchHistory.findMany({ where: { accountId, userId: { in: userIds } }, select: { itemId: true } }),
    prisma.episodeWatchHistory.findMany({ where: { accountId, userId: { in: userIds } }, select: { showId: true } }),
  ])
  const ids = new Set()
  for (const m of movies) ids.add(m.itemId)
  for (const e of episodes) ids.add(e.showId)
  return ids
}

async function buildCandidatePool(prisma, accountId, participantIds) {
  const [watchedIds, movieBatch, seriesBatch] = await Promise.all([
    getWatchedItemIds(prisma, accountId, participantIds),
    fetchCatalog('movie', { catalog: 'top' }),
    fetchCatalog('series', { catalog: 'top' }),
  ])

  const fresh = [...movieBatch, ...seriesBatch].filter((item) => item.id && !watchedIds.has(item.id))
  const pool = shuffle(fresh).slice(0, POOL_SIZE)

  return pool.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster || null,
    year: item.releaseInfo || null,
  }))
}

module.exports = { buildCandidatePool }
