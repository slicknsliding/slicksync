// The watch-history file import (IMDb / Letterboxd / Trakt / Netflix / TV Time /
// Plex / Movary exports) used by both doors: the admin's per-person import
// (routes/users.js) and a member's own import from their Settings
// (routes/publicLibrary.js). One importer, so a fix or a new export format
// lands for both. It fills SlickSync's own history for one person; nothing is
// ever written back to Stremio, Nuvio, Jellyfin or AIOStreams.
//
// dryRun reports what the same run WOULD do - same parsing, same resolving,
// same "already there" test - and writes nothing at all (no history, no
// ratings, no undo entry).

const { createMulterInstance } = require('./helpers/multer')

const MAX_ROWS = 2000

// Same limits and file types for both doors.
const historyUpload = createMulterInstance({
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const looksLikeCsv = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || /\.csv$/i.test(file.originalname || '')
    // Trakt's own free export (Settings -> Data) is JSON, not CSV - see
    // traktExportImport.js. Same endpoint handles both.
    const looksLikeJsonFile = file.mimetype === 'application/json' || /\.json$/i.test(file.originalname || '')
    if (looksLikeCsv || looksLikeJsonFile) return cb(null, true)
    cb(new Error('Only .csv or .json files are allowed'), false)
  },
})

// Titles a member's file named without an id are looked up once and
// remembered, so previewing a file and then importing it costs one lookup per
// title, not two. Keyed by household; bounded.
const LOOKUP_CACHE_MAX = 5000
const lookupCache = new Map()
function cacheSet(key, value) {
  if (lookupCache.size >= LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value)
  lookupCache.set(key, value)
}

/**
 * @param {object} o
 * @param {object} o.prisma
 * @param {string} o.accountId
 * @param {{id: string}} o.user          the person whose history it lands in
 * @param {string} o.text                the file's text
 * @param {boolean} [o.dryRun]           report only, write nothing
 * @param {number} [o.maxLookups]        most OMDb title lookups this run may spend (unset = no cap)
 * @param {boolean} [o.cacheLookups]     remember resolved titles across runs
 * @returns {Promise<{status: number, body: object}>}
 */
async function runHistoryImport({ prisma, accountId, user, text, dryRun = false, maxLookups, cacheLookups = false }) {
  const { parseCsv, mapColumns, resolveRowToImdbItem, parseWatchedDate, normalizeRating, looksLikeSeriesEpisodeTitle } = require('./csvHistoryImport')
  const { resolveSinglePoster } = require('./libraryHelpers')
  const { resolveOmdbKeyForAccount } = require('./listImport')
  const fail = (error, extra) => ({ status: 400, body: { error, ...extra } })

  // A Trakt export JSON is flattened into the same column names the CSV
  // path already understands, so everything below this point is shared.
  const { parseTraktExport, looksLikeJson } = require('./traktExportImport')
  let headers, records, skippedNonMovie = 0, skippedNoTimestamp = 0
  if (looksLikeJson(text)) {
    const parsed = parseTraktExport(text)
    if (!parsed) return fail('That file is not valid JSON.')
    ;({ headers, records, skippedNonMovie, skippedNoTimestamp } = parsed)
    if (records.length === 0) {
      if (skippedNonMovie > 0) {
        return fail(`That file contains ${skippedNonMovie} episode or show entr${skippedNonMovie === 1 ? 'y' : 'ies'} and no movies. Movie history and ratings can be imported; episode history cannot yet.`)
      }
      if (skippedNoTimestamp > 0) {
        // Named plainly - this is Trakt's collection or watchlist export
        // (or similar), which is correctly not importable: a title
        // merely owned or queued was never actually watched.
        return fail(`That file lists ${skippedNoTimestamp} title(s) with no watch date or rating attached - looks like a collection or watchlist export rather than history. Only history and ratings files can be imported.`)
      }
      // Say what the file actually looked like. A format that doesn't
      // match is a one-line fix here, but only if the shape is known -
      // "no entries found" on its own is a dead end for whoever hit it.
      return fail(
        `No importable entries found. Expected Trakt's export format (entries with a "movie" object containing ids.imdb). This file is ${parsed.shape || 'in an unrecognised shape'}.`,
        { shape: parsed.shape || null },
      )
    }
  } else {
    ({ headers, records } = parseCsv(text))
    if (records.length === 0) return fail('No rows found in that CSV')
  }
  const colMap = mapColumns(headers)
  const omdbApiKey = await resolveOmdbKeyForAccount(prisma, accountId).catch(() => null)
  const lumiereBase = await require('./lumiere').readyLumiere(prisma, accountId).catch(() => '')

  // Capped so one enormous export (a decade of Letterboxd diary
  // entries) can't turn a single request into thousands of sequential
  // OMDb lookups - matches the same protective cap listImport.js's own
  // MAX_IMPORT_ITEMS already applies to title-based catalog imports.
  const rows = records.slice(0, MAX_ROWS)
  const budget = Number.isFinite(maxLookups) ? { omdbLeft: maxLookups, capped: false } : null

  let imported = 0
  let alreadyThere = 0
  let skipped = 0
  const unresolved = []
  const preview = []
  const existingIds = new Set()

  // Undo bookkeeping: snapshot which items/ratings already exist so the
  // rows this run CREATES can be told apart from ones it merely skipped
  // (the upserts below never modify existing rows - update: {}).
  const preExistingItemIds = new Set(
    (await prisma.movieWatchHistory.findMany({ where: { accountId, userId: user.id }, select: { itemId: true } })).map((r) => r.itemId)
  )
  const preExistingRatingIds = new Set(
    (await prisma.titleRating.findMany({ where: { accountId, season: 0 }, select: { itemId: true } })).map((r) => r.itemId)
  )
  const createdItemIds = []
  const createdRatingIds = []

  for (const row of rows) {
    // Netflix-style episode rows (Show: Season N: Episode) carry no id
    // and cannot resolve as movies - counted with the other episode
    // skips instead of burning a doomed OMDb lookup each and landing in
    // "couldn't resolve" noise. Only when there's no real id to trust.
    const rawRowId = colMap.imdbId ? row[colMap.imdbId] : null
    const hasRealId = rawRowId && /^tt\d+$/.test(String(rawRowId).trim())
    if (!hasRealId && looksLikeSeriesEpisodeTitle(colMap.title ? row[colMap.title] : null)) {
      skippedNonMovie++
      continue
    }
    const cacheKey = !hasRealId && cacheLookups && colMap.title && row[colMap.title]
      ? `${accountId}|${String(row[colMap.title]).trim().toLowerCase()}|${colMap.year ? String(row[colMap.year] || '').trim() : ''}`
      : null
    let resolved = cacheKey ? (lookupCache.get(cacheKey) || null) : null
    if (!resolved) {
      resolved = await resolveRowToImdbItem(row, colMap, omdbApiKey, lumiereBase, budget)
      if (resolved && cacheKey) cacheSet(cacheKey, resolved)
    }
    if (!resolved) {
      skipped++
      if (colMap.title && row[colMap.title]) unresolved.push(row[colMap.title])
      continue
    }
    const watchedAt = colMap.watchedDate ? (parseWatchedDate(row[colMap.watchedDate]) || new Date()) : new Date()
    const rating = colMap.rating ? normalizeRating(row[colMap.rating]) : null
    const had = preExistingItemIds.has(resolved.imdbId)

    if (dryRun) {
      if (had) {
        alreadyThere++
        if (!createdItemIds.includes(resolved.imdbId)) existingIds.add(resolved.imdbId)
      } else {
        preExistingItemIds.add(resolved.imdbId) // a file can repeat a title
        createdItemIds.push(resolved.imdbId)
        if (preview.length < 60) preview.push({ id: resolved.imdbId, name: resolved.title || resolved.imdbId, watchedAt: watchedAt.toISOString() })
      }
      imported++
      continue
    }

    try {
      const poster = await resolveSinglePoster(resolved.imdbId, 'movie', null)
      await prisma.movieWatchHistory.upsert({
        where: { accountId_userId_itemId: { accountId, userId: user.id, itemId: resolved.imdbId } },
        create: { accountId, userId: user.id, itemId: resolved.imdbId, itemName: resolved.title || resolved.imdbId, poster, profileLabel: 'Imported', completed: true, watchedAt },
        update: {}, // never overwrite an existing native record with an imported one
      })
      if (!had) {
        preExistingItemIds.add(resolved.imdbId) // a file can repeat a title
        createdItemIds.push(resolved.imdbId)
      } else {
        alreadyThere++
      }
      if (rating) {
        await prisma.titleRating.upsert({
          where: { accountId_itemId_season: { accountId, itemId: resolved.imdbId, season: 0 } },
          create: { accountId, itemId: resolved.imdbId, itemType: 'movie', season: 0, rating, itemName: resolved.title || null },
          update: {},
        }).catch(() => {}) // best-effort - a rating conflict must never fail the whole import
        if (!preExistingRatingIds.has(resolved.imdbId)) {
          preExistingRatingIds.add(resolved.imdbId)
          createdRatingIds.push(resolved.imdbId)
        }
      }
      imported++
    } catch (e) {
      skipped++
    }
  }

  // One Trash entry per import run: undoing it deletes exactly the rows
  // this run created and nothing that predated it.
  if (!dryRun) {
    try {
      await require('./trash').archiveHistoryImport(prisma, accountId, user.id, { createdItemIds, createdRatingIds })
    } catch (e) {
      console.warn('Import undo-archive failed (import itself succeeded):', e?.message)
    }
  }

  return {
    status: 200,
    body: {
      ...(dryRun ? { dryRun: true, titles: preview, ids: createdItemIds, existingIds: [...existingIds] } : {}),
      imported,
      // What the run put in (or, for a dry run, would put in) and what was
      // (a dry run also names them, so several files can be added up exactly)
      // already in the person's history.
      added: createdItemIds.length,
      alreadyThere,
      // Entries the export carried but this importer cannot write (episode
      // and show history) are counted as skipped rather than omitted, so
      // the totals shown add up to what was actually in the file.
      skipped: skipped + skippedNonMovie,
      skippedEpisodes: skippedNonMovie,
      totalRows: records.length + skippedNonMovie,
      truncated: records.length > MAX_ROWS,
      unresolvedTitles: unresolved.slice(0, 20),
      // Title-only rows beyond the lookup allowance were left unresolved.
      lookupsCapped: !!budget?.capped,
    },
  }
}

module.exports = { runHistoryImport, historyUpload, MAX_ROWS }
