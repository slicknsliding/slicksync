// Finds the titles a Smart Catalog rule or a described catalog asks for.
//
// With a LumiereDB that's ready, it asks LumiereDB: IMDb ids come straight
// back (no second lookup per title), the household's watched titles are
// left out before counting so the catalog comes back full, and the rules
// TMDb can't answer - IMDb's own rating and vote counts, a trending order -
// all work. Otherwise it asks TMDb as before, now a few pages deep so
// leaving out what's been watched doesn't leave the catalog short.
//
// Keywords ("heist", "time travel") are TMDb's alone: a query with keywords
// goes to TMDb whenever there's a key, LumiereDB or not.

const { normalizeQuery, discoverFromQuery, resolveToImdbItem } = require('./nlCatalog')
const lumiere = require('./lumiere')

const PERSON_TTL_MS = 24 * 60 * 60 * 1000
const tmdbPeople = new Map()

class PersonNotFound extends Error {}

function personNotFound(name) {
  return new PersonNotFound(`Couldn’t find anyone called “${name}”`)
}

/** A rule's year for "still airing": an episode this year or last. */
const recentYear = () => new Date().getFullYear() - 1

// ---- LumiereDB ----------------------------------------------------------

async function lumiereFilters(base, query, type) {
  const cast = []
  for (const name of query.cast) {
    const p = await lumiere.findPerson(base, name, type)
    if (!p) throw personNotFound(name)
    cast.push(p.nconst)
  }
  const directors = []
  for (const name of query.directors) {
    const p = await lumiere.findPerson(base, name, type)
    if (!p) throw personNotFound(name)
    directors.push(p.nconst)
  }
  const sort = query.sort || 'top_rated'
  const filters = {
    genres: query.genres.map(lumiere.genreSlug),
    exclude_genres: query.excludeGenres.map(lumiere.genreSlug),
    year_from: query.yearFrom,
    year_to: query.yearTo,
    min_rating: query.minRating || null,
    // Best-rated with no floor at all is a wall of titles twelve people have
    // voted on - the same floor TMDb's side has always used.
    min_votes: query.minVotes || (sort === 'top_rated' ? 1000 : null),
    runtime_min: query.minRuntimeMinutes,
    runtime_max: query.maxRuntimeMinutes,
    sort,
    with_cast: cast,
    cast_match: cast.length > 1 ? query.castMatch : null,
    with_director: directors,
    director_match: directors.length > 1 ? 'any' : null,
  }
  // Feature films and TV films - not the shorts, videos and TV specials
  // IMDb also files under movies (a director's student short, say).
  if (type !== 'series') filters.title_type = 'movie,tvmovie'
  if (type === 'series') {
    if (query.seriesStatus === 'airing') {
      filters.last_aired_from = Math.max(query.lastAiredFrom || 0, recentYear())
    } else {
      filters.last_aired_from = query.lastAiredFrom
      if (query.seriesStatus === 'ended') filters.last_aired_to = recentYear() - 1
    }
  }
  return filters
}

async function viaLumiere(base, query, type, limit, excludeIds) {
  const filters = await lumiereFilters(base, query, type)
  const rows = await lumiere.discoverTitles(base, type, filters, { limit, exclude: excludeIds })
  return rows.map((r) => ({ id: r.id, type: r.type, name: r.name, poster: r.poster, year: r.year }))
}

// ---- TMDb ---------------------------------------------------------------

async function tmdbPersonId(name, tmdbKey) {
  const key = name.toLowerCase()
  const hit = tmdbPeople.get(key)
  if (hit && Date.now() - hit.at < PERSON_TTL_MS) return hit.id
  let id = null
  try {
    const res = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) })
    if (res.ok) id = (await res.json())?.results?.[0]?.id ?? null
  } catch {}
  if (tmdbPeople.size > 500) tmdbPeople.clear()
  tmdbPeople.set(key, { id, at: Date.now() })
  return id
}

async function tmdbPeopleIds(query, tmdbKey) {
  const cast = []
  for (const name of query.cast) {
    const id = await tmdbPersonId(name, tmdbKey)
    if (!id) throw personNotFound(name)
    cast.push(id)
  }
  const directors = []
  for (const name of query.directors) {
    const id = await tmdbPersonId(name, tmdbKey)
    if (!id) throw personNotFound(name)
    directors.push(id)
  }
  return { cast, directors }
}

// TMDb's series Discover can't filter by people, so a series rule with
// people starts from each person's own series credits and applies the rest
// of the rule here.
async function tmdbSeriesByPeople(query, people, tmdbKey) {
  const sets = []
  const rowsById = new Map()
  const credits = async (id, pick) => {
    const res = await fetch(`https://api.themoviedb.org/3/person/${id}/tv_credits?api_key=${encodeURIComponent(tmdbKey)}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return new Set()
    const data = await res.json()
    const ids = new Set()
    for (const c of pick(data)) {
      ids.add(c.id)
      if (!rowsById.has(c.id)) rowsById.set(c.id, c)
    }
    return ids
  }
  for (const id of people.cast) sets.push({ ids: await credits(id, (d) => d.cast || []), role: 'cast' })
  for (const id of people.directors) {
    sets.push({ ids: await credits(id, (d) => (d.crew || []).filter((c) => /director|creator/i.test(c.job || c.department || ''))), role: 'director' })
  }
  const castSets = sets.filter((s) => s.role === 'cast').map((s) => s.ids)
  const directorSets = sets.filter((s) => s.role === 'director').map((s) => s.ids)
  const intersect = (list) => list.reduce((acc, ids) => new Set([...acc].filter((x) => ids.has(x))))
  const unite = (list) => new Set(list.flatMap((ids) => [...ids]))
  const castIds = castSets.length ? (query.castMatch === 'any' ? unite(castSets) : intersect(castSets)) : null
  const directorIds = directorSets.length ? unite(directorSets) : null
  let ids = [...rowsById.keys()]
  if (castIds) ids = ids.filter((id) => castIds.has(id))
  if (directorIds) ids = ids.filter((id) => directorIds.has(id))

  const { loadGenreMaps, resolveGenreIds } = require('./nlCatalog')
  const maps = await loadGenreMaps(tmdbKey)
  const wanted = resolveGenreIds(query.genres, 'tv', maps)
  const unwanted = new Set(resolveGenreIds(query.excludeGenres, 'tv', maps))
  const year = (r) => Number((r.first_air_date || '').slice(0, 4)) || null
  let rows = ids.map((id) => rowsById.get(id)).filter((r) => {
    const genreIds = Array.isArray(r.genre_ids) ? r.genre_ids : []
    if (wanted.length && !wanted.every((g) => genreIds.includes(g))) return false
    if (genreIds.some((g) => unwanted.has(g))) return false
    const y = year(r)
    if (query.yearFrom && (!y || y < query.yearFrom)) return false
    if (query.yearTo && (!y || y > query.yearTo)) return false
    if (query.minRating && !(Number(r.vote_average) >= query.minRating)) return false
    if (query.minVotes && !(Number(r.vote_count) >= Math.max(10, Math.round(query.minVotes / 50)))) return false
    return true
  })
  const order = {
    top_rated: (a, b) => (b.vote_average || 0) - (a.vote_average || 0),
    votes: (a, b) => (b.vote_count || 0) - (a.vote_count || 0),
    newest: (a, b) => (year(b) || 0) - (year(a) || 0),
    oldest: (a, b) => (year(a) || 9999) - (year(b) || 9999),
  }[query.sort] || ((a, b) => (b.popularity || 0) - (a.popularity || 0))
  rows = rows.sort(order)
  return rows
}

async function viaTmdb(query, type, limit, excludeIds, tmdbKey) {
  const mediaType = type === 'series' ? 'tv' : 'movie'
  const exclude = new Set(excludeIds)
  const hasPeople = query.cast.length > 0 || query.directors.length > 0
  const people = hasPeople ? await tmdbPeopleIds(query, tmdbKey) : null
  let results
  if (mediaType === 'tv' && hasPeople) {
    results = await tmdbSeriesByPeople(query, people, tmdbKey)
  } else {
    // A page is 20 titles; leaving out what's been watched needs headroom.
    const pages = Math.ceil((limit * (exclude.size ? 2 : 1.2)) / 20)
    const found = await discoverFromQuery(query, tmdbKey, { mediaType, pages, people })
    if (found.failed) throw new Error('TMDb didn’t answer')
    results = found.results
  }
  const { mapLimit } = require('./listImport')
  const items = []
  // Resolved in batches so a short list stops paying for lookups once full.
  for (let i = 0; i < results.length && items.length < limit; i += 20) {
    const batch = await mapLimit(results.slice(i, i + 20), 5, (r) => resolveToImdbItem(r, mediaType, tmdbKey))
    for (const item of batch) {
      if (item && !exclude.has(item.id) && !items.some((x) => x.id === item.id)) items.push(item)
    }
  }
  return items.slice(0, limit)
}

// ---- Both ---------------------------------------------------------------

function interleave(a, b, limit) {
  const out = []
  for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
    if (i < a.length) out.push(a[i])
    if (i < b.length && out.length < limit) out.push(b[i])
  }
  return out
}

/**
 * @returns {Promise<{ items: object[], engine: 'lumiere'|'tmdb', ignored: string[] }>}
 * Throws when it can't be answered at all (no TMDb key and no LumiereDB, a
 * person nobody of that name, the service down) - callers that keep a
 * catalog's old titles on failure rely on that rather than an empty list.
 */
async function findTitles(prisma, accountId, rawQuery, { limit = 40, excludeIds = [], tmdbKey = null } = {}) {
  const query = normalizeQuery(rawQuery)
  query.minRating = Number(rawQuery?.minRating) > 0 ? Math.min(10, Number(rawQuery.minRating)) : null
  const base = await lumiere.readyLumiere(prisma, accountId)
  const wantsKeywords = query.keywords.length > 0
  const useLumiere = !!base && !(wantsKeywords && tmdbKey)
  if (!useLumiere && !tmdbKey) {
    throw new Error('A TMDb key or a LumiereDB is needed for this (Settings -> External API Keys)')
  }
  const ignored = []
  if (useLumiere && wantsKeywords) ignored.push('keywords')
  if (!useLumiere && query.sort === 'trending') ignored.push('trending')

  const run = (type, n) => (useLumiere ? viaLumiere(base, query, type, n, excludeIds) : viaTmdb(query, type, n, excludeIds, tmdbKey))
  let items
  if (query.type) {
    items = await run(query.type, limit)
  } else {
    const [movies, series] = await Promise.all([run('movie', limit), run('series', limit)])
    items = interleave(movies, series, limit)
  }
  return { items, engine: useLumiere ? 'lumiere' : 'tmdb', ignored }
}

module.exports = { findTitles, PersonNotFound, _test: { lumiereFilters, interleave } }
