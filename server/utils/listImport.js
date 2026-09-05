/**
 * List import: pull an existing list from TMDb or MDBList into a new
 * SlickSync CustomList. Auto-detects the provider from the pasted URL so
 * there's one "Import" flow, not a provider picker.
 *
 * TMDb: the v3 List resource (`/list/{id}`) is genuinely public with just an
 * API key - no OAuth - but it is MOVIES ONLY (TMDb's mixed-media v4 Lists
 * require account-level OAuth, out of scope for a key-only integration).
 * Each item needs a follow-up `/movie/{id}/external_ids` call to resolve an
 * IMDb id, since v3 list items only carry the TMDb id - same resolution
 * SlickSync's own cast-credit click-through already does (see discover.js's
 * /imdb-id endpoint).
 *
 * MDBList: purpose-built for exactly this - `/lists/{username}/{slug}`
 * resolves a public list by its own URL slug, `/lists/{listid}/items`
 * returns items with imdb_id already attached (no per-item follow-up
 * needed), and covers movies AND shows. Confirmed via MDBList's own OpenAPI
 * spec: public lists are readable with any valid API key, not just the list
 * owner's. Posters aren't in the base item response, so they're backfilled
 * per item via the same Cinemeta lookup the rest of the app already uses
 * (resolveSinglePoster) - bounded concurrency so a large list doesn't fire
 * hundreds of simultaneous requests at Cinemeta.
 *
 * Letterboxd is deliberately NOT supported - it has no public API at all;
 * the only way to read a list is scraping their HTML, which is fragile and
 * outside what this app should depend on.
 */
const { resolveSinglePoster } = require('./libraryHelpers')

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342'
// Real lists are almost always well under this; it exists purely as a
// safety bound (MDBList imports do one Cinemeta poster lookup per item, so
// an unbounded list could otherwise take minutes and hammer Cinemeta).
// Surfaced to the caller via `truncated` so it's never a silent cut.
const MAX_IMPORT_ITEMS = 200

// Maps a settings field to the provider name used in keyHealth, so a key
// that the daily check has already found to be failing can be skipped in
// favour of its backup. Kept explicit rather than derived from the field
// name - a rename should break loudly here, not silently stop failing over.
const HEALTH_PROVIDER_BY_FIELD = {
  tmdbApiKey: 'tmdb',
  omdbApiKey: 'omdb',
  mdblistApiKey: 'mdblist',
  rpdbApiKey: 'rpdb',
}

/**
 * Resolution order: the account's own key, then its backup key, then the
 * instance-wide env var.
 *
 * The account's key is SKIPPED when the last health check found it failing
 * and a backup exists - the point of a backup key is that a dead or
 * exhausted primary stops taking the app down with it. This reads the stored
 * result rather than testing anything, so it costs nothing per call; the
 * daily check (metadataKeyHealth.js) is what keeps that judgement current,
 * and a recovered key is used again on the next check.
 *
 * A rate-limited key counts as failing here too: an exhausted allowance
 * means no posters either way, so the backup is strictly better while it
 * lasts.
 */
async function resolveKeyFromSettings(prisma, getAccountId, req, settingsField, envVar, { allowBackup = true } = {}) {
  try {
    const accountId = (typeof getAccountId === 'function' ? getAccountId(req) : null) || 'default'
    const acc = await prisma?.appAccount?.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = acc?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (!cfg || typeof cfg !== 'object') cfg = {}

    const read = (field) => (typeof cfg[field] === 'string' ? cfg[field].trim() : '')
    const primary = read(settingsField)
    const backup = read(`${settingsField}Backup`)

    // allowBackup:false is for the health check itself, which MUST test the
    // primary. Letting it follow failover makes the two halves chase each
    // other: the check would test the backup, record the provider as healthy,
    // which un-marks the primary as bad, which sends the next lookup back to
    // the dead primary, which fails the next check - flip-flopping between
    // keys every cycle and never settling.
    // Key Pool: when EXTRA keys exist beyond the primary/backup pair,
    // rotation across every healthy key replaces the primary-first
    // semantics - spreading quota is the whole point of configuring a pool.
    // allowBackup:false (the health check's own path) always bypasses this:
    // checks address specific keys, never "whichever the ring serves next".
    if (allowBackup) {
      const { readPool, pickFromRing } = require('./keyPool')
      if (readPool(cfg, settingsField).length > 0) {
        const provider = HEALTH_PROVIDER_BY_FIELD[settingsField]
        const pooled = pickFromRing(cfg, settingsField, provider, accountId)
        if (pooled) return pooled
      }
    }

    if (primary) {
      if (!allowBackup) return primary
      const provider = HEALTH_PROVIDER_BY_FIELD[settingsField]
      const health = provider ? cfg.keyHealth?.[provider] : null
      const primaryIsBad = !!health && health.ok === false
      if (!primaryIsBad || !backup) return primary
      // Primary is known-bad and a backup exists - use it.
      return backup
    }
    if (backup && allowBackup) return backup
  } catch {}
  return (process.env[envVar] || '').trim()
}

const resolveTmdbKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'tmdbApiKey', 'TMDB_API_KEY')
const resolveMdblistKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'mdblistApiKey', 'MDBLIST_API_KEY')

// accountId-direct variant (no req/getAccountId) for background jobs that
// already have (prisma, accountId) in scope from their own per-account
// loop, rather than an Express request.
async function resolveOmdbKeyForAccount(prisma, accountId) {
  return resolveKeyFromSettings(prisma, () => accountId, null, 'omdbApiKey', 'OMDB_API_KEY')
}
const resolveOmdbKey = (prisma, getAccountId, req) => resolveKeyFromSettings(prisma, getAccountId, req, 'omdbApiKey', 'OMDB_API_KEY')

/** TMDb key for a known account id - the no-request counterpart to
 * resolveTmdbKey, for background sweeps (see utils/followWatch.js). */
async function resolveTmdbKeyForAccount(prisma, accountId) {
  return resolveKeyFromSettings(prisma, () => accountId, null, 'tmdbApiKey', 'TMDB_API_KEY')
}

function detectProvider(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'mdblist.com') return 'mdblist'
    if (host === 'themoviedb.org') return 'tmdb'
    // Trakt PUBLIC lists only - readable with a client id and no OAuth.
    // (An account bridge is a different thing entirely and deliberately not
    // built: Trakt allows a free account one connected app, so SlickSync
    // would evict whatever the person already uses.)
    if (host === 'trakt.tv') return 'trakt'
    // Another SlickSync instance publishing a catalog. Matched on the path
    // rather than the hostname - unlike TMDb/MDBList there is no fixed host,
    // it is whatever domain that household runs on.
    if (parsed.pathname.startsWith('/api/federation/catalog/')) return 'slicksync'
    // Anime lists. AniList is public and unauthenticated; MyAnimeList is
    // read through Jikan, the long-standing public mirror of MAL's data,
    // for the same reason - MAL's own API wants a client id registered per
    // household, which is a key to manage for one import.
    if (host === 'anilist.co') return 'anilist'
    if (host === 'myanimelist.net') return 'myanimelist'
  } catch {}
  return null
}

// Pull a catalog published by another SlickSync instance.
//
// Needs no API key: the token is already in the URL the owner shared. What
// comes back is a title list and nothing else - see routes/federation.js for
// what the publishing side deliberately does not send.
async function importFromSlickSync(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  let res
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
  } catch (e) {
    throw new Error(e?.name === 'AbortError'
      ? 'That instance took too long to respond'
      : 'Could not reach that instance - check the URL and that it is publicly reachable')
  } finally {
    clearTimeout(timeoutId)
  }

  // The publisher answers 404 for unknown, unpublished AND wrong-token alike,
  // so this message has to cover all three without guessing between them.
  if (res.status === 404) throw new Error('That share link is no longer valid - it may have been revoked, or the URL is wrong')
  if (!res.ok) throw new Error(`That instance returned ${res.status}`)

  let body
  try { body = await res.json() } catch { throw new Error('That URL did not return a SlickSync catalog') }
  if (!body || !Array.isArray(body.items)) throw new Error('That URL did not return a SlickSync catalog')
  if (Number(body.federation) > 1) {
    throw new Error('That catalog was published by a newer version of SlickSync than this instance understands')
  }

  // Re-shaped rather than trusted wholesale: this payload came from a server
  // someone else controls, and it flows into itemsJson which the UI renders.
  const items = body.items
    .filter((i) => i && typeof i.id === 'string')
    .slice(0, MAX_IMPORT_ITEMS)
    .map((i) => ({
      id: String(i.id),
      type: i.type === 'series' ? 'series' : 'movie',
      name: typeof i.name === 'string' ? i.name : String(i.id),
      ...(i.year ? { year: Number(i.year) || undefined } : {}),
      ...(typeof i.poster === 'string' && /^https?:\/\//.test(i.poster) ? { poster: i.poster } : {}),
    }))

  return {
    items,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Shared catalog',
    truncated: body.items.length > items.length,
    totalAvailable: Number(body.itemCount) || body.items.length,
  }
}

// Small bounded-concurrency map - avoids firing N simultaneous requests at
// an external service for a large list.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function importFromTmdb(apiKey, url) {
  if (!apiKey) throw new Error('TMDb API key not configured (Settings -> SlickTrax)')
  const m = url.match(/\/list\/(\d+)/)
  const listId = m ? m[1] : null
  if (!listId) throw new Error('Could not find a list id in that TMDb URL')

  const rsp = await fetch(`https://api.themoviedb.org/3/list/${listId}?api_key=${encodeURIComponent(apiKey)}`)
  if (!rsp.ok) throw new Error(rsp.status === 404 ? 'TMDb list not found (it may be private)' : 'TMDb request failed')
  const data = await rsp.json()
  const rawItems = data.items || []
  const truncated = rawItems.length > MAX_IMPORT_ITEMS
  const capped = rawItems.slice(0, MAX_IMPORT_ITEMS).filter((it) => !it.media_type || it.media_type === 'movie')

  const resolved = await mapLimit(capped, 8, async (it) => {
    try {
      const ext = await fetch(`https://api.themoviedb.org/3/movie/${it.id}/external_ids?api_key=${encodeURIComponent(apiKey)}`)
      if (!ext.ok) return null
      const extData = await ext.json()
      if (!extData.imdb_id) return null
      return {
        id: extData.imdb_id,
        type: 'movie',
        name: it.title || 'Untitled',
        poster: it.poster_path ? `${TMDB_IMG}${it.poster_path}` : null,
        year: it.release_date ? it.release_date.slice(0, 4) : null,
      }
    } catch { return null }
  })

  return { name: data.name || 'Imported list', items: resolved.filter(Boolean), truncated, totalAvailable: rawItems.length }
}

async function importFromMdblist(apiKey, url) {
  if (!apiKey) throw new Error('MDBList API key not configured (Settings -> SlickTrax)')
  const m = url.match(/mdblist\.com\/lists\/([^/?#]+)\/([^/?#]+)/i)
  if (!m) throw new Error('Could not find a username/list in that MDBList URL')
  const [, username, slug] = m

  const listRsp = await fetch(`https://api.mdblist.com/lists/${encodeURIComponent(username)}/${encodeURIComponent(slug)}?apikey=${encodeURIComponent(apiKey)}`)
  if (!listRsp.ok) throw new Error(listRsp.status === 404 ? 'MDBList list not found (it may be private)' : 'MDBList request failed')
  const listData = await listRsp.json()
  const list = Array.isArray(listData) ? listData[0] : listData
  const listId = list?.id
  if (!listId) throw new Error('Could not resolve that MDBList list')

  const itemsRsp = await fetch(`https://api.mdblist.com/lists/${listId}/items?apikey=${encodeURIComponent(apiKey)}&limit=${MAX_IMPORT_ITEMS + 1}`)
  if (!itemsRsp.ok) throw new Error('MDBList request failed fetching list items')
  const page = await itemsRsp.json()
  const rawItems = Array.isArray(page) ? page : (Array.isArray(page.items) ? page.items : [...(page.movies || []), ...(page.shows || [])])

  const truncated = rawItems.length > MAX_IMPORT_ITEMS
  const capped = rawItems.slice(0, MAX_IMPORT_ITEMS)

  const resolved = await mapLimit(capped, 8, async (it) => {
    const imdbId = it.imdb_id || it.ids?.imdb
    if (!imdbId) return null
    const type = (it.mediatype === 'show' || it.mediatype === 'tv') ? 'series' : 'movie'
    const poster = await resolveSinglePoster(imdbId, type, null).catch(() => null)
    return { id: imdbId, type, name: it.title || 'Untitled', poster, year: it.release_year ? String(it.release_year) : null }
  })

  return { name: list.name || 'Imported list', items: resolved.filter(Boolean), truncated, totalAvailable: rawItems.length }
}

/**
 * Resolves an anime title to the IMDb id the rest of the app speaks.
 *
 * Neither AniList nor MAL carries IMDb ids, so every entry is matched
 * through TMDb - the same verify-then-keep rule the describe search uses:
 * anything TMDb cannot place is dropped rather than imported as a title
 * with no working links, no watched state and no deep link.
 */
async function resolveAnimeToImdb(entry, tmdbKey) {
  const path = entry.type === 'movie' ? 'movie' : 'tv'
  // Anime is listed under an English title, a romaji one, or both, and TMDb
  // does not always know the same one AniList leads with. Trying the second
  // title when the first finds nothing is the difference between a title
  // being imported and being silently dropped, and costs a request only for
  // the ones that would have failed anyway.
  const titles = [entry.title, entry.altTitle].filter((t) => t && String(t).trim())
  try {
    let hit = null
    for (const title of titles) {
      const params = new URLSearchParams({ api_key: tmdbKey, query: title })
      if (entry.year) params.set(path === 'tv' ? 'first_air_date_year' : 'year', String(entry.year))
      const res = await fetch('https://api.themoviedb.org/3/search/' + path + '?' + params.toString(), { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const data = await res.json()
      const found = Array.isArray(data && data.results) ? data.results[0] : null
      if (found && found.id) { hit = found; break }
    }
    // A year that is one off (AniList dates a season by when it started
    // airing in Japan) can be the only reason nothing matched, so the last
    // attempt drops it rather than dropping the title.
    if (!hit && entry.year) {
      const params = new URLSearchParams({ api_key: tmdbKey, query: titles[0] })
      const res = await fetch('https://api.themoviedb.org/3/search/' + path + '?' + params.toString(), { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const data = await res.json()
        const found = Array.isArray(data && data.results) ? data.results[0] : null
        if (found && found.id) hit = found
      }
    }
    if (!hit || !hit.id) return null
    const ext = await fetch('https://api.themoviedb.org/3/' + path + '/' + hit.id + '/external_ids?api_key=' + encodeURIComponent(tmdbKey), { signal: AbortSignal.timeout(8000) })
    if (!ext.ok) return null
    const extData = await ext.json()
    if (!extData || !extData.imdb_id || !/^tt\d+$/.test(extData.imdb_id)) return null
    const released = hit.release_date || hit.first_air_date || ''
    return {
      id: extData.imdb_id,
      type: path === 'tv' ? 'series' : 'movie',
      name: hit.name || hit.title || entry.title,
      poster: hit.poster_path ? TMDB_IMG + hit.poster_path : null,
      year: released ? String(released).slice(0, 4) : (entry.year ? String(entry.year) : null),
    }
  } catch {
    return null
  }
}

// AniList list sections, named as they appear in the URL of the page you
// are looking at (anilist.co/user/NAME/animelist/Planning). Pasting a
// section imports that section; pasting the bare list imports all of it.
const ANILIST_STATUS = {
  watching: 'CURRENT',
  planning: 'PLANNING',
  completed: 'COMPLETED',
  paused: 'PAUSED',
  dropped: 'DROPPED',
  rewatching: 'REPEATING',
}

/**
 * Imports an AniList user's anime list.
 *
 * Public and unauthenticated, like the rest of the AniList integration -
 * nothing to configure and no quota to spend. A private list returns
 * nothing, which is reported as being private rather than as a failure.
 */
async function importFromAniList(url, tmdbKey) {
  if (!tmdbKey) throw new Error('A TMDb key is needed to match anime to real titles (Settings -> External API Keys)')
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean) // user/NAME/animelist[/Section]
  if (parts[0] !== 'user' || !parts[1]) throw new Error('Paste an AniList list URL, e.g. anilist.co/user/NAME/animelist')
  if (parts[2] === 'mangalist') throw new Error('Manga lists cannot be imported - SlickSync catalogs hold films and series')
  const userName = decodeURIComponent(parts[1])
  const section = parts[3] ? String(parts[3]).toLowerCase() : null
  const status = section ? ANILIST_STATUS[section] : null

  const query = 'query ($userName: String, $status: MediaListStatus) {' +
    ' MediaListCollection(userName: $userName, type: ANIME, status: $status) {' +
    ' lists { name entries { media { title { english romaji } format startDate { year } } } } } }'
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { userName, status: status || undefined } }),
    signal: AbortSignal.timeout(12000),
  })
  // AniList answers a missing OR private user with HTTP 404 and a body that
  // says which - so the body is read either way. Reporting a private list as
  // "not found" sends someone off checking a username that is spelled fine.
  const data = await res.json().catch(() => null)
  const errMsg = (data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) || ''
  if (/private/i.test(errMsg)) throw new Error('That AniList list is set to private - only public lists can be imported')
  if (/not found|user not found/i.test(errMsg)) throw new Error('That AniList user was not found')
  if (!res.ok) throw new Error(errMsg || 'AniList request failed (HTTP ' + res.status + ')')
  if (errMsg) throw new Error(errMsg)
  const lists = (data && data.data && data.data.MediaListCollection && data.data.MediaListCollection.lists) || []
  const entries = lists.flatMap((l) => (l && l.entries) || [])
  if (entries.length === 0) throw new Error('That AniList list is empty, private, or has nothing in that section')

  const raw = entries.map((e) => {
    const media = (e && e.media) || {}
    const english = (media.title && media.title.english) || null
    const romaji = (media.title && media.title.romaji) || null
    return {
      title: english || romaji,
      altTitle: english && romaji && english !== romaji ? romaji : null,
      year: (media.startDate && media.startDate.year) || null,
      type: media.format === 'MOVIE' ? 'movie' : 'series',
    }
  }).filter((e) => e.title)

  const truncated = raw.length > MAX_IMPORT_ITEMS
  const capped = raw.slice(0, MAX_IMPORT_ITEMS)
  const resolved = await mapLimit(capped, 5, (e) => resolveAnimeToImdb(e, tmdbKey))
  const label = section ? userName + ' - ' + section : userName + ' on AniList'
  return { name: label, items: resolved.filter(Boolean), truncated, totalAvailable: raw.length }
}

// MAL's own API pages at 100 and answers a client id alone for PUBLIC
// lists - no OAuth, no account connection, nothing to evict.
const MAL_PAGE_SIZE = 100

/**
 * Imports a MyAnimeList user's anime list.
 *
 * Uses MAL's official API with a Client ID, the same shape as the Trakt
 * import: a client id reads public lists and nothing else, so this never
 * touches anyone's account. Jikan - the keyless public mirror - was the
 * obvious way to avoid a key here and does not work for this: MAL removed
 * the endpoint it read lists from, and it now answers list requests with
 * "MyAnimeList refuses to connect" (measured, HTTP 504). A key that works
 * beats no key that doesn't.
 */
async function importFromMyAnimeList(url, tmdbKey, clientId) {
  if (!tmdbKey) throw new Error('A TMDb key is needed to match anime to real titles (Settings -> External API Keys)')
  if (!clientId) throw new Error('A MyAnimeList Client ID is needed (Settings -> Integrations). It reads public lists only and does not connect your account.')
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean) // animelist/NAME
  if (parts[0] !== 'animelist' || !parts[1]) throw new Error('Paste a MyAnimeList list URL, e.g. myanimelist.net/animelist/NAME')
  const userName = decodeURIComponent(parts[1])

  const raw = []
  let next = 'https://api.myanimelist.net/v2/users/' + encodeURIComponent(userName) +
    '/animelist?fields=list_status,media_type,start_season,alternative_titles&limit=' + MAL_PAGE_SIZE
  for (let page = 0; page < 4 && next; page++) {
    const res = await fetch(next, {
      headers: { 'X-MAL-CLIENT-ID': clientId },
      signal: AbortSignal.timeout(12000),
    })
    if (res.status === 404) throw new Error('That MyAnimeList user was not found')
    if (res.status === 403) throw new Error('That MyAnimeList list is private - only public lists can be imported')
    if (res.status === 401) throw new Error('MyAnimeList rejected that Client ID (Settings -> Integrations)')
    if (!res.ok) break
    const data = await res.json().catch(() => null)
    const rows = Array.isArray(data && data.data) ? data.data : []
    for (const row of rows) {
      const node = row && row.node
      if (!node || !node.title) continue
      raw.push({
        title: node.title,
        altTitle: (node.alternative_titles && (node.alternative_titles.en || (Array.isArray(node.alternative_titles.synonyms) && node.alternative_titles.synonyms[0]))) || null,
        year: (node.start_season && node.start_season.year) || null,
        type: String(node.media_type || '').toLowerCase() === 'movie' ? 'movie' : 'series',
      })
    }
    next = (data && data.paging && data.paging.next) || null
    if (raw.length >= MAX_IMPORT_ITEMS) break
  }
  if (raw.length === 0) throw new Error('That MyAnimeList list is empty or set to private')

  const truncated = raw.length > MAX_IMPORT_ITEMS
  const capped = raw.slice(0, MAX_IMPORT_ITEMS)
  const resolved = await mapLimit(capped, 5, (e) => resolveAnimeToImdb(e, tmdbKey))
  return { name: userName + ' on MyAnimeList', items: resolved.filter(Boolean), truncated, totalAvailable: raw.length }
}

// Suggest titles for a catalog by name (e.g. "Halloween", "Christmas
// Movies") - explicitly a preview, never auto-added. Seeds from TMDb's own
// keyword taxonomy when the name matches a real keyword ("halloween",
// "christmas", ...), which is far more precise than a plain text search
// (keyword-tagged results are actually about that theme, not just titles
// that happen to contain the word); falls back to a plain title search when
// nothing matches, so an unusual catalog name still returns *something*
// rather than an empty result.
const MAX_SUGGESTIONS = 20

// Words that carry no thematic signal on their own ("90s movies" is about
// the 90s, not about "movies"); stripped before retrying a keyword lookup so
// a natural catalog name like "30 days of halloween" still resolves to the
// real "halloween" keyword instead of failing outright.
const GENERIC_WORDS = new Set([
  'movie', 'movies', 'film', 'films', 'show', 'shows', 'tv', 'series',
  'collection', 'picks', 'favorites', 'favourites', 'list', 'of', 'the',
  'a', 'an', 'and', 'for', 'to', 'my', 'best', 'top', 'classics', 'classic',
])

// A bare decade ("90s", "1980s") isn't a TMDb keyword - it's a release-date
// range - so it needs its own discover query rather than a keyword lookup.
// Two-digit decades are assumed 1900s/2000s by the usual cutoff (a plain
// "90s" almost never means 1890s or 2090s in this context).
function extractDecadeRange(query) {
  const m = String(query || '').match(/\b(19|20)?(\d)0s\b/i)
  if (!m) return null
  const century = m[1] || (Number(m[2]) <= 2 ? '20' : '19')
  const startYear = Number(`${century}${m[2]}0`)
  return { start: startYear, end: startYear + 9 }
}

async function lookupTmdbKeywordId(text, apiKey) {
  const rsp = await fetch(`https://api.themoviedb.org/3/search/keyword?query=${encodeURIComponent(text)}&api_key=${encodeURIComponent(apiKey)}`)
  const data = rsp.ok ? await rsp.json() : { results: [] }
  const results = data.results || []
  if (results.length === 0) return null
  // TMDb's keyword search doesn't rank an exact match first - confirmed
  // live, "horror" returns b-horror, j-horror, horror in that order, so a
  // blind results[0] picked a niche subgenre keyword with almost no 90s/
  // quality-filtered matches instead of the real "horror" keyword (1 vs 3
  // results for the exact same discover query, live-verified). Prefer an
  // exact case-insensitive name match when the results include one.
  const exact = results.find((r) => r.name?.toLowerCase() === text.toLowerCase())
  return (exact || results[0]).id
}

async function discoverByKeyword(keywordId, apiKey) {
  // Sorted by rating, not raw popularity - confirmed live against the real
  // "christmas" keyword: TMDb's community tagging attaches it to any film
  // with so much as a Christmas-set scene (Iron Man 3, Die Hard), and
  // sorted by popularity.desc those blockbusters buried every actual
  // Christmas movie under them (top 6 results were all Harry Potter).
  // vote_average.desc + a vote_count floor (filters out obscure high-rated
  // flukes with a handful of votes) surfaces genuine, well-regarded genre
  // entries (It's a Wonderful Life, Klaus, The Nightmare Before Christmas)
  // mixed with the big franchises instead of drowned out by them.
  const qualitySort = 'sort_by=vote_average.desc&vote_count.gte=500'
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?with_keywords=${keywordId}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?with_keywords=${keywordId}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

async function discoverByDecade(range, apiKey) {
  const dateParams = `primary_release_date.gte=${range.start}-01-01&primary_release_date.lte=${range.end}-12-31`
  const airDateParams = `first_air_date.gte=${range.start}-01-01&first_air_date.lte=${range.end}-12-31`
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?${dateParams}&sort_by=popularity.desc&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?${airDateParams}&sort_by=popularity.desc&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

// Both a genre keyword AND a decade in the same query ("90s horror movies")
// - TMDb's discover endpoint takes with_keywords and a date range in the
// same call, so this is a real intersection, not two separate searches
// merged after the fact. Confirmed real bug this was written to fix: a
// decade-only search for this exact query returned Shawshank Redemption,
// Fight Club, Titanic, Forrest Gump, The Lion King - the most popular 90s
// titles overall, zero of them horror, because the decade branch used to
// short-circuit and never even attempt a keyword lookup for "horror".
async function discoverByKeywordAndDecade(keywordId, range, apiKey) {
  const qualitySort = 'sort_by=vote_average.desc&vote_count.gte=500'
  const dateParams = `primary_release_date.gte=${range.start}-01-01&primary_release_date.lte=${range.end}-12-31`
  const airDateParams = `first_air_date.gte=${range.start}-01-01&first_air_date.lte=${range.end}-12-31`
  const [movieRsp, tvRsp] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/discover/movie?with_keywords=${keywordId}&${dateParams}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
    fetch(`https://api.themoviedb.org/3/discover/tv?with_keywords=${keywordId}&${airDateParams}&${qualitySort}&api_key=${encodeURIComponent(apiKey)}`),
  ])
  const movieData = movieRsp.ok ? await movieRsp.json() : { results: [] }
  const tvData = tvRsp.ok ? await tvRsp.json() : { results: [] }
  return [
    ...(movieData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) })),
    ...(tvData.results || []).map((r) => ({ tmdbId: r.id, type: 'series', name: r.name, poster: r.poster_path, year: r.first_air_date?.slice(0, 4) })),
  ]
}

async function suggestTitlesForCatalog(apiKey, query, excludeIds = []) {
  if (!apiKey) throw new Error('TMDb API key not configured (Settings -> SlickTrax)')
  const trimmed = String(query || '').trim()
  if (!trimmed) throw new Error('Nothing to search for - rename the catalog to something like "Halloween" first')
  const excluded = new Set(excludeIds)

  let candidates = []
  const decadeRange = extractDecadeRange(trimmed)
  // Strip the decade token itself ("90s", "1990s") before looking for a
  // genre/theme keyword in what's left - otherwise a query like "90s horror
  // movies" would try to look up "90s" as a keyword alongside "horror".
  const withoutDecade = trimmed.replace(/\b(19|20)?\d0s\b/i, ' ').replace(/\s+/g, ' ').trim()
  // Original word order preserved (for a real multi-word keyword phrase),
  // filler words removed. Confirmed real bug: leaving "movies" in for
  // "90s horror movies" made the phrase lookup match TMDb's "horrormovies"
  // keyword (a near-empty tag, 0 results after filtering) before the clean
  // word "horror" ever got a chance - the phrase attempt must be built from
  // filler-stripped words, not the raw remaining text.
  const wordsInOrder = withoutDecade.toLowerCase().split(/\s+/).filter((w) => w && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w))
  const significant = [...wordsInOrder].sort((a, b) => b.length - a.length)

  let keywordId = null
  if (significant.length > 0) {
    // Only worth trying as a phrase when there's more than one significant
    // word - a single word has nothing left to distinguish it from the
    // per-word retry below, and phrase search is the riskier of the two
    // (more prone to matching an obscure compound tag over the real one).
    if (wordsInOrder.length > 1) {
      keywordId = await lookupTmdbKeywordId(wordsInOrder.join(' '), apiKey)
    }
    if (!keywordId) {
      // Retry word by word, longest first, so a real theme word wins over
      // an incidental short one ("30 days of halloween" -> "halloween").
      for (const word of significant) {
        keywordId = await lookupTmdbKeywordId(word, apiKey)
        if (keywordId) break
      }
    }
  }

  if (decadeRange && keywordId) {
    candidates = await discoverByKeywordAndDecade(keywordId, decadeRange, apiKey)
  } else if (decadeRange) {
    candidates = await discoverByDecade(decadeRange, apiKey)
  } else if (keywordId) {
    candidates = await discoverByKeyword(keywordId, apiKey)
  } else {
    // No matching TMDb keyword at all - fall back to a plain title search
    // (movies only; TV title search is noisier for a theme-driven name).
    const searchRsp = await fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(trimmed)}&api_key=${encodeURIComponent(apiKey)}`)
    const searchData = searchRsp.ok ? await searchRsp.json() : { results: [] }
    candidates = (searchData.results || []).map((r) => ({ tmdbId: r.id, type: 'movie', name: r.title, poster: r.poster_path, year: r.release_date?.slice(0, 4) }))
  }

  const capped = candidates.slice(0, MAX_SUGGESTIONS * 2) // headroom for excluded/unresolvable dropouts
  const resolved = await mapLimit(capped, 8, async (c) => {
    try {
      const ext = await fetch(`https://api.themoviedb.org/3/${c.type === 'series' ? 'tv' : 'movie'}/${c.tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`)
      if (!ext.ok) return null
      const extData = await ext.json()
      const imdbId = extData.imdb_id
      if (!imdbId || excluded.has(imdbId)) return null
      return {
        id: imdbId,
        type: c.type,
        name: c.name || 'Untitled',
        poster: c.poster ? `${TMDB_IMG}${c.poster}` : null,
        year: c.year || null,
      }
    } catch { return null }
  })

  return resolved.filter(Boolean).slice(0, MAX_SUGGESTIONS)
}

// Export a local CustomList's items as a brand-new MDBList list - the
// inverse of importFromMdblist above, using the same create-list +
// add-items pair confirmed live against MDBList's own OpenAPI spec
// (https://api.mdblist.com/schema/): POST /lists/user/add creates the list,
// POST /lists/{id}/items/add populates it (movies/shows split by imdb id).
// The list is created private by default - purely a mechanical copy of this
// app's own catalog, not something meant to be discoverable on MDBList.
async function exportListToMdblist(apiKey, listName, items) {
  if (!apiKey) throw new Error('MDBList API key not configured (Settings -> SlickTrax)')

  const createRsp = await fetch(`https://api.mdblist.com/lists/user/add?apikey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: listName, private: true }),
  })
  if (!createRsp.ok) throw new Error('Failed to create the MDBList list')
  const createdRaw = await createRsp.json()
  const created = Array.isArray(createdRaw) ? createdRaw[0] : createdRaw
  const listId = created?.id
  if (!listId) throw new Error('MDBList did not return a list id')

  const movies = items.filter((i) => i.type === 'movie').map((i) => ({ imdb: i.id }))
  const shows = items.filter((i) => i.type === 'series').map((i) => ({ imdb: i.id }))

  const addRsp = await fetch(`https://api.mdblist.com/lists/${listId}/items/add?apikey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ movies, shows }),
  })
  if (!addRsp.ok) throw new Error('List created, but failed to add items to it')
  const addResult = await addRsp.json()
  // Confirmed live against a real MDBList account this session: each of
  // added/existing/not_found is itself an object broken down by media type
  // ({movies, shows, seasons, episodes}), not a flat number - summing
  // movies+shows here (seasons/episodes don't apply, this app only ever
  // sends whole movies/shows).
  const sumMoviesAndShows = (obj) => (Number(obj?.movies) || 0) + (Number(obj?.shows) || 0)

  return {
    id: listId,
    name: created?.name || listName,
    slug: created?.slug || null,
    // Confirmed live: the create response returns this directly (e.g.
    // https://mdblist.com/lists/{username}/{slug}) - no need to guess the
    // username or construct it ourselves.
    url: created?.url || null,
    added: sumMoviesAndShows(addResult?.added),
    existing: sumMoviesAndShows(addResult?.existing),
    notFound: sumMoviesAndShows(addResult?.not_found),
  }
}

// Shared core of POST /api/lists/:id/refresh, factored out so the manual
// (human-reviewed diff, opt-in apply) route and the automatic scheduler
// (server/utils/catalogAutoRefresh.js, always applies - that's the whole
// point of opting in) both go through the exact same fetch-and-diff logic
// rather than two copies that could quietly drift apart. accountId-direct
// (no req) since the scheduler has no Express request to resolve a key
// from - same pattern as resolveOmdbKeyForAccount above.
async function refreshListFromSourceForAccount(prisma, accountId, list) {
  if (!list.importSourceUrl) throw new Error('This catalog wasn\'t imported from a list, so there\'s no source to refresh from.')
  const provider = detectProvider(list.importSourceUrl)
  if (!provider) throw new Error('The source URL saved for this catalog is no longer recognized')

  const noReq = () => accountId
  let result
  if (provider === 'slicksync') {
    // No key to resolve - the share token is already in importSourceUrl.
    result = await importFromSlickSync(list.importSourceUrl)
  } else if (provider === 'tmdb') {
    const key = await resolveTmdbKey(prisma, noReq, null)
    result = await importFromTmdb(key, list.importSourceUrl)
  } else if (provider === 'trakt') {
    const clientId = await resolveKeyFromSettings(prisma, noReq, null, 'traktClientId', 'TRAKT_CLIENT_ID', { allowBackup: false })
    result = await importFromTrakt(list.importSourceUrl, clientId)
  } else {
    const key = await resolveMdblistKey(prisma, noReq, null)
    result = await importFromMdblist(key, list.importSourceUrl)
  }

  const parseItems = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
  const currentIds = new Set(parseItems(list.itemsJson).map((i) => i.id))
  const freshIds = new Set(result.items.map((i) => i.id))
  const added = result.items.filter((i) => !currentIds.has(i.id)).length
  const removed = [...currentIds].filter((id) => !freshIds.has(id)).length
  const unchanged = result.items.length - added

  return { items: result.items, added, removed, unchanged }
}

/**
 * Trakt public list -> catalog items.
 *
 * Accepts both URL shapes Trakt itself produces:
 *   trakt.tv/users/<user>/lists/<slug>
 *   trakt.tv/lists/<id>
 * Items already carry IMDb ids in Trakt's response, so unlike TMDb there is
 * no per-item follow-up call - only posters are backfilled, through the same
 * Cinemeta helper the MDBList path uses.
 */
async function importFromTrakt(url, clientId) {
  if (!clientId) throw new Error('A Trakt Client ID is needed to read public lists (Settings -> Integrations)')
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  let apiPath = null
  if (parts[0] === 'users' && parts[2] === 'lists' && parts[3]) {
    apiPath = `/users/${encodeURIComponent(parts[1])}/lists/${encodeURIComponent(parts[3])}/items`
  } else if (parts[0] === 'lists' && parts[1]) {
    apiPath = `/lists/${encodeURIComponent(parts[1])}/items`
  }
  if (!apiPath) throw new Error('That does not look like a Trakt list URL')

  const res = await fetch(`https://api.trakt.tv${apiPath}?limit=${MAX_IMPORT_ITEMS}`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 404) throw new Error('That Trakt list was not found, or it is private')
  if (!res.ok) throw new Error(`Trakt returned ${res.status}`)
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error('Unexpected response from Trakt')

  // The items endpoint carries no list name, so ask for the list itself -
  // one extra call, and the alternative is a catalog called "Imported list".
  let name = null
  try {
    const metaRes = await fetch(`https://api.trakt.tv${apiPath.replace(/\/items$/, '')}`, {
      headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId },
      signal: AbortSignal.timeout(10000),
    })
    if (metaRes.ok) name = (await metaRes.json())?.name || null
  } catch { /* a missing name is cosmetic */ }

  const items = []
  for (const row of rows) {
    const media = row?.movie || row?.show
    const type = row?.movie ? 'movie' : row?.show ? 'series' : null
    const imdb = media?.ids?.imdb
    if (!type || !imdb || !/^tt\d+$/.test(imdb)) continue // episodes/people entries and anything without an IMDb id
    items.push({ id: imdb, type, name: media.title || imdb, year: media.year || null, poster: null })
  }

  await mapLimit(items, 8, async (item) => {
    item.poster = await resolveSinglePoster(item.id, item.type, null).catch(() => null)
  })
  return { items, name: name || 'Trakt list', truncated: rows.length >= MAX_IMPORT_ITEMS }
}

module.exports = { detectProvider, importFromTmdb, importFromMdblist, importFromTrakt, importFromSlickSync, importFromAniList, importFromMyAnimeList, exportListToMdblist, resolveTmdbKey, resolveMdblistKey, resolveOmdbKey, resolveOmdbKeyForAccount, resolveTmdbKeyForAccount, resolveKeyFromSettings, refreshListFromSourceForAccount, suggestTitlesForCatalog, mapLimit, MAX_IMPORT_ITEMS }
