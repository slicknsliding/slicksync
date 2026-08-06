// Daily-ticking re-pull of every CustomList with autoRefresh:true, keeping
// an imported catalog (TMDb/MDBList list URL) in sync with its source
// automatically instead of only ever on a manual "Refresh" click. Reuses
// refreshListFromSourceForAccount - the exact same fetch-and-diff logic the
// manual route uses - so this never drifts from what a human-triggered
// refresh would do; it just always applies (that's the whole point of
// opting in), where the manual route shows a diff first.
//
// autoRefreshFrequency ('daily' default, or 'weekly') is applied by simply
// skipping a list on ticks where it isn't due yet, rather than running a
// second weekly timer - one scheduler, per-list gating.

let refreshTimer = null
const INTERVAL_HOURS = 24
const WEEKLY_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000

async function runCatalogAutoRefresh(prisma) {
  try {
    const { refreshListFromSourceForAccount } = require('./listImport')
    const lists = await prisma.customList.findMany({
      where: { autoRefresh: true, importSourceUrl: { not: null } },
    })
    let ok = 0
    let skipped = 0
    for (const list of lists) {
      if (list.autoRefreshFrequency === 'weekly' && list.lastAutoRefreshAt) {
        const sinceLast = Date.now() - new Date(list.lastAutoRefreshAt).getTime()
        if (sinceLast < WEEKLY_MIN_GAP_MS) { skipped++; continue }
      }
      try {
        const { items } = await refreshListFromSourceForAccount(prisma, list.accountId, list)
        await prisma.customList.update({
          where: { id: list.id },
          data: { itemsJson: JSON.stringify(items), lastAutoRefreshAt: new Date() },
        })
        ok++
      } catch (err) {
        console.warn(`[CatalogAutoRefresh] Failed for list ${list.id} (${list.name}):`, err?.message || err)
      }
    }
    if (lists.length > 0) console.log(`[CatalogAutoRefresh] ${ok}/${lists.length} catalogs refreshed${skipped > 0 ? ` (${skipped} not due yet)` : ''}`)
  } catch (err) {
    console.warn('[CatalogAutoRefresh] Run failed:', err?.message || err)
  }
}

function scheduleCatalogAutoRefresh(prisma) {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000
  // Run once shortly after boot (staggered well past the other boot-time
  // schedulers), then daily.
  setTimeout(() => runCatalogAutoRefresh(prisma), 90 * 1000)
  refreshTimer = setInterval(() => runCatalogAutoRefresh(prisma), intervalMs)
  console.log(`[CatalogAutoRefresh] Scheduled every ${INTERVAL_HOURS}h`)
}

module.exports = { scheduleCatalogAutoRefresh, runCatalogAutoRefresh }
