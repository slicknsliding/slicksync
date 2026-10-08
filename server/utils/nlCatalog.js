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

    // Failover: a key whose own health check last came back failing hands
    // off to its configured backup entry, so an expired or revoked AI key
    // doesn't drop this back to the keyword parser when a spare exists.
    // The backup's own testConfig wins too - a different provider needs its
    // own baseUrl/model, not the dead entry's.
    const { resolveVaultSecret } = require('./vaultFailover')
    const { secret: apiKey, entry: sourceEntry } = await resolveVaultSecret(prisma, entry, decrypt)
    if (!apiKey) return null

    let config = {}
    try { config = sourceEntry.testConfig ? JSON.parse(sourceEntry.testConfig) : {} } catch { config = {} }

    return {
      apiKey,
      baseUrl: (typeof config.baseUrl === 'string' && config.baseUrl.trim()) ? config.baseUrl.trim().replace(/\/+$/, '') : 'https://api.openai.com/v1',
      // Was 'gpt-4o-mini' - OpenAI retired that model. This default only
      // matters for someone who saved a key with the model field left
      // blank; anyone who picks a model explicitly (the Settings dropdown
      // now suggests live options from the provider itself) never hits it.
      // Providers rotate their lineups fast enough that even this fallback
      // will need occasional updates - it's a "reasonably current as of
      // when this was written" default, not a permanent guarantee.
      model: (typeof config.model === 'string' && config.model.trim()) ? config.model.trim() : 'gpt-5.2-mini',
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
  "excludeGenres": string[],
  "yearFrom": number | null,
  "yearTo": number | null,
  "maxRuntimeMinutes": number | null,
  "cast": string[],
  "castMatch": "all" | "any",
  "directors": string[],
  "seriesStatus": "airing" | "ended" | null,
  "keywords": string[]
}
- "type": null if the request doesn't specify movie vs series/show.
- "genres": real genre words like "Action", "Horror", "Comedy", "Neo-noir" -> "Thriller", "Crime" for genre-adjacent terms. Empty array if none implied.
- "excludeGenres": genres the request rules out ("comedy but not romance" -> ["Romance"]). Empty array otherwise.
- "cast": full names of actors the request names ("with Tom Hanks", "Pacino and De Niro films" -> ["Al Pacino", "Robert De Niro"]). Expand a surname to the full name only when it is unambiguous. "castMatch": "all" when every one of them must be in it ("both", "and", "together"), "any" for "or". Empty array if no actor is named.
- "directors": full names of directors the request names ("Christopher Nolan films", "directed by Villeneuve" -> ["Denis Villeneuve"]). Empty array otherwise.
- "seriesStatus": "airing" for shows still running, "ended" for finished ones, null otherwise.
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

  // "comedy but not romance", "no horror", "without musicals" rule a genre out.
  const genres = []
  const excludeGenres = []
  for (const word of GENRE_WORDS) {
    if (!text.includes(word)) continue
    const name = GENRE_ALIASES[word] || (word.charAt(0).toUpperCase() + word.slice(1))
    const ruledOut = new RegExp(`\\b(not|no|without|except|but not)\\s+(any\\s+)?${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
    ;(ruledOut ? excludeGenres : genres).push(name)
  }

  // Names keep their capitals, so these read the description as typed.
  const directors = []
  const directed = (description || '').match(/\bdirected by ((?:[A-Z][\w.'-]+\s?){2,4})/)
  if (directed) directors.push(directed[1].trim())
  const cast = []
  const starring = (description || '').match(/\b(?:starring|with)\s+((?:[A-Z][\w.'-]+\s?){2,4})(?:\s*(and|or)\s+((?:[A-Z][\w.'-]+\s?){2,4}))?/)
  if (starring) {
    cast.push(starring[1].trim())
    if (starring[3]) cast.push(starring[3].trim())
  }

  return normalizeQuery({
    type, genres: [...new Set(genres)], excludeGenres: [...new Set(excludeGenres)], yearFrom, yearTo, maxRuntimeMinutes, keywords: [],
    cast, castMatch: starring?.[2] === 'or' ? 'any' : 'all', directors,
  })
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

// How a rule's titles are ordered. 'trending' needs LumiereDB - TMDb's
// Discover has no such order, so there it falls back to popularity.
const SORTS = ['popular', 'trending', 'top_rated', 'votes', 'newest', 'oldest']

function nameList(raw, max) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 80)))].slice(0, max)
}

function normalizeQuery(raw) {
  return {
    type: raw?.type === 'series' ? 'series' : raw?.type === 'movie' ? 'movie' : null,
    genres: Array.isArray(raw?.genres) ? raw.genres.filter((g) => typeof g === 'string' && g.trim()).slice(0, 5) : [],
    excludeGenres: nameList(raw?.excludeGenres, 5),
    yearFrom: toFiniteOrNull(raw?.yearFrom),
    yearTo: toFiniteOrNull(raw?.yearTo),
    minRuntimeMinutes: toFiniteOrNull(raw?.minRuntimeMinutes, { positive: true }),
    maxRuntimeMinutes: toFiniteOrNull(raw?.maxRuntimeMinutes, { positive: true }),
    // Votes on IMDb's scale - the floor that keeps a 9.8 with twelve votes out.
    minVotes: toFiniteOrNull(raw?.minVotes, { positive: true }),
    sort: SORTS.includes(raw?.sort) ? raw.sort : null,
    // Series only: still airing, or ended - and since when it last aired.
    seriesStatus: raw?.seriesStatus === 'airing' || raw?.seriesStatus === 'ended' ? raw.seriesStatus : null,
    lastAiredFrom: toFiniteOrNull(raw?.lastAiredFrom),
    // People by name: actors (all of them in it, or any), and directors.
    cast: nameList(raw?.cast, 5),
    castMatch: raw?.castMatch === 'any' ? 'any' : 'all',
    directors: nameList(raw?.directors, 3),
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

const TMDB_SORT = {
  popular: () => 'popularity.desc',
  trending: () => 'popularity.desc',
  top_rated: () => 'vote_average.desc',
  votes: () => 'vote_count.desc',
  newest: (dateField) => `${dateField}.desc`,
  oldest: (dateField) => `${dateField}.asc`,
}

/**
 * Structured query -> raw TMDb Discover rows. `mediaType` overrides the
 * query's own type (a "movies and series" rule asks once for each);
 * `pages` pulls more than TMDb's 20 a page; `people` carries TMDb person
 * ids already looked up for the query's cast and directors (movies only -
 * TMDb's series Discover has no people filter).
 */
async function discoverFromQuery(query, tmdbKey, { mediaType: forced, pages = 1, people = null } = {}) {
  const mediaType = forced || (query.type === 'series' ? 'tv' : 'movie') // default to movie when unspecified - the common case for a casual description
  const maps = await loadGenreMaps(tmdbKey)
  const genreIds = resolveGenreIds(query.genres, mediaType, maps)
  const withoutIds = resolveGenreIds(query.excludeGenres || [], mediaType, maps)
  const dateField = mediaType === 'tv' ? 'first_air_date' : 'primary_release_date'

  // IMDb counts votes in far larger numbers than TMDb does - a film with
  // 100,000 on IMDb has a couple of thousand on TMDb.
  const voteFloor = query.minVotes ? Math.max(10, Math.round(query.minVotes / 50)) : 50

  const params = new URLSearchParams({
    api_key: tmdbKey,
    sort_by: (TMDB_SORT[query.sort] || TMDB_SORT.top_rated)(dateField),
    'vote_count.gte': String(voteFloor), // filters out obscure/no-rating noise so results read as real recommendations
    include_adult: 'false',
  })
  if (genreIds.length) params.set('with_genres', genreIds.join(','))
  if (withoutIds.length) params.set('without_genres', withoutIds.join(','))
  if (query.minRuntimeMinutes) params.set('with_runtime.gte', String(query.minRuntimeMinutes))
  if (query.maxRuntimeMinutes) params.set('with_runtime.lte', String(query.maxRuntimeMinutes))
  if (query.minRating) params.set('vote_average.gte', String(query.minRating))
  if (mediaType === 'tv') {
    // TMDb's series status: 0 returning, 3 ended, 4 cancelled.
    if (query.seriesStatus === 'airing') params.set('with_status', '0')
    if (query.seriesStatus === 'ended') params.set('with_status', '3|4')
    if (query.lastAiredFrom) params.set('air_date.gte', `${query.lastAiredFrom}-01-01`)
  } else if (people) {
    if (people.cast.length) params.set('with_cast', people.cast.join(query.castMatch === 'any' ? '|' : ','))
    if (people.directors.length) params.set('with_crew', people.directors.join('|'))
  }
  if (query.keywords.length) {
    const keywordIds = await resolveKeywordIds(query.keywords, tmdbKey)
    // Pipe = OR, not comma (AND) - these are independent descriptive terms
    // pulled from a loose description ("heist", "time travel"), not a
    // checklist every result must satisfy. Requiring all of them would
    // return near-empty results for anything but a very literal match.
    if (keywordIds.length) params.set('with_keywords', keywordIds.join('|'))
  }

  if (query.yearFrom) params.set(`${dateField}.gte`, `${query.yearFrom}-01-01`)
  if (query.yearTo) params.set(`${dateField}.lte`, `${query.yearTo}-12-31`)

  const results = []
  let failed = false
  for (let page = 1; page <= Math.max(1, Math.min(5, pages)); page++) {
    params.set('page', String(page))
    const { signal, cancel } = timeoutSignal(FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`https://api.themoviedb.org/3/discover/${mediaType}?${params.toString()}`, { signal })
      cancel()
      if (!res.ok) { failed = page === 1; break }
      const data = await res.json()
      results.push(...(data.results || []))
      if (page >= (data.total_pages || 1)) break
    } catch {
      cancel()
      failed = page === 1
      break
    }
  }
  // `failed`: TMDb didn't answer at all, which is not the same as nothing
  // matching - a Smart Catalog keeps its titles on the first.
  return { mediaType, results: pages > 1 ? results : results.slice(0, CANDIDATE_POOL), failed }
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

  const { query, usedAi, aiError } = await parseDescription(prisma, accountId, decrypt, trimmed)
  // A description that doesn't say movies or series has always meant movies.
  const asked = { ...query, type: query.type || 'movie' }
  const mediaType = asked.type === 'series' ? 'tv' : 'movie'

  // Already-watched titles are left out by the search itself (LumiereDB) or
  // straight after it (TMDb), so a household that has seen a lot still
  // gets a full preview.
  const watchedIds = await buildWatchedIdSet(prisma, accountId)
  const { findTitles } = require('./titleFinder')
  const { items, engine, ignored } = await findTitles(prisma, accountId, asked, { limit: MAX_ITEMS, excludeIds: [...watchedIds], tmdbKey })
  const { describeRule } = require('./smartCatalogs')
  return { items, query, usedAi, aiError, mediaType, engine, ignored, summary: describeRule(asked) }
}

// Generic plain-text completion, for AI uses beyond catalog-building's own
// structured-JSON callAi above (recommendation "why this matches" one-liners,
// addon health incident summaries). Same credential shape (resolveAiCredentials)
// and timeout pattern, just no schema/JSON parsing - callers get the model's
// raw text back, trimmed. A short maxTokens keeps this cheap to call from a
// hot GET path (a one-liner doesn't need a token budget built for prose).
async function callAiText(prompt, creds, { maxTokens = 60, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const { signal, cancel } = timeoutSignal(timeoutMs)
  try {
    const res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        model: creds.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: maxTokens,
      }),
      signal,
    })
    cancel()
    if (!res.ok) throw new Error(`AI provider returned ${res.status}`)
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('AI provider returned no content')
    return content.trim().replace(/^["']|["']$/g, '') // strip stray wrapping quotes some models add
  } catch (err) {
    cancel()
    throw err
  }
}

module.exports = {
  resolveAiCredentials,
  parseDescription,
  parseDescriptionFallback,
  discoverFromQuery,
  resolveGenreIds,
  loadGenreMaps,
  resolveKeywordIds,
  generateCatalogFromDescription,
  normalizeQuery,
  // Exported for Settings' "verify on save" check (server/routes/settings.js)
  // specifically so that check exercises the EXACT same request shape the
  // real feature sends - a generic "does this endpoint respond at all" ping
  // would have passed for the wrong-model-for-this-provider case that
  // originally prompted adding real verification at all.
  callAi,
  callAiText,
  // Used by smartCatalogs.js, which needs the same query -> real items
  // pipeline this module already implements (discover -> IMDb resolution ->
  // watched filtering) rather than a second copy of it.
  resolveToImdbItem,
  buildWatchedIdSet,
}
