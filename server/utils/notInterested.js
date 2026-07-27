// SlickTrax "Not interested" feedback - lets a user say "stop recommending
// this" from a For You row. Household-wide (no userId), matching how the
// recommendation engine's own scoring is account-scoped, not per-user - see
// NotInterestedItem's schema comment for why.

/**
 * Marks an item as not interested. Upsert so re-marking an already-marked
 * item (e.g. a stale client retry) is a no-op, not a duplicate-key error.
 */
async function markNotInterested(prisma, accountId, itemId, itemType) {
  const accountIdValue = accountId || 'default'
  await prisma.notInterestedItem.upsert({
    where: { accountId_itemId: { accountId: accountIdValue, itemId } },
    create: { accountId: accountIdValue, itemId, itemType },
    update: {}
  })
}

/**
 * Set of itemIds marked not-interested for this account - same shape as the
 * watchedIds/watchlistIds sets already used to filter /recommendations
 * candidates, so it drops into the existing filter expression directly.
 */
async function getNotInterestedIds(prisma, accountId) {
  const accountIdValue = accountId || 'default'
  const rows = await prisma.notInterestedItem.findMany({
    where: { accountId: accountIdValue },
    select: { itemId: true }
  })
  return new Set(rows.map((r) => r.itemId))
}

/**
 * Full rows (itemId + itemType), needed to build the "movie:<id>"/
 * "series:<id>" affinity keys computeNotInterestedPenalties walks to find
 * similar items to downweight - getNotInterestedIds alone doesn't carry
 * itemType.
 */
async function getNotInterestedItems(prisma, accountId) {
  const accountIdValue = accountId || 'default'
  return prisma.notInterestedItem.findMany({
    where: { accountId: accountIdValue },
    select: { itemId: true, itemType: true }
  })
}

module.exports = { markNotInterested, getNotInterestedIds, getNotInterestedItems }
