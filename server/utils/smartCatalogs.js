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
// The rule IS nlCatalog's normalized query (the same one "Describe a
// catalog" produces), plus a minimum rating, "unwatched by this household"
// and a size. titleFinder.js answers it - from LumiereDB when one is ready,
// otherwise TMDb.

const { normalizeQuery, buildWatchedIdSet } = require('./nlCatalog')

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
 * `onError` hears why, for a caller that shows it.
 */
async function evaluateRule(prisma, accountId, rule, tmdbKey, { onError } = {}) {
  if (!rule) return null

  // "Nobody here has seen it" - about this household's own history, so it
  // is SlickSync's to answer. Handed to the search as titles to leave out,
  // which LumiereDB does before counting, so the catalog still comes back
  // full rather than short by however many had been watched.
  let excludeIds = []
  if (rule.unwatchedOnly) {
    try {
      excludeIds = [...await buildWatchedIdSet(prisma, accountId)]
    } catch {
      // Can't read history - the unfiltered set beats failing the refresh.
    }
  }

  try {
    const { findTitles } = require('./titleFinder')
    const { items } = await findTitles(prisma, accountId, rule, { limit: rule.limit || 40, excludeIds, tmdbKey })
    return items
  } catch (e) {
    if (onError) onError(e)
    return null
  }
}

/** Refreshes one smart catalog in place. Returns a summary, or null if skipped. */
async function refreshSmartCatalog(prisma, accountId, list, tmdbKey, { onError } = {}) {
  const rule = parseRule(list?.smartRuleJson)
  if (!rule) return null
  const items = await evaluateRule(prisma, accountId, rule, tmdbKey, { onError })
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

const SORT_WORDS = {
  popular: 'most popular first',
  trending: 'trending first',
  top_rated: 'best rated first',
  votes: 'most voted first',
  newest: 'newest first',
  oldest: 'oldest first',
}

const listWords = (names, joiner) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`)

/** Human-readable rule, for the UI and for guides. */
function describeRule(rule) {
  if (!rule) return ''
  const parts = []
  if (rule.genres?.length) parts.push(rule.genres.join(' / '))
  parts.push(rule.type === 'series' ? 'series' : rule.type === 'movie' ? 'movies' : 'movies and series')
  if (rule.excludeGenres?.length) parts.push(`not ${rule.excludeGenres.join(' or ')}`)
  if (rule.cast?.length) parts.push(`with ${listWords(rule.cast, rule.castMatch === 'any' ? 'or' : 'and')}`)
  if (rule.directors?.length) parts.push(`directed by ${listWords(rule.directors, 'or')}`)
  if (rule.yearFrom && rule.yearTo) parts.push(`from ${rule.yearFrom}-${rule.yearTo}`)
  else if (rule.yearFrom) parts.push(`from ${rule.yearFrom} onwards`)
  else if (rule.yearTo) parts.push(`up to ${rule.yearTo}`)
  if (rule.type === 'series' && rule.seriesStatus === 'airing') parts.push('still airing')
  if (rule.type === 'series' && rule.seriesStatus === 'ended') parts.push(rule.lastAiredFrom ? `ended, last aired ${rule.lastAiredFrom} or later` : 'ended')
  else if (rule.type === 'series' && rule.lastAiredFrom && rule.seriesStatus !== 'airing') parts.push(`last aired ${rule.lastAiredFrom} or later`)
  if (rule.minRating) parts.push(`rated ${rule.minRating}+`)
  if (rule.minVotes) parts.push(`${Number(rule.minVotes).toLocaleString('en-US')}+ votes`)
  if (rule.minRuntimeMinutes && rule.maxRuntimeMinutes) parts.push(`${rule.minRuntimeMinutes}-${rule.maxRuntimeMinutes} minutes`)
  else if (rule.minRuntimeMinutes) parts.push(`over ${rule.minRuntimeMinutes} minutes`)
  else if (rule.maxRuntimeMinutes) parts.push(`under ${rule.maxRuntimeMinutes} minutes`)
  if (rule.keywords?.length) parts.push(`about ${rule.keywords.join(', ')}`)
  if (rule.unwatchedOnly) parts.push('nobody here has seen')
  if (rule.sort && SORT_WORDS[rule.sort]) parts.push(SORT_WORDS[rule.sort])
  return parts.join(', ')
}

module.exports = { normalizeRule, parseRule, evaluateRule, refreshSmartCatalog, describeRule }
