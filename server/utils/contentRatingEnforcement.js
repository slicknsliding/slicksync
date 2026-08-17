// Daily-ticking re-application of every CustomList's own keptRatings policy
// (server/utils/contentRating.js) - the ongoing-enforcement half of the
// content rating allowlist. The add-time gate in server/routes/lists.js's
// POST /:id/items covers the single "Add to catalog" path everything in
// the UI funnels through, but a title can also reach a catalog via an
// import, the NL catalog builder, "Suggest titles," or "Refresh from
// source" - this sweep is the backstop that catches those too, so a policy
// stays enforced continuously until it's cleared, not just at the moment
// it was applied. Reuses reapplyContentRatingForAccount, the exact same
// logic a manual re-apply would run, so this never drifts from what
// clicking "Apply" by hand would do.

let enforcementTimer = null
const INTERVAL_HOURS = 24

async function runContentRatingEnforcement(prisma) {
  try {
    const { reapplyContentRatingForAccount } = require('./contentRating')
    const lists = await prisma.customList.findMany({
      where: { keptRatings: { not: null } },
    })
    let removedTotal = 0
    let touchedLists = 0
    for (const list of lists) {
      try {
        const { removedCount } = await reapplyContentRatingForAccount(prisma, list.accountId, list)
        if (removedCount > 0) {
          removedTotal += removedCount
          touchedLists++
          console.log(`[ContentRatingEnforcement] "${list.name}": removed ${removedCount} title(s) that no longer match its policy`)
        }
      } catch (err) {
        console.warn(`[ContentRatingEnforcement] Failed for list ${list.id} (${list.name}):`, err?.message || err)
      }
    }
    if (touchedLists > 0) console.log(`[ContentRatingEnforcement] ${removedTotal} title(s) removed across ${touchedLists}/${lists.length} catalog(s) with an active policy`)
  } catch (err) {
    console.warn('[ContentRatingEnforcement] Run failed:', err?.message || err)
  }
}

function scheduleContentRatingEnforcement(prisma) {
  if (enforcementTimer) {
    clearInterval(enforcementTimer)
    enforcementTimer = null
  }
  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000
  // Staggered well past the other boot-time schedulers, then daily.
  setTimeout(() => runContentRatingEnforcement(prisma), 100 * 1000)
  enforcementTimer = setInterval(() => runContentRatingEnforcement(prisma), intervalMs)
  console.log(`[ContentRatingEnforcement] Scheduled every ${INTERVAL_HOURS}h`)
}

module.exports = { scheduleContentRatingEnforcement, runContentRatingEnforcement }
