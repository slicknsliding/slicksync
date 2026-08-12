// SlickTrax reactions (😊/😞) and personal ratings - both household-wide
// (no userId), matching NotInterestedItem/WatchlistItem's existing scoping
// (see server/utils/notInterested.js). Both feed recommendation scoring via
// recommendationEngine.js's computeSignedAdjustments - see that module's own
// comment for the weight scheme.
//
// Deliberately binary (happy/sad), not a 3-tier like/love/dislike - the
// original 👍/❤️/👎 version read as clutter in practice (real feedback,
// this session) and a plain two-state reaction needs no legend to
// understand at a glance.
const REACTIONS = new Set(['happy', 'sad'])
const OVERALL_SEASON = 0

function normalizeAccountId(accountId) {
  return accountId || 'default'
}

// ---- Reactions --------------------------------------------------------

/** Upsert (one reaction per item - setting a new one replaces the old). */
async function setReaction(prisma, accountId, itemId, itemType, reaction, itemName, poster) {
  if (!REACTIONS.has(reaction)) throw new Error(`Invalid reaction: ${reaction}`)
  const accountIdValue = normalizeAccountId(accountId)
  return prisma.titleReaction.upsert({
    where: { accountId_itemId: { accountId: accountIdValue, itemId } },
    create: { accountId: accountIdValue, itemId, itemType, reaction, itemName: itemName || null, poster: poster || null },
    update: { reaction, itemName: itemName || undefined, poster: poster || undefined },
  })
}

async function clearReaction(prisma, accountId, itemId) {
  const accountIdValue = normalizeAccountId(accountId)
  await prisma.titleReaction.deleteMany({ where: { accountId: accountIdValue, itemId } })
}

/** { itemId: 'like'|'love'|'dislike' } lookup, for batch UI state. */
async function getReactionsMap(prisma, accountId, itemIds) {
  const accountIdValue = normalizeAccountId(accountId)
  const where = { accountId: accountIdValue }
  if (Array.isArray(itemIds)) where.itemId = { in: itemIds }
  const rows = await prisma.titleReaction.findMany({ where, select: { itemId: true, reaction: true } })
  return Object.fromEntries(rows.map((r) => [r.itemId, r.reaction]))
}

/** Full rows, for feeding the recommendation engine's affinity walk. */
async function getAllReactions(prisma, accountId) {
  const accountIdValue = normalizeAccountId(accountId)
  return prisma.titleReaction.findMany({ where: { accountId: accountIdValue }, select: { itemId: true, itemType: true, reaction: true, itemName: true, poster: true } })
}

// ---- Ratings ------------------------------------------------------------

/** season omitted/0 = overall (movies always use this; series may use it too, independent of any per-season ratings). */
async function setRating(prisma, accountId, itemId, itemType, rating, season, itemName, poster) {
  const r = Number(rating)
  if (!Number.isInteger(r) || r < 1 || r > 10) throw new Error('rating must be an integer 1-10')
  const seasonValue = Number.isInteger(season) ? season : OVERALL_SEASON
  const accountIdValue = normalizeAccountId(accountId)
  return prisma.titleRating.upsert({
    where: { accountId_itemId_season: { accountId: accountIdValue, itemId, season: seasonValue } },
    create: { accountId: accountIdValue, itemId, itemType, season: seasonValue, rating: r, itemName: itemName || null, poster: poster || null },
    update: { rating: r, itemName: itemName || undefined, poster: poster || undefined },
  })
}

async function clearRating(prisma, accountId, itemId, season) {
  const seasonValue = Number.isInteger(season) ? season : OVERALL_SEASON
  const accountIdValue = normalizeAccountId(accountId)
  await prisma.titleRating.deleteMany({ where: { accountId: accountIdValue, itemId, season: seasonValue } })
}

/** { itemId: { 0: rating, 1: rating, ... } } lookup, for the detail modal's season picker. */
async function getRatingsForItem(prisma, accountId, itemId) {
  const accountIdValue = normalizeAccountId(accountId)
  const rows = await prisma.titleRating.findMany({ where: { accountId: accountIdValue, itemId }, select: { season: true, rating: true } })
  return Object.fromEntries(rows.map((r) => [r.season, r.rating]))
}

/** Full rows, for feeding the recommendation engine. */
async function getAllRatings(prisma, accountId) {
  const accountIdValue = normalizeAccountId(accountId)
  return prisma.titleRating.findMany({ where: { accountId: accountIdValue }, select: { itemId: true, itemType: true, season: true, rating: true, itemName: true, poster: true } })
}

module.exports = {
  OVERALL_SEASON,
  setReaction, clearReaction, getReactionsMap, getAllReactions,
  setRating, clearRating, getRatingsForItem, getAllRatings,
}
