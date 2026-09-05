// Smart Catalogs: a catalog defined by a RULE rather than a fixed list.
//
// The existing catalog features each solve a neighbouring problem and none
// of them solve this one:
//   - "describe it in plain English" interprets a description ONCE and then
//     the catalog is static;
//   - auto-refresh re-pulls an imported URL, so the source decides content;
//   - auto-generated themed catalogs detect clusters from watch history,
//     not from criteria you chose.
// A Smart Catalog keeps your criteria and re-evaluates them, so "horror,
// 2015+, rated 7+, that nobody here has seen" keeps meaning that next month.
//
// Deliberately built on nlCatalog's existing query -> TMDb Discover path
// rather than a second discovery implementation: the rule IS that module's
// normalized query, plus the two SlickSync-side filters TMDb cannot express
// (minimum rating is TMDb-side, but "unwatched by this household" is ours).

const { normalizeQuery, discoverFromQuery, resolveToImdbItem, buildWatchedIdSet } = require('./nlCatalog')

const MAX_ITEMS = 100

/** Rule -> stored JSON. Unknown fields are dropped rather than trusted. */
function normalizeRule(raw) {
  const query = normalizeQuery(raw || {})
  const minRating = Number(raw?.minRating)
  return {
    ...query,
    minRating: Number.isFinite(minRating) && minRating > 0 ? Math.min(10, minRating) : null,
    unwatchedOnly: raw?.unwatchedOnly === true,
    limit: Number.isFinite(Number(raw?.limit)) ? Math.min(MAX_ITEMS, Math.max(5, Math.round(Number(raw.limit)))) : 40,
  }
}

function parseRule(json) {
  if (!json) return null
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json
    return parsed && typeof parsed === 'object' ? normalizeRule(parsed) : null
  } catch {
    return null
  }
}

/**
 * Evaluates a rule into catalog items. Returns null (rather than an empty
 * list) when it cannot be evaluated at all - the caller must be able to tell
 * "this rule currently matches nothing" from "we could not ask", because the
 * first is a legitimate result to save and the second would wipe a catalog.
 */
async function evaluateRule(prisma, accountId, rule, tmdbKey) {
  if (!rule || !tmdbKey) return null

  // discoverFromQuery hands back RAW TMDb rows ({ mediaType, results }), not
  // catalog items - resolving each to a real IMDb id is a separate step, and
  // treating the return value as a finished list silently produced an empty
  // catalog every time (caught in verification, not in review).
  let mediaType, results
  try {
    ({ mediaType, results } = await discoverFromQuery(rule, tmdbKey))
  } catch {
    return null
  }
  if (!Array.isArray(results)) return null
  if (results.length === 0) return []

  // TMDb's own rating, applied before the per-item id lookups so a strict
  // minimum does not cost a round-trip per title it was going to drop.
  let rows = results
  if (rule.minRating) {
    rows = rows.filter((r) => {
      const v = Number(r?.vote_average)
      return !Number.isFinite(v) || v >= rule.minRating
    })
  }

  const { mapLimit } = require('./listImport')
  const resolved = await mapLimit(rows, 5, (r) => resolveToImdbItem(r, mediaType, tmdbKey))
  let items = resolved.filter(Boolean)

  // "Nobody here has seen it" - the one filter TMDb cannot answer, because
  // it is about this household's own history.
  if (rule.unwatchedOnly) {
    try {
      const watched = await buildWatchedIdSet(prisma, accountId)
      items = items.filter((i) => !watched.has(i.id))
    } catch {
      // Can't read history - returning the unfiltered set beats failing the
      // whole refresh.
    }
  }

  return items.slice(0, rule.limit || 40)
}

/** Refreshes one smart catalog in place. Returns a summary, or null if skipped. */
async function refreshSmartCatalog(prisma, accountId, list, tmdbKey) {
  const rule = parseRule(list?.smartRuleJson)
  if (!rule) return null
  const items = await evaluateRule(prisma, accountId, rule, tmdbKey)
  // A rule that could not be evaluated leaves the catalog exactly as it was.
  // Replacing it with an empty list on a TMDb hiccup would silently delete
  // someone's catalog contents.
  if (items === null) return null
  await prisma.customList.update({
    where: { id: list.id },
    data: { itemsJson: JSON.stringify(items), lastAutoRefreshAt: new Date() },
  })
  return { id: list.id, name: list.name, count: items.length }
}

/** Human-readable rule, for the UI and for guides. */
function describeRule(rule) {
  if (!rule) return ''
  const parts = []
  if (rule.genres?.length) parts.push(rule.genres.join(' / '))
  parts.push(rule.type === 'series' ? 'series' : rule.type === 'movie' ? 'movies' : 'movies and series')
  if (rule.yearFrom && rule.yearTo) parts.push(`from ${rule.yearFrom}-${rule.yearTo}`)
  else if (rule.yearFrom) parts.push(`from ${rule.yearFrom} onwards`)
  else if (rule.yearTo) parts.push(`up to ${rule.yearTo}`)
  if (rule.minRating) parts.push(`rated ${rule.minRating}+`)
  if (rule.maxRuntimeMinutes) parts.push(`under ${rule.maxRuntimeMinutes} minutes`)
  if (rule.keywords?.length) parts.push(`about ${rule.keywords.join(', ')}`)
  if (rule.unwatchedOnly) parts.push('nobody here has seen')
  return parts.join(', ')
}

module.exports = { normalizeRule, parseRule, evaluateRule, refreshSmartCatalog, describeRule }
