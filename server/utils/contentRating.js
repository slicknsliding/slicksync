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

module.exports = { SELECTABLE_RATINGS, parseKeptRatings, serializeKeptRatings, isKept }
