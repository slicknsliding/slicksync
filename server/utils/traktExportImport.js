// Trakt's own data export (Settings -> Data on trakt.tv), which is free and
// needs no app registration.
//
// This replaces the OAuth device-code import that used to live in
// traktImport.js. That route needed a registered Trakt API application, and
// Trakt now gates creating one behind VIP - so the feature could only ever
// work for an operator willing to pay Trakt, which is a poor foundation for
// "leave Trakt". Trakt's built-in export has no such gate, and it also
// avoids spending the user's single free "connected app" slot.
//
// The export is a ZIP of paginated JSON files split by data type
// (watch history, ratings, watchlist, collection, ...). No ZIP dependency is
// pulled in for this - every other import path in this codebase is
// dependency-free too - so the user extracts the ZIP and uploads the JSON
// file(s) they care about. History and ratings are separate files and can be
// imported one after the other.
//
// Rather than a parallel write path, entries are flattened into the exact
// column names csvHistoryImport.js's COLUMN_ALIASES already recognises
// (imdbID / Title / Year / Watched Date / Rating). The existing import loop
// then handles them unchanged, so a Trakt-imported item behaves identically
// to a CSV-imported one - same 'Imported' label, same never-overwrite-a-
// native-record rule.

const HEADERS = ['imdbID', 'Title', 'Year', 'Watched Date', 'Rating']

/**
 * Pull the movie/show object out of one export entry. Trakt's export mirrors
 * its own API shapes, so the payload hangs off a key named for its type.
 */
function extractTitleObject(entry) {
  if (!entry || typeof entry !== 'object') return null
  // Episodes/seasons carry a `show`; a movie carries `movie`. Episode-level
  // history has no equivalent write path in this codebase (the CSV importer
  // is movies-only for the same reason), so those are reported as skipped
  // rather than silently mangled into a movie row.
  if (entry.movie && typeof entry.movie === 'object') return entry.movie
  // `media_data` + `media_type` is the shape the traktexport tool produces
  // once it has parsed the raw API response. Cheap to accept, and someone
  // handed a file by that tool has no idea it differs.
  if (entry.media_type === 'movie' && entry.media_data && typeof entry.media_data === 'object') return entry.media_data
  // A bare title object (some re-exports drop the envelope entirely).
  if (entry.ids && typeof entry.ids === 'object' && typeof entry.title === 'string' && !entry.show && !entry.episode) return entry
  return null
}

function imdbIdOf(titleObj) {
  // ids.imdb is what Trakt's own export and API use; imdb_id turns up in
  // tools that rename the field when parsing.
  const raw = titleObj?.ids?.imdb ?? titleObj?.ids?.imdb_id ?? titleObj?.imdb_id
  return typeof raw === 'string' && /^tt\d+$/i.test(raw.trim()) ? raw.trim() : null
}

/**
 * Describes what a file actually looked like, so a format mismatch produces
 * something actionable instead of a bare "0 entries". Names only - no values,
 * since this ends up in an error message.
 */
function describeShape(data) {
  if (Array.isArray(data)) {
    const first = data.find((x) => x && typeof x === 'object')
    return `an array of ${data.length} item(s)` + (first ? `, first item has keys: ${Object.keys(first).slice(0, 12).join(', ')}` : '')
  }
  if (data && typeof data === 'object') {
    return `an object with keys: ${Object.keys(data).slice(0, 12).join(', ')}`
  }
  return typeof data
}

/**
 * Parse one extracted Trakt export JSON file.
 * Accepts a top-level array (what the export actually contains) and also an
 * object wrapping one, since third-party re-exports commonly do that.
 * Returns { headers, records, skippedNonMovie } shaped for mapColumns().
 */
function parseTraktExport(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null // not JSON at all - caller falls back to the CSV parser
  }

  let entries = null
  if (Array.isArray(data)) entries = data
  else if (data && typeof data === 'object') {
    // A whole-account export (the traktexport tool writes one file with all
    // of these) rather than one of Trakt's own per-type files.
    for (const key of ['history', 'watched', 'ratings', 'items', 'data', 'movies']) {
      if (Array.isArray(data[key])) { entries = data[key]; break }
    }
  }
  if (!Array.isArray(entries)) return { headers: HEADERS, records: [], skippedNonMovie: 0, shape: describeShape(data) }

  const records = []
  let skippedNonMovie = 0

  for (const entry of entries) {
    const titleObj = extractTitleObject(entry)
    if (!titleObj) { skippedNonMovie++; continue }

    // watched_at is history; rated_at is the ratings file. Either one is a
    // reasonable "when", and the CSV path already treats IMDb's rating date
    // the same way.
    const when = entry.watched_at || entry.last_watched_at || entry.rated_at || null
    const rating = typeof entry.rating === 'number' ? String(entry.rating) : ''

    records.push({
      imdbID: imdbIdOf(titleObj) || '',
      Title: typeof titleObj.title === 'string' ? titleObj.title : '',
      Year: titleObj.year != null ? String(titleObj.year) : '',
      'Watched Date': typeof when === 'string' ? when : '',
      Rating: rating,
    })
  }

  return { headers: HEADERS, records, skippedNonMovie, shape: describeShape(entries) }
}

/** Cheap check so the route can pick a parser without guessing on extension alone. */
function looksLikeJson(text) {
  const t = (text || '').trimStart()
  return t.startsWith('[') || t.startsWith('{')
}

module.exports = { parseTraktExport, looksLikeJson, describeShape, HEADERS }
