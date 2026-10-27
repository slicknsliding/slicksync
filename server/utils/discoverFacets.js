/**
 * Discover's filters that no catalog applies itself - decade, rating and
 * length - and "Both", movies and shows in one grid.
 *
 * A catalog only answers by genre, so these are applied here, to what each
 * page brought, from facts every item already carries: the year in
 * releaseInfo, imdbRating, and runtime ("101 min"). Nothing is looked up per
 * title. An item without the fact a filter asks about is left out while that
 * filter is on - "rated 7+" can't vouch for a title with no rating.
 *
 * A narrow filter reads ahead. The 1990s inside Popular can be a handful of
 * titles a page, and a page that came back empty read as the end of the
 * list. filteredPage keeps reading until it has a screenful
 * (FILTERED_TARGET) or has read FILTERED_MAX_PAGES, and the cursor it
 * returns is where it stopped reading, so the next request carries on there.
 *
 * "Both" travels as one cursor: movies * BOTH_SPLIT + shows. It grows
 * whenever either side moves, which is all the page relies on.
 */

const DECADES = ['2020s', '2010s', '2000s', '1990s', '1980s', 'older']
const LENGTHS = ['short', 'mid', 'long']
const FILTERED_TARGET = 18
const FILTERED_MAX_PAGES = 6
const BOTH_SPLIT = 1_000_000

/** The filters a request asked for, or null when it asked for none. */
function parseFacets(query = {}) {
  const decade = DECADES.includes(query.decade) ? query.decade : null
  const rating = Number(query.minRating)
  const minRating = Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : null
  const length = LENGTHS.includes(query.length) ? query.length : null
  return decade || minRating || length ? { decade, minRating, length } : null
}

function yearOf(item) {
  const m = /(\d{4})/.exec(String(item?.releaseInfo || ''))
  return m ? Number(m[1]) : null
}

/** Minutes from "101 min", "1h 41min", "1h", or a bare number. */
function minutesOf(item) {
  const raw = item?.runtime
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return raw > 0 ? raw : null
  const s = String(raw)
  const h = /(\d+)\s*h/i.exec(s)
  const m = /(\d+)\s*m/i.exec(s)
  if (h || m) return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) || null
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function ratingOf(item) {
  const n = parseFloat(item?.imdbRating)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** A search has no catalog genre to ask for, so the picked genre is matched
 * against each title's own genres ("Science Fiction" and "Sci-Fi" are one). */
function matchesGenre(item, genre) {
  if (!genre) return true
  const { genreSlug } = require('./lumiere')
  const want = genreSlug(genre)
  return Array.isArray(item?.genres) && item.genres.some((g) => typeof g === 'string' && genreSlug(g) === want)
}

/** Whether one item passes every filter that is on. */
function matchesFacets(item, facets) {
  if (!facets) return true
  if (facets.decade) {
    const y = yearOf(item)
    if (y == null) return false
    if (facets.decade === 'older') { if (y >= 1980) return false }
    else {
      const start = Number(facets.decade.slice(0, 4))
      if (y < start || y >= start + 10) return false
    }
  }
  if (facets.minRating) {
    const r = ratingOf(item)
    if (r == null || r < facets.minRating) return false
  }
  if (facets.length) {
    const mins = minutesOf(item)
    if (mins == null) return false
    if (facets.length === 'short' && mins >= 90) return false
    if (facets.length === 'mid' && (mins < 90 || mins > 120)) return false
    if (facets.length === 'long' && mins <= 120) return false
  }
  return true
}

/** The items not handed out yet, by id - a repeat inside one page is dropped too. */
function takeFresh(items, seen) {
  const fresh = []
  for (const item of items) {
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    fresh.push(item)
  }
  return fresh
}

/**
 * One page with the filters applied, reading ahead while it is thin.
 * `pageFrom(from)` answers { items, cursor }.
 */
async function filteredPage(pageFrom, from, facets) {
  if (!facets) return pageFrom(from)
  let cursor = from
  const kept = []
  const seen = new Set()
  for (let pass = 0; pass < FILTERED_MAX_PAGES; pass++) {
    const page = await pageFrom(cursor)
    const moved = page.cursor > cursor
    cursor = page.cursor
    const fresh = takeFresh(page.items, seen)
    kept.push(...fresh.filter((i) => matchesFacets(i, facets)))
    if (kept.length >= FILTERED_TARGET || !moved || page.items.length === 0 || fresh.length === 0) break
  }
  return { items: kept, cursor }
}

/** Movies and shows side by side, each paged on its own half of the cursor. */
async function bothPage(pageFor, from) {
  const movieFrom = Math.floor(from / BOTH_SPLIT)
  const showFrom = from % BOTH_SPLIT
  const [movies, shows] = await Promise.all([pageFor('movie', movieFrom), pageFor('series', showFrom)])
  const items = interleave(movies.items, shows.items)
  // A side that has run out keeps its place rather than wrapping into the other's.
  const nextMovie = Math.min(BOTH_SPLIT - 1, movies.cursor)
  const nextShow = Math.min(BOTH_SPLIT - 1, shows.cursor)
  return { items, cursor: nextMovie * BOTH_SPLIT + nextShow }
}

/** Two lists taken in turn: a movie, a show, a movie... */
function interleave(a, b) {
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i])
    if (b[i]) out.push(b[i])
  }
  return out
}

module.exports = {
  DECADES, LENGTHS, FILTERED_TARGET, FILTERED_MAX_PAGES, BOTH_SPLIT,
  parseFacets, matchesFacets, matchesGenre, minutesOf, yearOf, ratingOf, takeFresh, filteredPage, bothPage, interleave,
}
