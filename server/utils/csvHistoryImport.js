// Watch-history CSV import/export - the biggest adoption blocker for a
// Trakt alternative is leaving your history behind, so this lets someone
// bring an existing IMDb/Letterboxd (or similar) export straight into
// SlickTrax, and leave with a real export of their own if they ever want to.
//
// Deliberately flexible-header rather than three hardcoded exact parsers:
// IMDb's own "Your Ratings"/"Watchlist" export uses `Const`/`Title`/`Year`/
// `Your Rating`/`Date Rated`; Letterboxd's diary/watched export uses `Name`/
// `Year`/`Letterboxd URI`/`Rating`/`Watched Date` (confirmed against
// Letterboxd's own https://letterboxd.com/about/importing-data/ for the
// accepted import-side column names, which the export side mirrors); Trakt
// has no single stable CSV format at all (VIP-gated, and confirmed
// inconsistent even among Trakt's own users - see forum reports of the
// format changing). Matching by column NAME rather than a fixed schema
// covers all three, plus whatever loose CSV a third-party export tool
// produces, without guessing at a format that isn't reliably documented.

// Minimal RFC4180-ish CSV parser - handles quoted fields (with embedded
// commas/newlines) and escaped "" quotes. No external dependency needed for
// this; every other data-import path in this codebase (listImport.js) is
// already dependency-free too.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  if (rows.length === 0) return { headers: [], records: [] }
  const headers = rows[0].map((h) => h.trim())
  const records = rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => {
      const obj = {}
      headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim() })
      return obj
    })
  return { headers, records }
}

// Column name aliases across the formats this needs to read, checked
// case-insensitively in this priority order.
const COLUMN_ALIASES = {
  imdbId: ['Const', 'imdbID', 'imdb_id', 'IMDb ID', 'imdbId'],
  // 'movie_name' is TV Time's GDPR export; 'full_title' is Tautulli's
  // history export. Matching stays case-insensitive (see findColumn), so
  // Movary's lowercase headers ride the same aliases.
  title: ['Title', 'Name', 'movie_name', 'full_title'],
  year: ['Year'],
  // 'Watched At' is Plex's watch-history export, 'created_at' TV Time's,
  // 'watchedAt' Movary's CSV. Netflix's viewing-activity CSV is just
  // Title,Date - both already covered. Its M/D/YY dates parse natively
  // (verified: '9/1/26' -> 2026-09-01), so no format shim is needed.
  watchedDate: ['Date Rated', 'WatchedDate', 'Watched Date', 'Date', 'Watched At', 'created_at', 'watchedAt'],
  rating: ['Your Rating', 'Rating10', 'Rating', 'userRating'],
  titleType: ['Title Type', 'type', 'media_type'],
}

// Netflix's viewing-activity CSV mixes movies and episodes in one file, and
// an episode row's title is the show + a middle segment naming the season
// unit + the episode ("Dark: Season 1: Secrets"). There is no type column,
// so without this check every one of those rows would burn an OMDb title
// lookup that cannot succeed and then land in "couldn't resolve" noise -
// hundreds of rows for a normal account. Keyed on Netflix's own segment
// vocabulary rather than counting colons, so "Mission: Impossible" stays a
// movie.
const NETFLIX_EPISODE_SEGMENT = /:\s*(Season \d+|Series \d+|Part \d+|Volume \d+|Book \d+|Chapter \d+|Limited Series|Collection \d+)\s*:/i
function looksLikeSeriesEpisodeTitle(title) {
  return typeof title === 'string' && NETFLIX_EPISODE_SEGMENT.test(title)
}

function findColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase())
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase())
    if (idx !== -1) return headers[idx]
  }
  return null
}

function mapColumns(headers) {
  const map = {}
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    map[key] = findColumn(headers, aliases)
  }
  return map
}

// Resolves one CSV row to a real IMDb id + title/year - a direct imdb-style
// id column (IMDb's own export, or a Letterboxd row someone enriched) is
// trusted outright; otherwise falls back to an OMDb title+year search, the
// same resolution path listImport.js's own title-based imports already use.
async function resolveRowToImdbItem(row, colMap, omdbApiKey) {
  const rawId = colMap.imdbId ? row[colMap.imdbId] : null
  if (rawId && /^tt\d+$/.test(rawId.trim())) {
    return { imdbId: rawId.trim(), title: colMap.title ? row[colMap.title] : null, year: colMap.year ? row[colMap.year] : null }
  }
  const title = colMap.title ? row[colMap.title]?.trim() : null
  if (!title || !omdbApiKey) return null
  const year = colMap.year ? row[colMap.year]?.trim() : null
  try {
    require('./omdbMeter').recordOmdbRequest(omdbApiKey)
    const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbApiKey)}&t=${encodeURIComponent(title)}${year ? `&y=${encodeURIComponent(year)}` : ''}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (data?.Response === 'False' || !data?.imdbID) return null
    return { imdbId: data.imdbID, title: data.Title || title, year: data.Year || year }
  } catch {
    return null
  }
}

function parseWatchedDate(raw) {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

// 1-10 rating from either a direct 1-10 column or Letterboxd's 0.5-5 scale
// (the "Rating" alias is shared by both formats - a decimal value under 5.5
// with a fractional .5 is almost certainly Letterboxd's 5-star scale, an
// integer 6-10 is IMDb/Trakt's 10-point scale; genuinely ambiguous values
// in the 1-5 integer range are treated as already being out of 10, since
// that's the more common export format among these three sources).
function normalizeRating(raw) {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n % 1 === 0.5 && n <= 5) return Math.round(n * 2) // Letterboxd 0.5-5 -> 1-10
  return Math.min(10, Math.round(n))
}

module.exports = { parseCsv, mapColumns, resolveRowToImdbItem, parseWatchedDate, normalizeRating, looksLikeSeriesEpisodeTitle, COLUMN_ALIASES }
