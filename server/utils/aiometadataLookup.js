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

function pickBestMatch(metas, year) {
  if (metas.length === 0) return null
  if (year) {
    const yearMatch = metas.find((m) => {
      const metaYear = (m.year || m.releaseInfo || '').toString().slice(0, 4)
      return metaYear === String(year)
    })
    if (yearMatch) return yearMatch
  }
  return metas[0]
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
  let match = pickBestMatch(metas, year)

  if (!match) {
    metas = await searchCatalog(baseUrl, 'series', title)
    match = pickBestMatch(metas, year)
  }

  if (!match || !match.poster) return null
  return { posterUrl: match.poster }
}

module.exports = { lookupAiometadataPoster }
