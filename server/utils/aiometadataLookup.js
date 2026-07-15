// Looks up a poster from the account's configured AIOMetadata addon, for
// AIOStreams-proxy-detected streams that have no matching WatchSession entry
// (and therefore no library-derived poster/title already available).
//
// AIOMetadata is a standard Stremio-protocol addon: given a manifest URL like
// https://host/stremio/<uuid>/manifest.json, its search catalogs live at
// {base}/catalog/{type}/search.{type}/search={query}.json and return a
// `metas` array with { id, name, poster, year, releaseInfo, type, ... }.
//
// A bare title search can match the wrong title/year (e.g. "Powder" matched
// "Powder Blue" (2009) ahead of "Powder" (1995) in testing) - so this picks
// the result whose year best matches the parsed year, falling back to the
// top result only if no year match exists.

const LOOKUP_TIMEOUT_MS = 8000

function stripManifestSuffix(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json\/?$/, '')
}

async function searchCatalog(baseUrl, type, query) {
  const url = `${baseUrl}/catalog/${type}/search.${type}/search=${encodeURIComponent(query)}.json`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.metas) ? data.metas : []
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeForCompare(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Exact match after normalization - the strong, preferred signal.
function isExactTitleMatch(candidateName, searchTitle) {
  const a = normalizeForCompare(candidateName)
  const b = normalizeForCompare(searchTitle)
  return !!a && !!b && a === b
}

// Fallback for minor real differences (e.g. a colon/subtitle variant),
// but guarded by a length-ratio check - "Chernobyl" is a literal
// substring of "Chernobyl Diaries", yet they're different titles. Only
// accept a substring match when the two strings are close enough in
// length to plausibly be the same title with minor punctuation/subtitle
// differences, not a completely different, longer title that happens to
// share a word.
function isPlausibleSubstringMatch(candidateName, searchTitle) {
  const a = normalizeForCompare(candidateName)
  const b = normalizeForCompare(searchTitle)
  if (!a || !b) return false
  if (!a.includes(b) && !b.includes(a)) return false
  const longer = Math.max(a.length, b.length)
  const shorter = Math.min(a.length, b.length)
  return longer / shorter <= 1.3
}

function pickBestMatch(metas, year, searchTitle) {
  const exact = metas.filter((m) => isExactTitleMatch(m.name, searchTitle))
  const plausible = exact.length > 0
    ? exact
    : metas.filter((m) => isPlausibleSubstringMatch(m.name, searchTitle))

  if (plausible.length === 0) return null

  if (year) {
    const yearMatch = plausible.find((m) => {
      const metaYear = (m.year || m.releaseInfo || '').toString().slice(0, 4)
      return metaYear === String(year)
    })
    if (yearMatch) return yearMatch
  }
  return plausible[0]
}

/**
 * title: parsed display title, e.g. "Powder" (year stripped out separately)
 * year: parsed year string, e.g. "1995", or null if not parsed
 * Returns { posterUrl } or null if no manifest configured / no match found.
 */
async function lookupAiometadataPoster(manifestUrl, title, year) {
  if (!manifestUrl || !title) return null

  const baseUrl = stripManifestSuffix(manifestUrl)

  let metas = await searchCatalog(baseUrl, 'movie', title)
  let match = pickBestMatch(metas, year, title)

  if (!match) {
    metas = await searchCatalog(baseUrl, 'series', title)
    match = pickBestMatch(metas, year, title)
  }

  if (!match) return null
  return {
    posterUrl: match.poster || null,
    id: match.id || null,
    type: match.type || null,
  }
}

module.exports = { lookupAiometadataPoster }
