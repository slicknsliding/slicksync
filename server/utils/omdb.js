// OMDb API integration - Rotten Tomatoes and Metacritic ratings, keyed by
// IMDb ID. OMDb also returns its own imdbRating, useful as a bonus for
// callers with no other IMDb rating source (e.g. Activity's history feed,
// which reads straight from the DB and never touches Cinemeta) - callers
// that already have a Cinemeta imdbRating (the detail modal, Discover) keep
// using that one and can ignore this field.
//
// Free-tier OMDb allows 1,000 requests/day. Ratings essentially never
// change, so an in-memory cache (same simple Map+TTL pattern as notify.js's
// metadataCache) keeps repeat lookups of the same title free - the process
// restarts on every deploy anyway, so unbounded growth between deploys isn't
// a real concern at this scale. Misses (title not found, or found but with
// no RT/Metacritic data) are cached too, so a title OMDb doesn't have data
// for isn't re-requested on every poster render until the TTL expires.
const ENV_OMDB_API_KEY = process.env.OMDB_API_KEY || null

const omdbCache = new Map()
const OMDB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// The cache PERSISTS across restarts (data/omdb-cache.json). It used to be
// memory-only on the reasoning that deploy restarts were rare - but every
// deploy restarted with a cold cache, and the self-usage meter revealed
// what that actually cost: a busy deploy day re-fetched ratings for
// everything the background jobs touch and burned most of the 1,000/day
// free quota with the user nowhere near the app. Loaded lazily on first
// lookup, saved debounced (10s) so hot paths never wait on disk.
const OMDB_CACHE_FILE = require('path').join(process.cwd(), 'data', 'omdb-cache.json')
let cacheLoaded = false
let cacheSaveTimer = null
function loadOmdbCacheOnce() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = JSON.parse(require('fs').readFileSync(OMDB_CACHE_FILE, 'utf8'))
    const cutoff = Date.now() - OMDB_CACHE_TTL_MS
    for (const [k, v] of Object.entries(raw)) {
      if (v && v.at > cutoff) omdbCache.set(k, v)
    }
  } catch { /* first run or unreadable - start empty, same as before */ }
}
function saveOmdbCacheSoon() {
  if (cacheSaveTimer) return
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null
    try {
      require('fs').writeFileSync(OMDB_CACHE_FILE, JSON.stringify(Object.fromEntries(omdbCache)))
    } catch { /* cache persistence is best-effort */ }
  }, 10000)
  if (cacheSaveTimer.unref) cacheSaveTimer.unref()
}

// OMDb's own "test your key" confirmation page/email shows a full URL like
// http://www.omdbapi.com/?i=tt3896198&apikey=<key> - easy to paste that
// whole thing into Settings instead of just the key (confirmed real case).
// Pulled in raw, that breaks the request URL below silently (no ratings,
// no error). Extract the real key if that happened, rather than sending an
// unusable value on every request forever.
function normalizeOmdbApiKey(raw) {
  if (!raw) return raw
  const trimmed = String(raw).trim()
  const match = trimmed.match(/[?&]apikey=([^&\s]+)/i)
  return match ? match[1] : trimmed
}

// apiKey is per-account (Settings, resolved via resolveOmdbKey in
// listImport.js) - callers that can cheaply reach prisma+accountId should
// resolve and pass their own, same as RPDB/MDBList/TMDB already do,
// instead of every account on a shared instance quietly drawing down
// whoever's key happens to be sitting in the instance-level .env. Falls
// back to that env key for callers not yet threading one through (still
// correct, just not account-isolated) - the cache stores only public
// rating data, so it's safe to share across whichever key fetched it.
async function fetchOmdbRatings(imdbId, apiKey, opts = {}) {
  const key = normalizeOmdbApiKey(apiKey || ENV_OMDB_API_KEY)
  if (!key || !imdbId || !/^tt\d+$/.test(imdbId)) return null

  loadOmdbCacheOnce()
  const cached = omdbCache.get(imdbId)
  if (cached && (Date.now() - cached.at) < OMDB_CACHE_TTL_MS) {
    return cached.value
  }

  // Quota autopilot (opt-in, off by default): once the day's usage crosses
  // the configured threshold, BACKGROUND enrichment stands down until the
  // midnight-UTC reset rather than spending the last of the allowance on
  // work nobody is waiting for. Callers that a person is actively waiting
  // on never pass background:true, so opening a title still fetches. Cache
  // hits above are unaffected - a deferral only ever skips a NEW request.
  if (opts.background && shouldDeferBackground(key, opts)) {
    return null
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    require('./omdbMeter').recordOmdbRequest(key)
    const response = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`, {
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) return null
    const data = await response.json()

    if (data?.Response === 'False') {
      omdbCache.set(imdbId, { value: null, at: Date.now() }); saveOmdbCacheSoon()
      return null
    }

    const ratingsArray = Array.isArray(data.Ratings) ? data.Ratings : []
    const rottenTomatoes = ratingsArray.find(r => r.Source === 'Rotten Tomatoes')?.Value || null
    // OMDb's Ratings array entry for Metacritic is "72/100"; top-level
    // Metascore is the same number bare ("72") when present. Prefer the
    // array entry but fall back to Metascore, and always normalize to the
    // bare number so the client doesn't need to know which shape it got.
    const metacriticEntry = ratingsArray.find(r => r.Source === 'Metacritic')?.Value
    const metacritic = metacriticEntry
      ? metacriticEntry.split('/')[0]
      : (data.Metascore && data.Metascore !== 'N/A' ? data.Metascore : null)

    const imdbRating = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null
    // Movies only in practice - OMDb returns "N/A" for virtually every TV
    // series (no theatrical release to report a gross for).
    const boxOffice = data.BoxOffice && data.BoxOffice !== 'N/A' ? data.BoxOffice : null
    // Content/age rating (MPAA for movies - "PG-13", "R" - or TV parental
    // guidelines - "TV-14", "TV-MA"), NOT a quality score - powers Catalogs'
    // content-rating policy (server/utils/contentRating.js). OMDb uses both
    // "N/A" and "Not Rated" for "no rating on file"; only "N/A" is
    // meaningless, "Not Rated" is itself a real value someone may want to
    // flag (unrated content is sometimes MORE explicit than an R, not less).
    const rated = data.Rated && data.Rated !== 'N/A' ? data.Rated : null

    if (!rottenTomatoes && !metacritic && !imdbRating && !boxOffice && !rated) {
      omdbCache.set(imdbId, { value: null, at: Date.now() }); saveOmdbCacheSoon()
      return null
    }

    const result = { imdbRating, rottenTomatoes, metacritic, boxOffice, rated }
    omdbCache.set(imdbId, { value: result, at: Date.now() }); saveOmdbCacheSoon()
    return result
  } catch {
    return null
  }
}

// Remembers the last day a deferral was announced, so the bell gets one
// row per day rather than one per skipped title.
let deferredNotifiedOn = null

/**
 * True when background enrichment should stand down for today. Reads the
 * meter directly (utils/omdbMeter.js self-counts per key per UTC day, since
 * OMDb's API reports no quota of its own); the caller passes the account's
 * autopilot settings, so this stays a pure function of what it is given.
 */
function shouldDeferBackground(key, opts) {
  if (!opts?.autopilot) return false
  try {
    const { readOmdbUsage } = require('./omdbMeter')
    const usage = readOmdbUsage(key)
    const threshold = Number.isFinite(Number(opts.thresholdPercent)) ? Number(opts.thresholdPercent) : 90
    if (!usage || !Number.isFinite(usage.percentUsed) || usage.percentUsed < threshold) return false

    // One notification per UTC day, best-effort - a bell row explaining why
    // some ratings are missing tonight beats them silently not appearing.
    const today = new Date().toISOString().slice(0, 10)
    if (opts.prisma && opts.accountId && deferredNotifiedOn !== today) {
      deferredNotifiedOn = today
      require('./notificationStore').createNotification(opts.prisma, opts.accountId, {
        type: 'task',
        title: 'OMDb enrichment paused for today',
        body: `Today's OMDb usage reached ${Math.round(usage.percentUsed)}% of the free allowance, so background rating lookups are waiting for the midnight-UTC reset. Anything you open still fetches normally.`,
        url: '/settings',
        dedupeKey: `omdb-autopilot-${today}`,
      }).catch(() => {})
    }
    return true
  } catch {
    // A meter that can't be read must never block enrichment.
    return false
  }
}

/**
 * Builds the options a background caller passes to fetchOmdbRatings, from
 * the account's own autopilot settings. Returns a disabled set on any
 * failure, so a settings read that goes wrong can never stop enrichment.
 */
async function backgroundOmdbOpts(prisma, accountId) {
  const disabled = { background: true, autopilot: false }
  try {
    const account = await prisma.appAccount.findFirst({ where: { id: accountId }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (!cfg || typeof cfg !== 'object') return disabled
    return {
      background: true,
      autopilot: cfg.quotaAutopilot === true,
      thresholdPercent: Number.isFinite(Number(cfg.quotaAutopilotPercent)) ? Number(cfg.quotaAutopilotPercent) : 90,
      prisma,
      accountId,
    }
  } catch {
    return disabled
  }
}

module.exports = { fetchOmdbRatings, normalizeOmdbApiKey, shouldDeferBackground, backgroundOmdbOpts }
