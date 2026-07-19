// OMDb API integration - Rotten Tomatoes and Metacritic ratings, keyed by
// IMDb ID. OMDb also returns its own imdbRating, useful as a bonus for
// callers with no other IMDb rating source (e.g. Activity's history feed,
// which reads straight from the DB and never touches Cinemeta) - callers
// that already have a Cinemeta imdbRating (the detail modal, Discover) keep
// using that one and can ignore this field.
//
// Free-tier OMDb allows 1,000 requests/day. Ratings essentially never
// change, so an in-memory cache (same simple Map+TTL pattern as notify.js's
// metadataCache) keeps repeat lookups of the same title free - the process
// restarts on every deploy anyway, so unbounded growth between deploys isn't
// a real concern at this scale. Misses (title not found, or found but with
// no RT/Metacritic data) are cached too, so a title OMDb doesn't have data
// for isn't re-requested on every poster render until the TTL expires.
const OMDB_API_KEY = process.env.OMDB_API_KEY || null

const omdbCache = new Map()
const OMDB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

async function fetchOmdbRatings(imdbId) {
  if (!OMDB_API_KEY || !imdbId || !/^tt\d+$/.test(imdbId)) return null

  const cached = omdbCache.get(imdbId)
  if (cached && (Date.now() - cached.at) < OMDB_CACHE_TTL_MS) {
    return cached.value
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_API_KEY}`, {
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) return null
    const data = await response.json()

    if (data?.Response === 'False') {
      omdbCache.set(imdbId, { value: null, at: Date.now() })
      return null
    }

    const ratingsArray = Array.isArray(data.Ratings) ? data.Ratings : []
    const rottenTomatoes = ratingsArray.find(r => r.Source === 'Rotten Tomatoes')?.Value || null
    // OMDb's Ratings array entry for Metacritic is "72/100"; top-level
    // Metascore is the same number bare ("72") when present. Prefer the
    // array entry but fall back to Metascore, and always normalize to the
    // bare number so the client doesn't need to know which shape it got.
    const metacriticEntry = ratingsArray.find(r => r.Source === 'Metacritic')?.Value
    const metacritic = metacriticEntry
      ? metacriticEntry.split('/')[0]
      : (data.Metascore && data.Metascore !== 'N/A' ? data.Metascore : null)

    const imdbRating = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null

    if (!rottenTomatoes && !metacritic && !imdbRating) {
      omdbCache.set(imdbId, { value: null, at: Date.now() })
      return null
    }

    const result = { imdbRating, rottenTomatoes, metacritic }
    omdbCache.set(imdbId, { value: result, at: Date.now() })
    return result
  } catch {
    return null
  }
}

module.exports = { fetchOmdbRatings }
