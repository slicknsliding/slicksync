// Catalog content-rating ALLOWLIST - see CustomList.keptRatings' schema
// comment for the full design. Rating values come from OMDb's own "Rated"
// field (server/utils/omdb.js) - MPAA for movies, TV parental guidelines
// for shows. Not a single ordinal scale (TV-14 isn't meaningfully "above"
// or "below" PG-13), so a policy is a SET of specific values to keep.
//
// Applying a policy is destructive (removes every item whose rating isn't
// in the set) - server/routes/lists.js's preview/apply/restore endpoints
// are what make that safe to use: preview shows what would happen before
// anything's touched, apply snapshots the pre-removal state first so
// restore is always available for the most recent removal.

// The full real-world taxonomy, not just the mature-leaning tiers this
// started as - an allowlist for a Kids catalog needs to be able to select
// G/PG/TV-Y just as much as a "keep only R" catalog needs R. "Not Rated" is
// included on purpose: unrated content is sometimes MORE explicit than an
// R, not less, so it needs to be a selectable value either way.
const SELECTABLE_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Not Rated', 'Unrated']

function parseKeptRatings(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((r) => typeof r === 'string') : []
  } catch {
    return []
  }
}

function serializeKeptRatings(list) {
  const cleaned = Array.isArray(list) ? list.filter((r) => typeof r === 'string' && r.trim()) : []
  return cleaned.length ? JSON.stringify(cleaned) : null
}

/**
 * True if `rated` (an OMDb Rated value, or null/undefined for unknown)
 * should be KEPT under this policy. An item with no known rating is never
 * auto-removed by this alone - callers surface "unknown" items separately
 * (same as the old isFlagged did) so a missing rating doesn't silently
 * count as "doesn't match" and get wiped just because OMDb has no data for it.
 */
function isKept(rated, keptRatings) {
  if (!keptRatings || keptRatings.length === 0) return true // no policy = untouched
  if (!rated) return true // unknown rating - never auto-removed, see comment above
  return keptRatings.includes(rated)
}

/**
 * Account-direct (no req) version of the split computation server/routes/
 * lists.js's preview/apply endpoints use, for the scheduled enforcement
 * sweep below - that runs in the background with no request context.
 */
async function computeContentRatingSplitForAccount(prisma, accountId, items, keptRatings) {
  if (!keptRatings || keptRatings.length === 0 || items.length === 0) {
    return { keep: items, remove: [], unknown: [] }
  }
  const { resolveOmdbKeyForAccount, mapLimit } = require('./listImport')
  const { fetchOmdbRatings } = require('./omdb')
  const apiKey = await resolveOmdbKeyForAccount(prisma, accountId)
  if (!apiKey) return { keep: items, remove: [], unknown: items } // can't check without a key - leave everything alone rather than guess

  const results = await mapLimit(items, 8, async (item) => {
    if (!item.id || !item.id.startsWith('tt')) return { item, rated: null }
    const ratings = await fetchOmdbRatings(item.id, apiKey).catch(() => null)
    return { item, rated: ratings?.rated || null }
  })
  const keep = []
  const remove = []
  const unknown = []
  for (const r of results) {
    if (!r.rated) unknown.push(r.item)
    if (isKept(r.rated, keptRatings)) keep.push(r.item)
    else remove.push(r.item)
  }
  return { keep, remove, unknown }
}

/**
 * Re-applies a catalog's own already-saved keptRatings policy against its
 * CURRENT items - the ongoing-enforcement half of the allowlist (the
 * add-time gate in lists.js's POST /:id/items covers new additions through
 * that one path; this catches anything that reached the catalog another
 * way - imports, the NL catalog builder, suggestions, "Refresh from
 * source" - and keeps a policy continuously enforced until it's cleared,
 * not just applied once). Snapshots for undo exactly like a manual apply
 * does; no-ops (no snapshot, no write) when nothing would actually change,
 * so this is safe to run on every catalog on a schedule without spamming
 * "removed 0 titles" state every tick.
 * @returns {Promise<{removedCount: number}>}
 */
async function reapplyContentRatingForAccount(prisma, accountId, list) {
  const keptRatings = parseKeptRatings(list.keptRatings)
  if (keptRatings.length === 0) return { removedCount: 0 }

  const items = JSON.parse(list.itemsJson || '[]')
  const { remove } = await computeContentRatingSplitForAccount(prisma, accountId, items, keptRatings)
  if (remove.length === 0) return { removedCount: 0 }

  const removeIds = new Set(remove.map((r) => r.id))
  const keptItems = items.filter((it) => !removeIds.has(it.id))
  await prisma.customList.update({
    where: { id: list.id },
    data: {
      itemsJson: JSON.stringify(keptItems),
      lastRemovalSnapshot: list.itemsJson,
      lastRemovalAt: new Date(),
    },
  })
  return { removedCount: remove.length }
}

module.exports = {
  SELECTABLE_RATINGS, parseKeptRatings, serializeKeptRatings, isKept,
  computeContentRatingSplitForAccount, reapplyContentRatingForAccount,
}
