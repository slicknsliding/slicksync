// Natural-language catalog building: "A 90s neo-noir under two hours nobody
// here has seen" -> a real saved Catalog. Two stages, kept strictly separate:
//
//  1. description (free text) -> structured query (genres/years/runtime/type)
//     Tries an LLM first (an "ai" category Vault entry - see
//     resolveAiCredentials below), falls back to a deterministic keyword
//     parser when no AI credential is configured OR the call fails for any
//     reason. The fallback is not a lesser afterthought: this feature must
//     work with zero setup, since not every instance will have an LLM key on
//     hand, and an AI outage must never turn "describe a catalog" into a
//     dead button.
//
//  2. structured query -> real TMDb Discover results -> IMDb ids -> catalog
//     items, filtered against the household's own watch history the same
//     way autoThemedCatalogs.js and /recommendations already do.
//
// Deliberately NOT sharing code with autoThemedCatalogs.js despite the
// similar shape (both end in "-> saved Catalog") - that module detects
// clusters FROM watch history; this one is driven entirely by what the user
// typed. The only real overlap is "exclude already-watched," which is five
// lines, not worth a shared abstraction that would couple two otherwise
// independent features.

const FETCH_TIMEOUT_MS = 8000
const MAX_ITEMS = 20
const CANDIDATE_POOL = 40 // raw TMDb results pulled before watched-filtering/IMDb-resolution

function timeoutSignal(ms) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
}

// ---- Stage 1a: AI credential resolution ------------------------------------
//
// Reuses the Vault's existing (until now unused) "ai" category rather than
// adding a third place API keys can live (Settings already has one pattern
// for TMDb/MDBList/RPDB/OMDb; this deliberately does NOT extend that one,
// since an LLM key is a credential in the Vault's own sense - rotatable,
// revocable, worth an expiry reminder - not a lightweight lookup key like
// those). baseUrl/model live in the entry's own testConfig JSON, the same
// free-form per-entry config slot vaultCheckers.js reads for HTTP checks -
// an AI entry just doesn't need a checker to also use that slot for its own
// provider config. Defaults to OpenAI's endpoint but is not vendor-locked:
// any OpenAI-compatible /chat/completions endpoint works (OpenRouter, Groq,
// a local proxy), which is the whole reason Vault's "AI Services" category
// was already phrased generically rather than "OpenAI API Key."
async function resolveAiCredentials(prisma, accountId, decrypt) {
  try {
    const entry = await prisma.vaultEntry.findFirst({
      where: { accountId, category: 'ai', isActive: true },
      orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
    })
    if (!entry) return null

    const apiKey = decrypt(entry.encryptedSecret, { appAccountId: accountId })
    if (!apiKey) return null

    let config = {}
    try { config = entry.testConfig ? JSON.parse(entry.testConfig) : {} } catch { config = {} }

    return {
      apiKey,
      baseUrl: (typeof config.baseUrl === 'string' && config.baseUrl.trim()) ? config.baseUrl.trim().replace(/\/+$/, '') : 'https://api.openai.com/v1',
      model: (typeof config.model === 'string' && config.model.trim()) ? config.model.trim() : 'gpt-4o-mini',
      entryName: entry.name,
    }
  } catch {
    return null
  }
}

// ---- Stage 1b: description -> structured query -----------------------------

const QUERY_SCHEMA_HINT = `Return ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "type": "movie" | "series" | null,
  "genres": string[],
  "yearFrom": number | null,
  "yearTo": number | null,
  "maxRuntimeMinutes": number | null,
  "keywords": string[]
}
- "type": null if the request doesn't specify movie vs series/show.
- "genres": real genre words like "Action", "Horror", "Comedy", "Neo-noir" -> "Thriller", "Crime" for genre-adjacent terms. Empty array if none implied.
- "yearFrom"/"yearTo": a decade like "90s" becomes 1990/1999. A single year stays a single year (yearFrom=yearTo). null/null if no time period implied.
- "maxRuntimeMinutes": only set from an explicit runtime constraint ("under 2 hours" -> 120). null otherwise.
- "keywords": any other meaningful descriptive words (mood, setting, theme) not captured above, for a general-purpose search fallback. Ignore filler like "nobody has seen" or "that we haven't watched" - unwatched is already guaranteed elsewhere, not something to search for.`

async function callAi(description, creds) {
  const { signal, cancel } = timeoutSignal(FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        model: creds.model,
        messages: [
          { role: 'system', content: QUERY_SCHEMA_HINT },
          { role: 'user', content: description },
        ],
        temperature: 0.2,
      }),
      signal,
    })
    cancel()
    if (!res.ok) {
      // Include the provider's own error body when there is one (wrong
      // model name, invalid key, etc.) - a bare status code alone left
      // literally every failure mode looking identical from the outside.
      let detail = ''
      try {
        const body = await res.json()
        detail = body?.error?.message || body?.message || ''
      } catch { /* body wasn't JSON, or was empty - status code is all we get */ }
      throw new Error(`AI provider returned ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('AI provider returned no content')
    // Strip a markdown fence if the model wrapped its JSON in one anyway,
    // despite being told not to - cheap insurance, several OpenAI-compatible
    // providers do this by default regardless of the system prompt.
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
    const parsed = JSON.parse(cleaned)
    return normalizeQuery(parsed)
  } catch (err) {
    cancel()
    throw err
  }
}

// Word-boundary keyword parser - the zero-setup fallback. Deliberately
// simple (a fixed word list, not NLP) since its job is "don't leave the
// feature dead with no AI key configured," not "match the AI's quality."
const DECADE_FULL_RE = /\b(19[0-9]0|20[0-9]0)s\b/i
// Shorthand decades ("90s", "00s", "80s") - the form the feature's own
// example ("A 90s neo-noir...") actually uses, so this isn't optional.
// XX <= 29 reads as 20XX0 (a bare "20s"/"10s"/"00s" means the current
// century in ordinary conversation), otherwise 19XX0.
const DECADE_SHORT_RE = /\b([0-9]0)s\b/
const YEAR_RE = /\b(19[0-9]{2}|20[0-9]{2})\b/
// Accepts digits ("under 2 hours") AND spelled-out small numbers ("under two
// hours," the exact phrasing this feature was pitched with - a runtime
// constraint is almost always said in words, not digits, so the digit-only
// version this started as would have missed the common case entirely.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
const RUNTIME_RE = /\bunder\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(hours?|hrs?|minutes?|mins?)\b/i
const TYPE_SERIES_RE = /\b(series|show|shows|tv series)\b/i
const TYPE_MOVIE_RE = /\b(movie|movies|film|films)\b/i
const GENRE_WORDS = [
  'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama',
  'family', 'fantasy', 'history', 'horror', 'music', 'mystery', 'romance',
  'science fiction', 'sci-fi', 'scifi', 'thriller', 'war', 'western', 'noir', 'neo-noir',
]
// Words that read as genre-ish but aren't real TMDb genres - mapped to the
// closest real one so the fallback parser still produces something useful.
const GENRE_ALIASES = { 'noir': 'Crime', 'neo-noir': 'Thriller', 'sci-fi': 'Science Fiction', scifi: 'Science Fiction' }

function parseDescriptionFallback(description) {
  const text = (description || '').toLowerCase()

  let yearFrom = null
  let yearTo = null
  const fullMatch = text.match(DECADE_FULL_RE)
  const shortMatch = !fullMatch && text.match(DECADE_SHORT_RE)
  if (fullMatch) {
    yearFrom = Number(fullMatch[1])
    yearTo = yearFrom + 9
  } else if (shortMatch) {
    const twoDigit = Number(shortMatch[1])
    yearFrom = (twoDigit <= 29 ? 2000 : 1900) + twoDigit
    yearTo = yearFrom + 9
  } else {
    const yearMatch = text.match(YEAR_RE)
    if (yearMatch) { yearFrom = Number(yearMatch[1]); yearTo = Number(yearMatch[1]) }
  }

  let maxRuntimeMinutes = null
  const runtimeMatch = text.match(RUNTIME_RE)
  if (runtimeMatch) {
    const n = NUMBER_WORDS[runtimeMatch[1].toLowerCase()] ?? Number(runtimeMatch[1])
    maxRuntimeMinutes = /h/i.test(runtimeMatch[2]) ? n * 60 : n
  }

  let type = null
  if (TYPE_SERIES_RE.test(text)) type = 'series'
  else if (TYPE_MOVIE_RE.test(text)) type = 'movie'

  const genres = []
  for (const word of GENRE_WORDS) {
    if (text.includes(word)) genres.push(GENRE_ALIASES[word] || (word.charAt(0).toUpperCase() + word.slice(1)))
  }

  return normalizeQuery({ type, genres: [...new Set(genres)], yearFrom, yearTo, maxRuntimeMinutes, keywords: [] })
}

// Number(null) coerces to 0, and 0 passes Number.isFinite - so a bare
// Number.isFinite(Number(x)) silently turns "no value" into a real 0. This
// rejects null/undefined/'' explicitly before the numeric coercion, which a
// year of 0 or a runtime of 0 minutes would otherwise sail through as.
function toFiniteOrNull(value, { positive = false } = {}) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (positive && n <= 0) return null
  return n
}

function normalizeQuery(raw) {
  return {
    type: raw?.type === 'series' ? 'series' : raw?.type === 'movie' ? 'movie' : null,
    genres: Array.isArray(raw?.genres) ? raw.genres.filter((g) => typeof g === 'string' && g.trim()).slice(0, 5) : [],
    yearFrom: toFiniteOrNull(raw?.yearFrom),
    yearTo: toFiniteOrNull(raw?.yearTo),
    maxRuntimeMinutes: toFiniteOrNull(raw?.maxRuntimeMinutes, { positive: true }),
    keywords: Array.isArray(raw?.keywords) ? raw.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 5) : [],
  }
}

/** @returns {Promise<{query: object, usedAi: boolean, aiError: string|null}>} */
async function parseDescription(prisma, accountId, decrypt, description) {
  const creds = await resolveAiCredentials(prisma, accountId, decrypt)
  if (creds) {
    try {
      const query = await callAi(description, creds)
      return { query, usedAi: true, aiError: null }
    } catch (err) {
      // Previously silent - a wrong model/baseUrl pairing (e.g. a Gemini
      // model name against OpenAI's own endpoint) failed exactly like a
      // missing key would, from the client's perspective: no error, just a
      // fallback to the keyword parser with no way to tell why. Surfacing
      // this specifically so a misconfigured key doesn't read as "not
      // working" with no further information.
      console.warn('[NLCatalog] AI parse failed, falling back to keyword parser:', err?.message || err)
      return { query: parseDescriptionFallback(description), usedAi: false, aiError: err?.message || 'AI request failed' }
    }
  }
  return { query: parseDescriptionFallback(description), usedAi: false, aiError: null }
}

// ---- Stage 2: structured query -> TMDb Discover -> IMDb items -------------

let genreCache = null // { movie: Map<lowerName, id>, tv: Map<lowerName, id>, at: number }
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

async function loadGenreMaps(tmdbKey) {
  if (genreCache && (Date.now() - genreCache.at) < GENRE_CACHE_TTL_MS) return genreCache
  const [movieRes, tvRes] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/genre/movie/list?api_key=${encodeURIComponent(tmdbKey)}`),
    fetch(`https://api.themoviedb.org/3/genre/tv/list?api_key=${encodeURIComponent(tmdbKey)}`),
  ])
  const movieData = movieRes.ok ? await movieRes.json() : { genres: [] }
  const tvData = tvRes.ok ? await tvRes.json() : { genres: [] }
  genreCache = {
    movie: new Map((movieData.genres || []).map((g) => [g.name.toLowerCase(), g.id])),
    tv: new Map((tvData.genres || []).map((g) => [g.name.toLowerCase(), g.id])),
    at: Date.now(),
  }
  return genreCache
}

/** Genre words -> real TMDb ids for the given media type. Unmatched words are dropped, not an error - a Discover call with fewer genres than requested still returns something. */
function resolveGenreIds(genres, mediaType, maps) {
  const map = mediaType === 'tv' ? maps.tv : maps.movie
  const ids = []
  for (const g of genres) {
    const hit = map.get(g.toLowerCase()) ?? [...map.entries()].find(([name]) => name.includes(g.toLowerCase()))?.[1]
    if (hit) ids.push(hit)
  }
  return ids
}

// TMDb's Discover endpoint filters by keyword ID, not text - "heist",
// "time travel", "based on a true story" etc. only work as with_keywords
// once resolved through TMDb's own /search/keyword. A short cache avoids
// re-resolving the same common phrase across different descriptions in the
// same window; unlike genres (a small fixed set worth caching for a day),
// keyword phrases are open-ended, so this is capped and short-lived rather
// than an unbounded growing map.
const KEYWORD_CACHE_TTL_MS = 60 * 60 * 1000
const KEYWORD_CACHE_MAX = 200
const keywordCache = new Map() // lowercase phrase -> { id: number|null, at: number }

async function resolveKeywordId(phrase, tmdbKey) {
  const key = phrase.toLowerCase().trim()
  const cached = keywordCache.get(key)
  if (cached && (Date.now() - cached.at) < KEYWORD_CACHE_TTL_MS) return cached.id

  let id = null
  try {
    const res = await fetch(`https://api.themoviedb.org/3/search/keyword?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(key)}`)
    if (res.ok) {
      const data = await res.json()
      // TMDb's keyword search has no relevance score beyond result order -
      // for a short, well-formed phrase (what the parser/AI extracts, not
      // raw freeform text) the first result is reliably the intended match.
      id = data.results?.[0]?.id ?? null
    }
  } catch { /* leave id null - a keyword TMDb can't resolve just drops out, same as an unmatched genre */ }

  if (keywordCache.size >= KEYWORD_CACHE_MAX) keywordCache.clear() // simple bound, not LRU - this cache is a minor optimization, not correctness-critical
  keywordCache.set(key, { id, at: Date.now() })
  return id
}

/** keyword phrases -> real TMDb keyword ids. Unmatched phrases are dropped, not an error - same "fewer filters than requested still returns something" contract as resolveGenreIds. */
async function resolveKeywordIds(keywords, tmdbKey) {
  if (!keywords || keywords.length === 0) return []
  const { mapLimit } = require('./listImport')
  const ids = await mapLimit(keywords, 3, (kw) => resolveKeywordId(kw, tmdbKey))
  return ids.filter((id) => id !== null)
}

async function discoverFromQuery(query, tmdbKey) {
  const mediaType = query.type === 'series' ? 'tv' : 'movie' // default to movie when unspecified - the common case for a casual description
  const maps = await loadGenreMaps(tmdbKey)
  const genreIds = resolveGenreIds(query.genres, mediaType, maps)

  const params = new URLSearchParams({
    api_key: tmdbKey,
    sort_by: 'vote_average.desc',
    'vote_count.gte': '50', // filters out obscure/no-rating noise so results read as real recommendations
    include_adult: 'false',
  })
  if (genreIds.length) params.set('with_genres', genreIds.join(','))
  if (query.maxRuntimeMinutes) params.set('with_runtime.lte', String(query.maxRuntimeMinutes))
  if (query.keywords.length) {
    const keywordIds = await resolveKeywordIds(query.keywords, tmdbKey)
    // Pipe = OR, not comma (AND) - these are independent descriptive terms
    // pulled from a loose description ("heist", "time travel"), not a
    // checklist every result must satisfy. Requiring all of them would
    // return near-empty results for anything but a very literal match.
    if (keywordIds.length) params.set('with_keywords', keywordIds.join('|'))
  }

  const dateField = mediaType === 'tv' ? 'first_air_date' : 'primary_release_date'
  if (query.yearFrom) params.set(`${dateField}.gte`, `${query.yearFrom}-01-01`)
  if (query.yearTo) params.set(`${dateField}.lte`, `${query.yearTo}-12-31`)

  const { signal, cancel } = timeoutSignal(FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.themoviedb.org/3/discover/${mediaType}?${params.toString()}`, { signal })
    cancel()
    if (!res.ok) return { mediaType, results: [] }
    const data = await res.json()
    return { mediaType, results: (data.results || []).slice(0, CANDIDATE_POOL) }
  } catch {
    cancel()
    return { mediaType, results: [] }
  }
}

/** TMDb id -> real IMDb id + our catalog-item shape. null on no IMDb match (unresolvable items are dropped, not shown with a fake id). */
async function resolveToImdbItem(tmdbResult, mediaType, tmdbKey) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbResult.id}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!data.imdb_id) return null
    return {
      id: data.imdb_id,
      type: mediaType === 'tv' ? 'series' : 'movie',
      name: tmdbResult.title || tmdbResult.name || 'Unknown',
      poster: tmdbResult.poster_path ? `https://image.tmdb.org/t/p/w342${tmdbResult.poster_path}` : null,
      year: (tmdbResult.release_date || tmdbResult.first_air_date) ? Number((tmdbResult.release_date || tmdbResult.first_air_date).slice(0, 4)) : null,
    }
  } catch {
    return null
  }
}

async function buildWatchedIdSet(prisma, accountId) {
  const [movies, episodes] = await Promise.all([
    prisma.movieWatchHistory.findMany({ where: { accountId }, select: { itemId: true }, distinct: ['itemId'] }),
    prisma.episodeWatchHistory.findMany({ where: { accountId }, select: { showId: true }, distinct: ['showId'] }),
  ])
  return new Set([...movies.map((m) => m.itemId), ...episodes.map((e) => e.showId)])
}

/**
 * The full pipeline: free-text description -> saved-catalog-ready items.
 * @returns {Promise<{ items: Array, query: object, usedAi: boolean, aiError: string|null, mediaType: 'movie'|'tv' }>}
 */
async function generateCatalogFromDescription(prisma, accountId, decrypt, description) {
  const trimmed = (description || '').trim()
  if (!trimmed) throw new Error('Description is required')
  if (trimmed.length > 500) throw new Error('Description is too long (max 500 characters)')

  // No req object in scope here (this runs from a plain route handler with
  // account scoping already resolved) - same accountId-only pattern
  // refreshListFromSourceForAccount already uses for the identical reason.
  const { resolveTmdbKey } = require('./listImport')
  const tmdbKey = await resolveTmdbKey(prisma, () => accountId, null)
  if (!tmdbKey) throw new Error('A TMDb API key is required for this feature (Settings -> External API Keys)')

  const { query, usedAi, aiError } = await parseDescription(prisma, accountId, decrypt, trimmed)
  const { mediaType, results } = await discoverFromQuery(query, tmdbKey)
  if (results.length === 0) return { items: [], query, usedAi, aiError, mediaType }

  const watchedIds = await buildWatchedIdSet(prisma, accountId)
  const { mapLimit } = require('./listImport')
  const resolved = await mapLimit(results, 5, (r) => resolveToImdbItem(r, mediaType, tmdbKey))

  const items = resolved.filter((item) => item && !watchedIds.has(item.id)).slice(0, MAX_ITEMS)
  return { items, query, usedAi, aiError, mediaType }
}

module.exports = {
  resolveAiCredentials,
  parseDescription,
  parseDescriptionFallback,
  discoverFromQuery,
  resolveGenreIds,
  resolveKeywordIds,
  generateCatalogFromDescription,
  normalizeQuery,
  // Exported for Settings' "verify on save" check (server/routes/settings.js)
  // specifically so that check exercises the EXACT same request shape the
  // real feature sends - a generic "does this endpoint respond at all" ping
  // would have passed for the wrong-model-for-this-provider case that
  // originally prompted adding real verification at all.
  callAi,
}
