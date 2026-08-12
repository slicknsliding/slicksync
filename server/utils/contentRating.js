// Catalog content-rating policy - see CustomList.blockedRatings' schema
// comment for the full design (review tool, not an add-time block). Rating
// values come from OMDb's own "Rated" field (server/utils/omdb.js) - MPAA
// for movies, TV parental guidelines for shows. Not a single ordinal scale
// (TV-14 isn't meaningfully "above" or "below" PG-13), so a policy is a
// SET of specific values to flag, not a ceiling.

// The mature-leaning tiers most households would actually want to flag -
// deliberately not the full taxonomy (nobody needs a checkbox for G/PG/
// TV-Y). "Not Rated"/"Unrated" is included on purpose: unrated content is
// sometimes MORE explicit than an R, not less, so a policy meant to catch
// mature content should be able to catch that too.
const FLAGGABLE_RATINGS = ['PG-13', 'R', 'NC-17', 'TV-14', 'TV-MA', 'Not Rated', 'Unrated']

function parseBlockedRatings(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((r) => typeof r === 'string') : []
  } catch {
    return []
  }
}

function serializeBlockedRatings(list) {
  const cleaned = Array.isArray(list) ? list.filter((r) => typeof r === 'string' && r.trim()) : []
  return cleaned.length ? JSON.stringify(cleaned) : null
}

/** True if `rated` (an OMDb Rated value, or null/undefined for unknown) matches the policy. */
function isFlagged(rated, blockedRatings) {
  if (!blockedRatings || blockedRatings.length === 0) return false
  if (!rated) return false // unknown rating is surfaced separately (see server/routes/lists.js's /flagged), not silently treated as a match
  return blockedRatings.includes(rated)
}

module.exports = { FLAGGABLE_RATINGS, parseBlockedRatings, serializeBlockedRatings, isFlagged }
