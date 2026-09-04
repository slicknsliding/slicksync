// AniList integration - the metadata layer anime actually needs.
//
// Why a separate source at all: Cinemeta is built around IMDb-style seasons,
// and long-running anime routinely ship as ONE continuous run (absolute
// numbering: episode 37) while the seasons people talk about - and the way
// releases are labelled - are S2E13. That mismatch is the single biggest
// reason anime progress and Continue Watching go wrong here. AniList
// publishes the season/episode structure, exact airing times, and the
// prequel/sequel relation graph, which is also what makes a franchise's
// watch order answerable instead of a thing people google.
//
// No API key: AniList's GraphQL endpoint is public and unauthenticated for
// everything used here (search, media by id, airing schedules, relations).
// That is deliberate - it keeps anime support from becoming another key to
// manage, and it means nothing here can spend someone's quota.
//
// Rate limits are AniList's own (degraded but generous); every call is
// wrapped in a short timeout and a cache, and every failure returns null so
// anime metadata can only ever ADD to what Cinemeta already provides.

const ANILIST_URL = 'https://graphql.anilist.co'
const TIMEOUT_MS = 6000
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // titles change slowly; airing data is the volatile part and still refreshes twice a day
const cache = new Map()
const MAX_CACHE = 400

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() })
  if (cache.size > MAX_CACHE) {
    // Oldest-first eviction; Map preserves insertion order.
    const drop = cache.size - MAX_CACHE
    let i = 0
    for (const k of cache.keys()) { if (i++ >= drop) break; cache.delete(k) }
  }
}

async function query(gql, variables) {
  const key = `${gql}:${JSON.stringify(variables)}`
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data ?? null
    cacheSet(key, data)
    return data
  } catch {
    return null
  }
}

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  format
  status
  episodes
  season
  seasonYear
  averageScore
  genres
  coverImage { large }
  siteUrl
  nextAiringEpisode { episode airingAt timeUntilAiring }
  relations { edges { relationType node { id title { romaji english } format seasonYear episodes } } }
`

/** Finds an anime by title (and optional year), best match first. */
async function searchAnime(title, year) {
  if (!title) return null
  const data = await query(
    `query ($search: String, $year: Int) {
      Page(perPage: 5) {
        media(search: $search, type: ANIME, seasonYear: $year, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
      }
    }`,
    { search: String(title).slice(0, 100), year: Number.isInteger(year) ? year : undefined }
  )
  const list = data?.Page?.media
  return Array.isArray(list) && list.length > 0 ? list[0] : null
}

/** One anime by AniList id. */
async function getAnimeById(anilistId) {
  const id = Number(anilistId)
  if (!Number.isInteger(id)) return null
  const data = await query(`query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`, { id })
  return data?.Media || null
}

/**
 * This season's airing anime - the row anime watchers actually browse by.
 * `sort: POPULARITY_DESC` matches what every seasonal chart shows.
 */
async function getSeasonalAnime({ season, seasonYear, perPage = 40 } = {}) {
  const now = new Date()
  const month = now.getUTCMonth() + 1
  const currentSeason = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL'
  const data = await query(
    `query ($season: MediaSeason, $seasonYear: Int, $perPage: Int) {
      Page(perPage: $perPage) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_FIELDS} }
      }
    }`,
    { season: season || currentSeason, seasonYear: seasonYear || now.getUTCFullYear(), perPage: Math.min(50, perPage) }
  )
  return Array.isArray(data?.Page?.media) ? data.Page.media : []
}

/**
 * Orders a franchise into something watchable: walks PREQUEL/SEQUEL edges
 * from the given entry and returns the chain in release order, with side
 * stories and movies listed separately rather than jammed into the line -
 * anime watch orders are exactly the thing people go looking for charts to
 * answer, and a wrong "next" is worse than none.
 */
async function getWatchOrder(anilistId) {
  const root = await getAnimeById(anilistId)
  if (!root) return null
  const edges = Array.isArray(root.relations?.edges) ? root.relations.edges : []
  const pick = (types) => edges
    .filter((e) => types.includes(e?.relationType))
    .map((e) => e.node)
    .filter(Boolean)
    .sort((a, b) => (a?.seasonYear || 0) - (b?.seasonYear || 0))
  return {
    current: root,
    mainLine: [...pick(['PREQUEL']), root, ...pick(['SEQUEL'])],
    sideStories: pick(['SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF']),
    movies: pick(['SUMMARY', 'PARENT']).filter((n) => n?.format === 'MOVIE'),
  }
}

/** Human-readable countdown to the next episode, or null when not airing. */
function nextEpisodeCountdown(media) {
  const next = media?.nextAiringEpisode
  if (!next || !Number.isFinite(next.timeUntilAiring)) return null
  const secs = next.timeUntilAiring
  if (secs <= 0) return null
  const days = Math.floor(secs / 86400)
  const hours = Math.floor((secs % 86400) / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (!days && mins) parts.push(`${mins}m`)
  return {
    episode: next.episode,
    airingAt: new Date(next.airingAt * 1000).toISOString(),
    label: parts.length ? parts.join(' ') : 'soon',
  }
}

/**
 * Maps an ABSOLUTE episode number onto its real season/episode, using the
 * franchise's prequel chain to know how many episodes came before. This is
 * the numbering fix: a release labelled "episode 37" of a show whose first
 * run was 24 episodes is season 2, episode 13.
 *
 * Returns null when the chain can't be established - a guess here would put
 * someone's progress on the wrong episode, which is worse than no answer.
 */
async function resolveAbsoluteEpisode(anilistId, absoluteEpisode) {
  const abs = Number(absoluteEpisode)
  if (!Number.isInteger(abs) || abs < 1) return null
  const order = await getWatchOrder(anilistId)
  if (!order || order.mainLine.length === 0) return null

  let remaining = abs
  let seasonNumber = 0
  for (const entry of order.mainLine) {
    seasonNumber += 1
    const count = Number(entry?.episodes)
    if (!Number.isFinite(count) || count <= 0) return null // unknown length - cannot place it honestly
    if (remaining <= count) {
      return { season: seasonNumber, episode: remaining, seasonTitle: entry?.title?.english || entry?.title?.romaji || null }
    }
    remaining -= count
  }
  return null
}

module.exports = {
  searchAnime,
  getAnimeById,
  getSeasonalAnime,
  getWatchOrder,
  nextEpisodeCountdown,
  resolveAbsoluteEpisode,
}
