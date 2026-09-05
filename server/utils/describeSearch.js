// Tip-of-the-tongue search: "the one where the guy relives the same day at
// war" -> Edge of Tomorrow.
//
// Deliberately NOT the same thing as nlCatalog.js's "describe a catalog":
// that turns a description into a structured TMDb Discover QUERY (genres,
// years, runtime) because a catalog is a set defined by criteria. This
// answers a different question - a specific film someone half-remembers -
// which no genre/keyword query can reach, because the memory is of the PLOT.
// It does reuse that module's AI credential resolution and text call rather
// than opening a second path to the same key.
//
// The rule that makes this safe: the model is only ever asked to NAME
// candidates, never to describe them. Every name is then resolved against
// TMDb, and anything TMDb doesn't recognise is dropped. So the results a
// user sees are always real records with real metadata - a hallucinated
// title fails resolution and simply never appears, rather than being shown
// with invented details.

// 45s, not the 12s this started with. A tip-of-the-tongue search is a
// deliberate, one-shot request someone is actively waiting on - unlike the
// background parsing nlCatalog does - and slower/free-tier models genuinely
// take 15-30s to answer. The old ceiling turned "the model is thinking" into
// "The AI provider could not be reached", which reads as broken rather than
// slow (reported live against a Gemini flash-lite endpoint).
const TIMEOUT_MS = 45000
const MAX_CANDIDATES = 6

const PROMPT = `You identify films and TV shows from vague plot descriptions.
Reply with ONLY a JSON array of up to ${MAX_CANDIDATES} objects, best guess first, like:
[{"title":"Edge of Tomorrow","year":2014,"type":"movie"}]
Rules:
- "type" must be exactly "movie" or "series".
- Use the title as it is commonly known in English.
- If you are unsure, still give your best guesses - they are verified afterwards.
- No prose, no explanation, no markdown fences. JSON array only.`

function parseCandidates(raw) {
  if (!raw) return []
  // Models sometimes wrap JSON in fences despite being told not to.
  const cleaned = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  let parsed
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((c) => c && typeof c.title === 'string' && c.title.trim())
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({
      title: String(c.title).trim().slice(0, 120),
      year: Number.isFinite(Number(c.year)) ? Number(c.year) : null,
      type: c.type === 'series' ? 'series' : 'movie',
    }))
}

/**
 * Verifies one candidate against TMDb and returns a real item, or null.
 * This is the anti-hallucination step: a title the model invented has no
 * TMDb record and therefore never reaches the user.
 */
async function verifyCandidate(candidate, tmdbKey) {
  const path = candidate.type === 'series' ? 'tv' : 'movie'
  const params = new URLSearchParams({ api_key: tmdbKey, query: candidate.title })
  if (candidate.year) params.set(candidate.type === 'series' ? 'first_air_date_year' : 'year', String(candidate.year))
  try {
    const res = await fetch(`https://api.themoviedb.org/3/search/${path}?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const hit = Array.isArray(data?.results) ? data.results[0] : null
    if (!hit?.id) return null

    // IMDb id, because that is the currency the rest of the app speaks
    // (Discover, watchlist, history and every deep link are tt-based).
    const extRes = await fetch(`https://api.themoviedb.org/3/${path}/${hit.id}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!extRes.ok) return null
    const ext = await extRes.json()
    if (!ext?.imdb_id || !/^tt\d+$/.test(ext.imdb_id)) return null

    const released = hit.release_date || hit.first_air_date || ''
    return {
      id: ext.imdb_id,
      type: candidate.type,
      name: hit.title || hit.name || candidate.title,
      poster: hit.poster_path ? `https://image.tmdb.org/t/p/w342${hit.poster_path}` : null,
      releaseInfo: released ? String(released).slice(0, 4) : null,
      description: hit.overview || null,
    }
  } catch {
    return null
  }
}

/**
 * description -> verified real titles. Throws only for missing setup (no AI
 * credential, no TMDb key); an AI that answers badly yields an empty list
 * rather than an error, since "I couldn't place it" is a legitimate answer
 * to a vague description.
 */
async function searchByDescription(prisma, accountId, decrypt, description, tmdbKey) {
  const text = String(description || '').trim()
  if (!text) throw new Error('Describe what you remember about it first')
  if (!tmdbKey) throw new Error('A TMDb key is needed to verify results (Settings -> External API Keys)')

  const { resolveAiCredentials, callAiText } = require('./nlCatalog')
  const creds = await resolveAiCredentials(prisma, accountId, decrypt)
  if (!creds) {
    // Deliberately a clear setup error rather than a silent empty result -
    // unlike catalog descriptions, there is no keyword fallback that could
    // answer a plot memory, so pretending to search would be dishonest.
    throw new Error('This needs an AI key (Settings -> External API Keys -> AI Services). Plot descriptions can only be interpreted by a model.')
  }

  let raw
  const startedAt = Date.now()
  try {
    raw = await callAiText(`${PROMPT}\n\nDescription: ${text}`, creds, { maxTokens: 400, timeoutMs: TIMEOUT_MS })
  } catch (e) {
    // Distinguish "took too long" from "could not be reached" - they lead to
    // completely different fixes (pick a faster model vs check the key/URL).
    const waited = Math.round((Date.now() - startedAt) / 1000)
    const aborted = /abort/i.test(e?.message || '')
    // Elapsed time and model name are in the message on purpose: a timeout
    // that only says "aborted" is unfalsifiable after the fact. Knowing it
    // waited the full ceiling - rather than failing instantly - is the
    // difference between "pick a faster model" and "something else broke".
    if (aborted) {
      console.warn(`[DescribeSearch] ${creds.model} did not answer within ${waited}s`)
      throw new Error(`The AI model (${creds.model}) did not answer within ${waited}s. It is normally far faster, so try again - if it keeps happening, a "flash"/"mini" tier model in Settings -> Integrations -> AI Services is more reliable.`)
    }
    throw new Error(`The AI provider could not be reached after ${waited}s: ${e?.message || 'unknown error'}`)
  }

  const candidates = parseCandidates(raw)
  if (candidates.length === 0) return { items: [], candidates: 0 }

  const verified = []
  const seen = new Set()
  for (const candidate of candidates) {
    const item = await verifyCandidate(candidate, tmdbKey)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      verified.push(item)
    }
  }
  return { items: verified, candidates: candidates.length }
}

module.exports = { searchByDescription, parseCandidates, verifyCandidate }
