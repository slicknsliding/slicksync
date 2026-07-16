/**
 * Library processing utilities
 * Contains shared logic for expanding and enriching library items
 */

/**
 * Find the latest episode from an array of episodes
 * @param {Array} episodes - Array of episode items
 * @param {Object} options - Options object
 * @param {boolean} options.inheritPoster - Whether to inherit poster from first episode if missing
 * @returns {Object|null} - The latest episode item, or null if no episodes
 */
function findLatestEpisode(episodes, options = {}) {
  if (!episodes || episodes.length === 0) return null
  
  const { inheritPoster = false } = options
  const firstEpisode = episodes[0]
  let latestEpisode = null
  
  // Try to find episode matching video_id (latest watched episode)
  if (firstEpisode.state?.video_id) {
    latestEpisode = episodes.find(ep => ep.state?.video_id === firstEpisode.state.video_id)
  }
  
  // If no match found, use the one with highest season/episode number
  if (!latestEpisode) {
    latestEpisode = episodes.reduce((latest, current) => {
      const latestSeason = latest.state?.season || 0
      const latestEpisodeNum = latest.state?.episode || 0
      const currentSeason = current.state?.season || 0
      const currentEpisodeNum = current.state?.episode || 0
      
      if (currentSeason > latestSeason || 
          (currentSeason === latestSeason && currentEpisodeNum > latestEpisodeNum)) {
        return current
      }
      return latest
    })
  }
  
  // Inherit poster from first episode if missing
  if (latestEpisode && inheritPoster && !latestEpisode.poster && firstEpisode.poster) {
    latestEpisode.poster = firstEpisode.poster
  }
  
  return latestEpisode
}

/**
 * Enrich library items with missing posters from Cinemeta
 * @param {Array} items - Array of library items
 * @param {Object} options - Options object
 * @param {number} options.timeout - Timeout in milliseconds (default: 3000)
 * @param {number} options.requestTimeout - Per-request timeout in milliseconds (default: 2000)
 * @returns {Promise<void>}
 */
async function enrichPostersFromCinemeta(items, options = {}) {
  const { timeout = 3000, requestTimeout = 2000 } = options
  
  // Only enrich items that don't have posters
  const enrichPromises = items
    .filter(item => !item.poster && (item._id || item.id))
    .map(async (item) => {
      try {
        let itemId = item._id || item.id
        const itemType = item.type || 'movie'
        
        // For episode items (format: "tt1234567:season:episode"), extract base show ID
        if (itemId.includes(':')) {
          itemId = itemId.split(':')[0]
        }
        
        // Only try Cinemeta for IMDb IDs (starting with "tt")
        if (!itemId.startsWith('tt')) {
          return
        }
        
        const endpoint = `https://v3-cinemeta.strem.io/meta/${itemType}/${itemId}.json`
        
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), requestTimeout)
        
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': 'SlickSync/1.0' },
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
        
        if (response.ok) {
          const data = await response.json()
          const meta = data?.meta
          if (meta?.poster) {
            item.poster = meta.poster
          }
        }
      } catch (error) {
        // Silently fail - poster enrichment is optional
      }
    })
  
  // Wait for all enrichment to complete (with timeout)
  await Promise.race([
    Promise.all(enrichPromises),
    new Promise(resolve => setTimeout(resolve, timeout))
  ])
}

/**
 * Best-effort single-item poster backfill via Cinemeta, for callers writing
 * one history/session row at a time (sessionTracker.js, metricsProcessor.js)
 * rather than batch-enriching an array. Returns existingPoster unchanged if
 * already set or if itemId isn't an IMDb-style id Cinemeta can look up.
 * Bounded by enrichPostersFromCinemeta's own internal timeout.
 * @param {string} itemId
 * @param {string} itemType
 * @param {string|null} existingPoster
 * @returns {Promise<string|null>}
 */
async function resolveSinglePoster(itemId, itemType, existingPoster) {
  if (existingPoster) return existingPoster
  if (!itemId || !itemId.startsWith('tt')) return existingPoster || null
  const target = [{ _id: itemId, type: itemType || 'movie', poster: null }]
  await enrichPostersFromCinemeta(target, { timeout: 2000, requestTimeout: 1500 })
  return target[0].poster || null
}

// Normalize a title for strict equality matching: lowercase, drop a
// parenthesized year, collapse non-alphanumerics to single spaces.
function normalizeTitleForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Strict poster lookup by title via Cinemeta's search catalog. Unlike a
 * fuzzy catalog match (the removed AIOMetadata lookup, which could pick an
 * unrelated same-titled entry), this is "correct-or-nothing": it returns a
 * result ONLY when a candidate's normalized title matches exactly AND, when
 * a year is supplied, its year matches too. Anything less confident returns
 * null (caller shows no poster rather than a possibly-wrong one). Used for
 * proxy/usenet entries, which only have a filename-parsed title to go on.
 *
 * Year handling: when `year` is given it must match (a candidate with no
 * year is rejected as not-confident). When `year` is null - common for
 * series episodes, whose filenames rarely carry a year - it falls back to
 * exact-normalized-title matching alone, which is low-risk for distinctive
 * show titles and the only option available.
 *
 * @param {string} title  e.g. "Simpsley"
 * @param {string|null} year  e.g. "2026" or null
 * @param {'movie'|'series'} type
 * @param {{requestTimeout?: number}} [options]
 * @returns {Promise<{poster: string|null, id: string|null, type: string}|null>}
 */
async function searchCinemetaPosterByTitle(title, year, type, options = {}) {
  const { requestTimeout = 2500 } = options
  if (!title) return null
  const searchType = type === 'series' ? 'series' : 'movie'
  const url = `https://v3-cinemeta.strem.io/catalog/${searchType}/top/search=${encodeURIComponent(title)}.json`
  const want = normalizeTitleForMatch(title)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), requestTimeout)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SlickSync/1.0' }, signal: controller.signal })
    if (!res.ok) return null
    const data = await res.json()
    const metas = Array.isArray(data?.metas) ? data.metas : []
    for (const m of metas) {
      if (normalizeTitleForMatch(m.name) !== want) continue
      if (year) {
        const metaYear = String(m.releaseInfo || m.year || '').slice(0, 4)
        if (metaYear !== String(year)) continue // includes the no-year-on-candidate case
      }
      return { poster: m.poster || null, id: m.id || null, type: searchType }
    }
    return null
  } catch {
    return null // network/timeout/parse failure - no poster is the safe outcome
  } finally {
    clearTimeout(timeoutId)
  }
}

module.exports = {
  findLatestEpisode,
  enrichPostersFromCinemeta,
  resolveSinglePoster,
  searchCinemetaPosterByTitle,
  normalizeTitleForMatch
}

