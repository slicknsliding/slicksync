// Proxy stream monitor - polls AIOStreams' unified live-streams dashboard
// endpoint and mirrors active/ended sessions into ProxyStreamSession rows,
// giving SlickSync a "Now Playing" signal for Stremio/Nuvio users that
// AIOStreams itself can see (this proxy sits in the middle of every stream
// request), independent of the Nuvio-sourced WatchSession pipeline.
//
// AIOStreams' /api/v1/dashboard/streams/live route is gated by requireAdmin
// (dashboard session cookie auth) - there is no separate API key mechanism
// in this version of AIOStreams. So this module logs in with AIOSTREAMS_AUTH
// credentials the same way the browser dashboard does, caches the resulting
// session cookie, and re-logs-in on a 401.
//
// This endpoint replaced the older /api/v1/proxy/stats + separate
// /api/v1/dashboard/usenet/live routes on recent (nightly, confirmed
// 2026-08-18) AIOStreams builds - the old proxy/stats path now 400s with
// "Invalid encrypted auth and data" (it's being matched by the actual
// stream-serving proxy route instead of a stats handler, since the stats
// route it used to be no longer exists). The new response is one flat
// `streams[]` array covering BOTH transports at once (each row tagged
// `transport: 'proxy' | 'usenet'`), with real per-row identity
// (username/clientIp/targetKey) - no more synthetic usenet identity needed
// for a row that actually came back attributed. Verified live via an
// authenticated browser session against this exact instance.
//
// Session identity: each live stream has a stable `targetKey` (AIOStreams'
// own words: "Stable identity of what is being streamed") - this module
// reuses it as the `url` column below (the DB schema/unique-key predates
// this rename and isn't worth a migration for a column that's always been
// "whatever this session's stable identity string is", not literally a URL).

const { searchCinemetaPosterByTitle } = require('./libraryHelpers')
const { sendSessionStartNotification } = require('./sessionTracker')
const { notifyPushForType } = require('./pushNotifications')

// A connection counts as playing from its second request - see proxyPlaying.js.
const { isPlayingConnection } = require('./proxyPlaying')

const { proxyDisplayTitle } = require('./proxyTitle')
const CHECK_INTERVAL_MS = 30 * 1000 // 30s - streams start/stop faster than the 1min library-sync interval

// Overlap guard. pollOnce is async and this runs on a fixed 30s timer, so
// without this a poll that takes longer than the interval - which is exactly
// what happens when AIOStreams is slow or rate-limiting, since requests hang
// and the 401 branch adds a re-login round trip - has the next one start on
// top of it. They stack, each re-authenticating, which drives MORE requests
// at an instance that is already refusing them. Reported in the wild as
// SlickSync tripping an AIOStreams account's internal rate limiter while
// appearing to poll far more often than its configured interval.
//
// The other two schedulers in this codebase already guard this way
// (activityMonitor's isAccountsPassRunning, addonHealthCheck's isRunning);
// this one simply never did.
let isPolling = false

// Backoff after the upstream signals rate limiting. Mirrors the escalating
// breaker the Supabase provider already uses: back off further each
// consecutive time, honour Retry-After when given, and reset once a poll
// succeeds again. Without this, a 429 just became a thrown error and the
// next tick retried 30s later, forever.
const RATE_LIMIT_BASE_COOLDOWN_MS = 2 * 60 * 1000
const RATE_LIMIT_MAX_COOLDOWN_MS = 15 * 60 * 1000
let rateLimitedUntil = 0
let consecutiveRateLimits = 0

function noteRateLimited(retryAfterSeconds) {
  consecutiveRateLimits += 1
  const escalated = RATE_LIMIT_BASE_COOLDOWN_MS * Math.pow(2, consecutiveRateLimits - 1)
  const headerMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0
  const cooldown = Math.min(Math.max(escalated, headerMs), RATE_LIMIT_MAX_COOLDOWN_MS)
  rateLimitedUntil = Date.now() + cooldown
  console.warn(`[ProxyStreamMonitor] AIOStreams rate-limited us - pausing polls for ${Math.round(cooldown / 1000)}s`)
  heartbeat('rate_limited', { cooldownMs: cooldown, consecutive: consecutiveRateLimits })
}

function noteRateLimitCleared() {
  if (consecutiveRateLimits > 0) heartbeat('rate_limit_cleared', { after: consecutiveRateLimits })
  consecutiveRateLimits = 0
  rateLimitedUntil = 0
}

// Fallback identity for a stream AIOStreams couldn't attribute to a user at
// all (empty `username` - StreamOpenInput's own comment: "Empty when the
// caller could not be identified; exempt from limits"). Kept in the SAME
// ProxyStreamSession table/unique-key/notification pipeline real streams
// use - every such stream still resolves through resolveUserForActiveConnection's
// existing AIOSTREAMS_FALLBACK_USER_IDS path, same as any other "activity
// AIOStreams can't attribute" case already does. Named generically now
// (used for either transport when unattributed), not usenet-specific.
const UNATTRIBUTED_SYNTHETIC_USER = '__unattributed__'
const UNATTRIBUTED_SYNTHETIC_IP = 'unattributed'

let pollTimer = null
let cachedCookie = null
// Last poll outcome, for the health board (server/routes/health.js) - this
// module has no other exposed "is the proxy actually reachable right now"
// signal; everything else here is fire-and-forget into a debug log file.
let lastPollStatus = { ok: null, at: null, error: null }
// When a poll last succeeded, how many have failed in a row since, and which
// account this process polls for. Now Playing reads these (through
// isProxyMonitorConfirming) so a "live" row is only shown while something is
// still confirming it.
let lastOkAt = 0
let consecutiveFailures = 0
let failingSince = null
let closedRowsThisOutage = false
let monitoredAccountId = null

function getProxyMonitorStatus() {
  return {
    ...lastPollStatus,
    lastOkAt: lastOkAt ? new Date(lastOkAt) : null,
    failingSince,
    consecutiveFailures,
  }
}

// A poll counts as recent for a few intervals - one slow answer must not
// blank Now Playing.
const CONFIRM_WINDOW_MS = CHECK_INTERVAL_MS * 4
// While AIOStreams has told us to back off we are not polling on purpose;
// rows are still believed for this long, never indefinitely.
const RATE_LIMIT_TRUST_MS = 20 * 60 * 1000
// Failures in a row (about three minutes) before live rows are closed.
const FAILURES_BEFORE_CLOSE = 6

/**
 * Whether the proxy's "this is playing right now" rows can be believed for
 * this account. A row is only as fresh as the last successful poll: when
 * polling stops working (AIOStreams down, sign-in refused, the process
 * stuck), whatever was live at that moment would otherwise stay on screen as
 * "playing" - confirmed in the wild as one film shown playing for two and a
 * half days. With no poller in this process at all there is nothing to
 * judge by, so rows are taken as they are.
 */
function isProxyMonitorConfirming(accountId, now = Date.now()) {
  if (!monitoredAccountId) return true
  if (accountId && accountId !== monitoredAccountId) return false
  if (!lastOkAt) return false
  const age = now - lastOkAt
  if (age <= CONFIRM_WINDOW_MS) return true
  return rateLimitedUntil > now && age <= RATE_LIMIT_TRUST_MS
}

function heartbeat(event, data = {}) {
  try {
    const fs = require('fs')
    const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}\n`
    require('./debugLogFile').appendCapped('/app/data/proxy-stream-monitor-debug.log', line)
  } catch {}
}

function clearProxyStreamMonitor() {
  monitoredAccountId = null
  lastOkAt = 0
  consecutiveFailures = 0
  failingSince = null
  closedRowsThisOutage = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  cachedCookie = null
}

// Where a release name's own tags begin. Only unmistakable ones - a word that
// can also be part of a title ("WEB", "Extended") would cut real titles short.
const FIRST_RELEASE_TAG = /(?<![a-z0-9])(?:2160p|1080[pi]|720p|576p|480p|4K|HDR|WEB-?DL|WEBRip|Blu-?Ray|BRRip|BDRip|DVDRip|HDTV|HEVC|x26[45]|H[.\s]?26[45]|DDP?5[.\s]?1|AAC|AC3|REMUX)(?![a-z0-9])/i
// Nothing but edition wording after a second year-like number.
const EDITION_WORDS_ONLY = /^(?:[.\s]*(?:the|remaster(?:ed)?|restor(?:ed|ation)|extended|unrated|uncut|theatrical|imax|redux|criterion|ultimate|(?:directors?|final|extended|theatrical)[.\s]cut|(?:special|anniversary|collectors?|ultimate|extended)[.\s]edition))+[.\s]*$/i

function parseDisplayName(filename) {
  if (!filename) return null

  // Some NZB/torrent releases prepend the indexer/tracker site's own name
  // to the actual filename (confirmed real case: "www.UIndex.org - Made.In.
  // Korea.S01E05..." parsed straight through as the title otherwise, since
  // there's no year/quality tag in a TV episode filename to bound where the
  // real title starts - it just fell through both cleanup paths below
  // untouched). Anchored to the start only, never strips mid-filename text.
  const withoutSiteTag = filename.replace(/^\s*www\.[a-z0-9-]+\.[a-z]{2,6}\s*[-_]\s*/i, '')

  // An extension has a letter in it. Without that, a name with no extension
  // that ends in its year ("Some.Film.2020") lost the year here.
  const withoutExt = withoutSiteTag.replace(/\.(?=[a-zA-Z0-9]{2,4}$)(?=\d*[a-zA-Z])[a-zA-Z0-9]+$/, '')

  // The release year is looked for only in the part before the release's own
  // tags, and it is the LAST number there that can be a year. The first one
  // used to win, which read a number in the title as the year: "Blade.Runner.
  // 2049.2017" became "Blade Runner (2049)" - no poster, and the wrong name.
  // A number above next year is not a release year at all, so "Blade.Runner.
  // 2049.1080p" keeps its full title rather than gaining a year.
  // The year may or may not be parenthesized (both "Send.Help.2026.WEB-DL"
  // and "Send.Help.(2026).VU.Blu-ray" occur).
  // A tag at the very start is part of the title ("4K.Kings.2019", "HDR.
  // Hunters.2020"), so only a tag after the first character counts.
  let tagAt = -1
  for (const m of withoutExt.matchAll(new RegExp(FIRST_RELEASE_TAG.source, 'gi'))) {
    if (m.index > 0) { tagAt = m.index; break }
  }
  const beforeTags = tagAt === -1 ? withoutExt : withoutExt.slice(0, tagAt)
  const latestYear = new Date().getFullYear() + 1
  const years = []
  for (const m of beforeTags.matchAll(/[.\s]\(?(\d{4})\)?(?=[.\s]|$)/g)) {
    const y = Number(m[1])
    if (y >= 1880 && y <= latestYear) years.push({ at: m.index, end: m.index + m[0].length, year: m[1] })
  }
  // "Film.1999.Remastered.2021": the second number dates the edition.
  let pick = years.length - 1
  // ...and so does a second number with only edition wording after it
  // ("Film.1979.2024.Remaster"). Two numbers with nothing after the second
  // are a title and its year ("Wonder.Woman.1984.2020").
  // PROPER and REPACK are scene tags, not edition wording, so they do not
  // count here: "Wonder.Woman.1984.2020.PROPER" is still a title and its year.
  if (pick > 0 && EDITION_WORDS_ONLY.test(beforeTags.slice(years[pick].end).replace(/(?<![a-z0-9])(?:proper|repack|rerip)(?![a-z0-9])/gi, ' '))) pick -= 1
  // Any words between two year-like numbers mean the second one dates a
  // re-release ("Casablanca.1942.70th.Anniversary.2012"); a closed list of
  // that wording can never be complete. Nothing between them is a title that
  // has a year in it, followed by its release year.
  while (pick > 0 && /[a-z]/i.test(beforeTags.slice(years[pick - 1].end, years[pick].at))) pick -= 1

  if (pick >= 0) {
    let title = beforeTags.slice(0, years[pick].at).replace(/\./g, ' ').trim()
    // Strip numeric-junk parenthetical groups (e.g. a literal "(1.23.45)"
    // timestamp/version marker from the release name) that survive the
    // dot-to-space cleanup untouched, since only dots get replaced there -
    // not the parentheses. This kind of content is never real title text.
    title = title.replace(/\(\s*[\d\s:.-]+\s*\)/g, '').replace(/\s+/g, ' ').trim()
    if (title) return `${title} (${years[pick].year})`
  }

  const cleaned = beforeTags.replace(/[._]/g, ' ').trim()

  return cleaned || withoutExt.replace(/[._]/g, ' ').trim()
}

// Signing in again and again against a wrong password, or a login page that
// is not AIOStreams' own, is what trips its login limiter. After a failed
// sign-in the next one waits, longer each time.
const LOGIN_RETRY_BASE_MS = 60 * 1000
const LOGIN_RETRY_MAX_MS = 15 * 60 * 1000
let loginBlockedUntil = 0
let consecutiveLoginFailures = 0

function noteLoginFailed() {
  consecutiveLoginFailures += 1
  const wait = Math.min(LOGIN_RETRY_BASE_MS * Math.pow(2, consecutiveLoginFailures - 1), LOGIN_RETRY_MAX_MS)
  loginBlockedUntil = Date.now() + wait
  heartbeat('login_failed_backing_off', { waitMs: wait, consecutive: consecutiveLoginFailures })
}

function authError(message) {
  const err = new Error(message)
  err.authFailed = true
  return err
}

// A sign-in that worked this poll, followed by an answer that cannot be used,
// drops the cookie. Done on every poll that signs in a new session each time,
// about 120 logins an hour. After a few rounds in a row it backs off like a
// refused sign-in. A cookie that merely expired (not issued this poll) is
// never counted: that recovers on the next poll.
const FRESH_REJECTIONS_BEFORE_BACKOFF = 3
let consecutiveFreshRejections = 0

function noteFreshCookieRejected(fresh) {
  if (!fresh) return
  consecutiveFreshRejections += 1
  if (consecutiveFreshRejections >= FRESH_REJECTIONS_BEFORE_BACKOFF) noteLoginFailed()
}

const isWebPage = (res) => /html/i.test(res.headers.get('content-type') || '')

// An expired sign-in. AIOStreams used to answer 401; newer builds redirect to
// their login page instead, which fetch follows - so what arrives is a web
// page with status 200. Reading that as JSON threw on every poll, nothing
// ever signed in again, and the monitor stayed dead until the next restart.
// Judged by what arrived, not by whether a redirect happened on the way: an
// address that redirects http to https and then answers properly is fine.
function sessionExpired(res) {
  if (res.status === 401) return true
  if (res.status >= 300 && res.status < 400) return true
  return res.ok && isWebPage(res)
}

async function signIn(baseUrl, username, password) {
  if (Date.now() < loginBlockedUntil) {
    throw authError('Waiting before signing in to AIOStreams again')
  }
  try {
    cachedCookie = await loginToAiostreams(baseUrl, username, password)
  } catch (e) {
    cachedCookie = null
    // Only an answer that says "no" backs off. A server that is not up yet
    // (connection refused, a 5xx while it starts) is simply tried again on
    // the next poll - backing off there kept polling stopped for minutes
    // after AIOStreams had come back, long enough for live rows to be closed.
    if (e?.refused) noteLoginFailed()
    const err = authError(e.message)
    // A rate-limited sign-in is AIOStreams asking for a slower pace, not an
    // outage: the caller pauses polling and keeps the live rows.
    if (e?.rateLimited) {
      err.rateLimited = true
      err.retryAfterSeconds = e.retryAfterSeconds
    }
    throw err
  }
  heartbeat('fetchLiveStreams:logged_in')
}

async function loginToAiostreams(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (!res.ok) {
    const err = new Error(`AIOStreams login failed: ${res.status} ${res.statusText}`)
    err.refused = res.status >= 400 && res.status < 500
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10)
      err.rateLimited = true
      err.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null
    }
    throw err
  }

  // AIOStreams' login can set more than one cookie (session + a separate
  // CSRF/anti-forgery cookie, confirmed on recent builds) - headers.get()
  // on a multi-value Set-Cookie only ever returns the FIRST one (the Fetch
  // spec special-cases Set-Cookie to not comma-join, unlike every other
  // header), so grabbing just that dropped the second cookie and made
  // /proxy/stats fail with 400 (missing CSRF token) rather than the 401
  // this module already knows how to recover from. getSetCookie() (Bun/
  // Node 18.14+) returns every Set-Cookie value as its own array entry;
  // fall back to the old single-cookie behavior if it's ever unavailable.
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
  if (setCookies.length === 0) {
    const err = new Error('AIOStreams login succeeded but no Set-Cookie header returned')
    err.refused = true
    throw err
  }

  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

// Returns the flat `streams[]` array from AIOStreams' unified live-streams
// snapshot (both proxy and usenet transports together - see this file's own
// header comment). Falls back to the pre-2026-08 /api/v1/proxy/stats shape
// (`{ users: [{ username, active: [...] }] }`) only if the new route 404s,
// so an instance running an older/stable AIOStreams build still gets
// *proxy* Now Playing (just not usenet, which that older API never exposed
// either) instead of losing the feature outright on a version this module
// hasn't caught up to yet.
async function fetchLiveStreams(baseUrl, username, password) {
  // Whether this poll made the sign-in it is using.
  let fresh = false
  if (!cachedCookie) {
    await signIn(baseUrl, username, password)
    fresh = true
  }

  const ask = () => fetch(`${baseUrl}/api/v1/dashboard/streams/live`, {
    headers: { Cookie: cachedCookie, Accept: 'application/json' },
  })
  let res = await ask()

  // 404 is checked before this on purpose: an AIOStreams without the route
  // answers 404 with a web page too, and that is the legacy fallback below,
  // not an expired sign-in.
  if (res.status !== 404 && res.status !== 429 && sessionExpired(res)) {
    heartbeat('fetchLiveStreams:session_expired_relogging_in', { status: res.status, redirected: !!res.redirected })
    cachedCookie = null
    await signIn(baseUrl, username, password)
    fresh = true
    res = await ask()
    if (res.status !== 404 && res.status !== 429 && sessionExpired(res)) {
      // Signed in and still no data: whatever answers at this address is not
      // handing out AIOStreams' stream list. Back off like a failed sign-in.
      cachedCookie = null
      noteLoginFailed()
      throw authError(`AIOStreams did not return its stream list after signing in (status ${res.status})`)
    }
  }

  // Rate limited. Surfaced as a typed error so the caller can back off
  // rather than treating it as a generic failure and retrying on the next
  // 30s tick - retrying into a rate limiter is what deepens it.
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10)
    const err = new Error('AIOStreams rate-limited this request (429)')
    err.rateLimited = true
    err.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null
    throw err
  }

  if (res.status === 404) {
    heartbeat('fetchLiveStreams:falling_back_to_legacy_proxy_stats')
    return fetchLegacyProxyStats(baseUrl, fresh)
  }

  if (!res.ok) {
    throw new Error(`AIOStreams /dashboard/streams/live failed: ${res.status} ${res.statusText}`)
  }

  let json
  try {
    json = await res.json()
  } catch {
    // Not JSON after all - sign in afresh next time rather than repeating this.
    cachedCookie = null
    noteFreshCookieRejected(fresh)
    throw authError('AIOStreams answered with something that is not its stream list')
  }
  // Real data: the sign-in works, so any back-off is over.
  consecutiveFreshRejections = 0
  consecutiveLoginFailures = 0
  loginBlockedUntil = 0
  const streams = json?.data?.streams ?? json?.streams ?? []
  // Normalize the legacy shape's fields onto the new one so pollOnce only
  // ever has to handle one row shape, regardless of which branch produced it.
  return streams.map((s) => ({
    transport: s.transport || 'proxy',
    username: s.username || '',
    clientIp: s.clientIp || null,
    targetKey: s.targetKey,
    filename: s.filename || null,
    requests: s.requests,
    startedAt: s.startedAt,
    lastSeenAt: s.lastSeenAt,
  }))
}

// Pre-2026-08 AIOStreams shape: { users: [{ username, active: [{ ip, url,
// filename, timestamp, lastSeen, count }] }] }, proxy-only (that API never
// exposed usenet sessions). Reshaped into the same flat row shape
// fetchLiveStreams returns from the new endpoint, so pollOnce below never
// needs to know which branch it came from.
async function fetchLegacyProxyStats(baseUrl, fresh = false) {
  const res = await fetch(`${baseUrl}/api/v1/proxy/stats`, {
    headers: { Cookie: cachedCookie, Accept: 'application/json' },
  })
  // Same expiry handling as the newer route: drop the sign-in so the next
  // poll makes a fresh one, instead of failing the same way forever.
  if (sessionExpired(res)) {
    cachedCookie = null
    noteFreshCookieRejected(fresh)
    throw authError(`AIOStreams sign-in expired (status ${res.status}) - signing in again on the next poll`)
  }
  if (!res.ok) {
    throw new Error(`AIOStreams /proxy/stats failed: ${res.status} ${res.statusText}`)
  }
  let stats
  try {
    stats = await res.json()
  } catch {
    cachedCookie = null
    noteFreshCookieRejected(fresh)
    throw authError('AIOStreams answered with something that is not its proxy stats')
  }
  // Real data: the sign-in works, so any back-off is over.
  consecutiveFreshRejections = 0
  consecutiveLoginFailures = 0
  loginBlockedUntil = 0
  const rows = []
  for (const user of stats.users ?? []) {
    for (const conn of user.active ?? []) {
      if (!conn.ip || !conn.url) continue
      rows.push({
        transport: 'proxy',
        username: user.username || '',
        clientIp: conn.ip,
        targetKey: conn.url,
        filename: conn.filename || null,
        requests: conn.count,
        startedAt: conn.timestamp,
        lastSeenAt: conn.lastSeen ?? conn.timestamp,
      })
    }
  }
  return rows
}


// NOTE: the proxy no longer writes completed watch history (see the
// connection-close handling in pollOnce for why - native tracking owns
// history). The former writeCompletedWatchSessions / resolveUserFor-
// ClosedConnection / normalizeTitleForHistory helpers were removed with it.

// Parse a proxy displayName into the pieces a strict Cinemeta poster
// lookup needs: a clean search title, a year (if present), and a best
// guess at movie vs series from the presence of an episode marker.
function parseForPosterLookup(displayName) {
  if (!displayName) return null
  const yearMatch = displayName.match(/\((\d{4})\)\s*$/)
  const year = yearMatch ? yearMatch[1] : null
  let title = year ? displayName.replace(/\s*\(\d{4}\)\s*$/, '') : displayName
  let type = 'movie'
  // Series episode markers: strip from the SxxExx / Exx marker onward so
  // the search query is just the show title, and classify as series.
  const seasonEpisode = title.match(/^(.*?)\s+S\d{1,2}E\d{1,3}\b/i)
  if (seasonEpisode) {
    title = seasonEpisode[1].trim()
    type = 'series'
  } else {
    const bareEpisode = title.match(/^(.*?)\s+E\d{1,3}\b/i)
    if (bareEpisode) {
      title = bareEpisode[1].trim()
      type = 'series'
    }
  }
  return { searchTitle: title, year, type }
}

// Strict poster lookup for one ProxyStreamSession row. Records the result
// (or the fact that none matched) via metadataMatchedAt so it's attempted
// once per stream, not on every 30s poll. Uses Cinemeta's search catalog
// with exact title+year matching (see searchCinemetaPosterByTitle) - a
// confident match also yields a real IMDb id (metadataItemId), which
// improves cross-pipeline history dedup with native tracking. No match =
// no poster, never a wrong one.
async function attemptPosterLookup(prisma, rowId, displayName) {
  try {
    const parsed = parseForPosterLookup(displayName)
    if (!parsed || !parsed.searchTitle) {
      await prisma.proxyStreamSession.update({ where: { id: rowId }, data: { metadataMatchedAt: new Date() } })
      return
    }
    // The movie/series guess comes from an episode marker in the stream's
    // title, and plenty of series streams carry none - "Tales of the City
    // (2019)" is a series that looked like a film. A miss under the guessed
    // type is retried under the other, so a wrong guess costs one extra
    // lookup rather than the poster and the id.
    // Stream titles from localized sources carry a subtitle after a dash -
    // "Toy Story - Il mondo dei giocattoli" - that Cinemeta's English name
    // never matches. The candidates are tried longest first: the full title,
    // then the part before the first dash or colon; each under the guessed
    // type, then the other. Every attempt still demands an exact title and
    // year, so a shorter candidate cannot land on the wrong film - which is
    // why the shorter one is only tried when there IS a year to demand.
    // Without one, "Dexter - New Blood" fell back to "Dexter" and took the
    // original show's poster, name and id.
    const candidates = [parsed.searchTitle]
    const cut = parsed.searchTitle.split(/\s+[-–—:]\s+/)[0].trim()
    if (parsed.year && cut && cut !== parsed.searchTitle && cut.length >= 3) candidates.push(cut)
    const otherType = parsed.type === 'series' ? 'movie' : 'series'
    let result = null
    for (const candidate of candidates) {
      result = await searchCinemetaPosterByTitle(candidate, parsed.year, parsed.type)
        || await searchCinemetaPosterByTitle(candidate, parsed.year, otherType)
      if (result) break
    }
    const updatedRow = await prisma.proxyStreamSession.update({
      where: { id: rowId },
      data: {
        posterUrl: result?.poster ?? null,
        metadataItemId: result?.id ?? null,
        metadataItemType: result?.type ?? null,
        metadataName: result?.name ?? null,
        metadataMatchedAt: new Date(),
      },
    })
    // Backfill into an already-written history entry if the stream closed
    // before this lookup finished. Only fills a still-missing poster.
    if (result?.poster && updatedRow.linkedWatchSessionId) {
      await prisma.watchSession.updateMany({
        where: { id: updatedRow.linkedWatchSessionId, poster: null },
        data: { poster: result.poster },
      })
    }
  } catch (error) {
    heartbeat('pollOnce:poster_lookup_error', { message: error.message, rowId })
  }
}

// Safety net for rows that never got a lookup attempt (e.g. the connection
// ended mid-lookup). Capped per cycle so a backlog doesn't hammer Cinemeta.
async function retryMissingPosters(prisma, accountId) {
  // Two kinds of row: never attempted (a lookup interrupted mid-stream), and
  // attempted but unresolved - retried at most every six hours for a week,
  // so a title the lookup has since learned to resolve (a wrong movie/series
  // guess, a source that was briefly down) gets its poster after all,
  // without a permanently unknowable title being asked about every cycle.
  const stuck = await prisma.proxyStreamSession.findMany({
    where: {
      accountId,
      OR: [
        { metadataMatchedAt: null },
        {
          metadataItemId: null,
          metadataMatchedAt: { lt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
          createdAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        // Matched before the name was recorded alongside the id (an older
        // build): a still-playing stream gets its proper title now rather
        // than at its next start.
        { isActive: true, metadataItemId: { not: null }, metadataName: null },
      ],
    },
    select: { id: true, displayName: true },
    take: 5,
    orderBy: { createdAt: 'asc' },
  })
  for (const row of stuck) {
    await attemptPosterLookup(prisma, row.id, row.displayName)
  }
}

function normalizeForNotify(name) {
  return (name || '').toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Maps an AIOStreams username to a SlickSync user - same tiers as the live
// Now Playing merge (proxyNowPlaying.js): exact username, then email
// local-part, then the AIOSTREAMS_FALLBACK_USER_IDS list (in its configured
// order). Returns null if nothing matches - and also if a match exists but is
// ambiguous and can't be narrowed down, rather than guessing.
//
// The email-local-part tier previously fell through to an unconditional
// `return candidates[0]` when more than one user matched and
// AIOSTREAMS_FALLBACK_USER_IDS wasn't configured (or didn't cover any of the
// candidates) - i.e. it picked whichever user happened to be first in the
// array, not whoever the proxy connection actually belonged to. This bit a
// real household where the same person's Stremio and Nuvio accounts share
// one email: AIOStreams' proxy only knows that shared email, so every
// connection matched both users, and the guess silently misattributed a real
// Nuvio watch onto the Stremio account - including writing a phantom
// MovieWatchHistory row for it via hasConfirmedProxyPlayback's fallback in
// metricsProcessor.js recordMovieWatch. An unresolved ambiguity must return
// null (matching every caller's existing null-safe handling) so a watch is
// left unattributed rather than attributed to the wrong person - same
// "correct or nothing" principle as this codebase's poster matching.
function resolveUserForActiveConnection(users, aiostreamsUser) {
  const lower = (aiostreamsUser || '').toLowerCase()
  const direct = users.find((u) => u.username && u.username.toLowerCase() === lower)
  if (direct) return direct
  const emailMatches = users.filter((u) => u.email && u.email.split('@')[0].toLowerCase() === lower)
  if (emailMatches.length === 1) return emailMatches[0]
  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const candidates = emailMatches.length > 0
    ? emailMatches
    : fallbackUserIds.map((id) => users.find((u) => u.id === id)).filter(Boolean)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  if (fallbackUserIds.length > 0) {
    const byRank = candidates
      .map((u) => ({ u, rank: fallbackUserIds.indexOf(u.id) }))
      .filter((c) => c.rank !== -1)
      .sort((a, b) => a.rank - b.rank)
    if (byRank.length) return byRank[0].u
  }
  return null
}

// Sends the instant "started watching" Discord notification for a brand-new
// proxy connection. This is why it lives in the proxy pipeline and not the
// native one: the proxy sees playback begin in real time, whereas native
// tracking only notices once the provider writes a watch checkpoint (late).
// Deduped so a seek (which opens a fresh connection for content already
// playing) doesn't re-notify.
async function maybeNotifyStart(prisma, accountId, webhookUrl, users, aiostreamsUser, rowId, displayName) {
  try {
    // Seek/continuation guard: if this user already has another active
    // connection for the same title, they're already watching it - skip.
    const norm = normalizeForNotify(displayName)
    const otherActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, aiostreamsUser, isActive: true, NOT: { id: rowId } },
      select: { displayName: true },
    })
    if (otherActive.some((o) => normalizeForNotify(o.displayName) === norm)) return

    const user = resolveUserForActiveConnection(users, aiostreamsUser)
    if (!user) return
    // Per-user opt-out: this specific user's watch activity doesn't notify
    // at all, regardless of the account-level toggle that got us here.
    if (user.notifyOnWatch === false) return

    const fresh = await prisma.proxyStreamSession.findUnique({
      where: { id: rowId },
      select: { posterUrl: true, metadataItemId: true, metadataItemType: true, metadataName: true, startTime: true },
    })
    // AIOStreams' own apps may already have announced this same viewing.
    if (fresh?.metadataItemId && !require('./startNotifyDedupe').claimStart(accountId, user.id, fresh.metadataItemId)) return
    // The matched title's own name where there is one - see proxyTitle.js.
    const shownName = proxyDisplayTitle({ ...(fresh || {}), displayName }) || displayName
    // A user's own personal webhook (set in their self-service Settings)
    // takes over from the shared account webhook for their own activity —
    // lets each household member route their own pings to their own
    // channel/DM instead of (or as well as) the shared family one.
    const targetWebhookUrl = user.discordWebhookUrl || webhookUrl
    if (targetWebhookUrl) {
      await sendSessionStartNotification(targetWebhookUrl, {
        itemName: shownName,
        itemType: fresh?.metadataItemType === 'series' ? 'series' : 'movie',
        itemId: fresh?.metadataItemId || null,
        videoId: null,
        season: null,
        episode: null,
        startTime: fresh?.startTime || new Date(),
        poster: fresh?.posterUrl || null,
      }, user)
    }
    // Automation runs off the same start edge as the notification above,
    // but is deliberately NOT gated on notifyOnWatch/webhook configuration -
    // a rule whose action is "post to my dashboard" must still run on an
    // instance with no Discord webhook set. Same reasoning as
    // vault.check_failed's own emit.
    try {
      const { emitAutomationEvent } = require('./automation/engine')
      await emitAutomationEvent(prisma, accountId, 'watch.started', {
        username: user.username || '',
        userId: user.id,
        itemName: shownName,
        itemId: fresh?.metadataItemId || '',
        contentType: fresh?.metadataItemType === 'series' ? 'series' : 'movie',
      })
    } catch { /* emit never throws; guards the require itself */ }

    // Mirror to phone push (self-gates on the same notifyOnActivity toggle).
    const whoName = user.username || user.email || 'Someone'
    await notifyPushForType(prisma, accountId, 'notifyOnActivity', {
      title: `${whoName} started watching`,
      body: readableStreamTitle(shownName),
      icon: fresh?.posterUrl || '/android-chrome-192x192.png',
      url: '/activity',
    })
  } catch (error) {
    heartbeat('pollOnce:start_notify_error', { message: error.message, rowId })
  }
}

// A stream's own name can be an opaque file or cache id when its title isn't
// matched yet - say so in words instead of printing the id.
function readableStreamTitle(name) {
  const n = String(name || '').trim()
  if (!n || (/^[A-Za-z0-9_-]{20,}$/.test(n) && /\d/.test(n) && !/\s/.test(n))) return 'a title SlickSync couldn’t name yet'
  return n
}

// Deliberately no "finished watching" notification here. It existed once,
// but confirmed real case: for a title the proxy's own strict-match poster
// lookup fails on, its displayName is still the raw parsed filename (junk
// like a leading site tag - see parseDisplayName's fix for that separately),
// so this fired a second, uglier, poster-less notification for the SAME
// viewing session the native pipeline had already announced cleanly via its
// own "watched" notification (real title, real poster, resolved by ID not
// filename-guessing) once History caught up. Two notifications for one
// session, one of them worse, is worse than the proxy just staying silent
// on the stop side - same reasoning CLAUDE.md already documents for why
// native must not ALSO send the start-side notification, applied to the
// stop side instead. The session still closes (isActive: false) below;
// only the notification side-effect is gone.

// NOTE: the proxy writes NO watch history. History is owned entirely by the
// native provider pipeline, which records every source this deployment uses -
// including usenet (confirmed: a newznab usenet watch lands in History via
// native, with the real library title/poster/duration). A proxy-side usenet
// history writer briefly existed for a usenet backend that DID route through
// the proxy; with an indexer-API setup usenet never becomes a proxy connection
// at all, so that writer could never fire and was removed. The proxy remains a
// live presence signal only: Now Playing + the instant "started watching"
// notification.

// Client IPs to never record as watches. The SlickSync/AIOStreams server's
// own outbound requests through the proxy (poster/metadata lookups, and Nuvio
// stream paths that route via the server) appear in /proxy/stats under the
// SERVER's public IP, not a user's device - recording those creates phantom
// "watch" sessions that fire spurious started/finished notifications and show
// as a duplicate Now Playing card alongside the real native session (confirmed
// real case 2026-07-30: a 1-request, ~1-minute session under the VPS's own IP
// for a title a user was really watching from their home IP). Set
// AIOSTREAMS_IGNORE_IPS to the server's public IP(s), comma-separated. Nuvio
// Now Playing is unaffected - the native library pipeline covers it.
function getIgnoredIps() {
  return (process.env.AIOSTREAMS_IGNORE_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Fires push+bell exactly on the ok/failing transition, never on every poll
// (this runs every 30s - notifying every single failed poll would be a
// notification every 30s during any real outage). Mirrors addonHealthCheck's
// "went offline / came back" edge-trigger pattern.
async function notifyProxyHealthChange(prisma, accountId, isOk, errorMessage) {
  try {
    const { notifyPushForType } = require('./pushNotifications')
    await notifyPushForType(prisma, accountId, 'notifyOnProxyHealth', {
      title: isOk ? '✅ AIOStreams proxy reachable again' : '⚠️ AIOStreams proxy unreachable',
      body: isOk ? 'Now Playing polling has recovered.' : (errorMessage || 'Now Playing polling can\'t reach AIOStreams.'),
      icon: '/android-chrome-192x192.png',
      url: '/metrics?tab=health',
    })
  } catch {}
}

/**
 * Marks every live row no longer live - used when polling has failed for a
 * while. No end time is written: nothing was seen to end. A row with an end
 * time is one the proxy watched stop, and the Now Playing merge drops the
 * native entry for that title as a stale echo - which here would hide
 * someone who is still watching for as long as that window lasts.
 */
async function closeUnconfirmedRows(prisma, accountId) {
  try {
    const closed = await prisma.proxyStreamSession.updateMany({
      where: { accountId, isActive: true },
      data: { isActive: false, endTime: null },
    })
    if (closed?.count > 0) {
      heartbeat('closed_unconfirmed_rows', { count: closed.count })
      try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch {}
    }
  } catch (e) {
    heartbeat('close_unconfirmed_rows_failed', { message: e.message })
  }
}

async function pollOnce(prisma, accountId, config) {
  heartbeat('pollOnce:start', { accountId })
  const wasOk = lastPollStatus.ok
  try {
    await retryMissingPosters(prisma, accountId)
    const liveStreams = await fetchLiveStreams(config.baseUrl, config.username, config.password)
    const now = new Date()
    const ignoredIps = new Set(getIgnoredIps())
    // Track which (aiostreamsUser, clientIp, url) combos are active this poll
    const seenKeys = new Set()

    // Load "start watching" notification config once per poll. Only fetch
    // the user list (needed to attribute the notification) when it's on.
    // Gated on the notifyOnActivity toggle alone, NOT on a webhook being set,
    // so phone push can fire even for accounts that never configured Discord.
    let notifyActivity = false
    let notifyWebhook = null
    let notifyUsers = []
    try {
      const account = await prisma.appAccount.findFirst({ where: { id: accountId }, select: { sync: true } })
      let cfg = account?.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
      cfg = cfg || {}
      if (cfg.notifyOnActivity === true) {
        notifyActivity = true
        notifyWebhook = cfg.webhookUrl || null
        notifyUsers = await prisma.user.findMany({
          where: { accountId },
          select: { id: true, username: true, email: true, colorIndex: true, notifyOnWatch: true, discordWebhookUrl: true },
        })
      }
    } catch {}

    // One unified loop over both transports - the new endpoint tags each
    // row with real identity already, so proxy and usenet no longer need
    // separate fetches/loops the way the old two-endpoint setup did.
    for (const stream of liveStreams) {
      if (!stream.targetKey) {
        heartbeat('pollOnce:skipped_malformed_stream', { stream })
        continue
      }
      // Unattributed (empty username) falls back to the same synthetic
      // identity regardless of transport - see the constant's own comment.
      const aiostreamsUser = stream.username || UNATTRIBUTED_SYNTHETIC_USER
      const clientIp = stream.clientIp || UNATTRIBUTED_SYNTHETIC_IP
      const url = stream.targetKey

      // Skip the server's own proxied requests (see getIgnoredIps) - never a
      // real user watch, and recording it spawns phantom sessions +
      // notifications + duplicate Now Playing cards.
      if (ignoredIps.has(clientIp)) {
        heartbeat('pollOnce:skipped_ignored_ip', { clientIp })
        continue
      }

      const key = `${aiostreamsUser}:::${clientIp}:::${url}`
      seenKeys.add(key)

      const displayName = parseDisplayName(stream.filename)

      // Was this session already known before this poll, and had it already
      // shown it was playing? See proxyPlaying.js for why a new row on its
      // own is not yet a "started watching".
      const existingRow = await prisma.proxyStreamSession.findUnique({
        where: { accountId_aiostreamsUser_clientIp_url: { accountId, aiostreamsUser, clientIp, url } },
        select: { id: true, isActive: true, requestCount: true, startTime: true, lastSeenAt: true },
      })

      // Debrid resolvers frequently return a deterministic, content-
      // addressed identity for the same title+store rather than a
      // per-session token - replaying the same content days later can land
      // on the EXACT same (accountId, user, clientIp, url) unique key as a
      // much earlier, already-closed viewing. Without resetting startTime
      // here, that old value rode along forever on every future
      // reactivation of "the same" key (confirmed real case: a row's
      // startTime stayed frozen at its first-ever play from 2 days earlier,
      // producing a bogus "Watching for 57h+" display once
      // mergeProxyNowPlaying used it as the reported watch start). Only
      // reset when the row was NOT already active - an ordinary 30s poll of
      // a genuinely still-open session must keep its real startTime, only a
      // reactivation from a closed state is a new viewing occasion.
      const isReactivation = existingRow && existingRow.isActive === false
      const startedAt = new Date(stream.startedAt)

      const row = await prisma.proxyStreamSession.upsert({
        where: {
          accountId_aiostreamsUser_clientIp_url: { accountId, aiostreamsUser, clientIp, url },
        },
        create: {
          accountId,
          aiostreamsUser,
          clientIp,
          url,
          filename: stream.filename ?? null,
          displayName,
          requestCount: stream.requests ?? 1,
          startTime: startedAt,
          lastSeenAt: new Date(stream.lastSeenAt ?? stream.startedAt),
          isActive: true,
        },
        update: {
          requestCount: stream.requests ?? 1,
          lastSeenAt: new Date(stream.lastSeenAt ?? Date.now()),
          isActive: true,
          endTime: null,
          ...(isReactivation ? { startTime: startedAt } : {}),
        },
      })

      // Strict poster lookup once per stream (cached via metadataMatchedAt),
      // not on every 30s poll while it stays active.
      if (!row.metadataMatchedAt) {
        await attemptPosterLookup(prisma, row.id, displayName)
      }

      // "Started watching" the poll a connection first shows it is playing -
      // data kept flowing long enough (proxyPlaying.js) - whether that is the
      // poll that found it or a later one. Runs after the poster lookup so
      // the embed can include it. A reactivation of a closed row is the same
      // stream resumed and stays quiet, as before.
      const playingNow = isPlayingConnection(row)
      const wasPlaying = !!existingRow && existingRow.isActive && isPlayingConnection(existingRow)
      if (notifyActivity && playingNow && !wasPlaying && (!existingRow || existingRow.isActive)) {
        await maybeNotifyStart(prisma, accountId, notifyWebhook, notifyUsers, aiostreamsUser, row.id, displayName)
        // A brand-new live stream: tell connected dashboards to refetch Now
        // Playing immediately rather than on their next 30s tick.
        try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch {}
      }
    }

    // Anything previously active that AIOStreams no longer lists: mark ended
    // - but only after a short grace period, not on the very first miss.
    // A seek/rebuffer renegotiates the connection (new byte-range request,
    // sometimes a new url) and can legitimately drop out of one 30s poll's
    // response before reappearing in the next - dropping it from Now
    // Playing on a single missed poll made an actively-playing stream
    // flicker out and back in. GRACE_MS gives one full extra poll cycle
    // before treating a miss as a real stop.
    const GRACE_MS = CHECK_INTERVAL_MS * 2
    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: {
        id: true, aiostreamsUser: true, clientIp: true, url: true, lastSeenAt: true,
        displayName: true, posterUrl: true, metadataItemType: true, startTime: true,
      },
    })

    const toClose = staleActive.filter(
      (row) =>
        !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`) &&
        (now.getTime() - row.lastSeenAt.getTime()) > GRACE_MS
    )
    if (toClose.length > 0) {
      // Mark the connection ended - no history is written here (see the note
      // above pollOnce). Closing the row is what lets the Now Playing merge
      // know this stream really stopped, so it can drop the native
      // pipeline's stale "still watching" echo of it.
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })
      // Streams ended: Now Playing rows should drop without waiting out the
      // dashboard's poll interval.
      try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch {}
      // No "finished watching" notification here - see the comment where
      // maybeNotifyStop used to be defined for why. The native pipeline's
      // own "watched" notification (real title, real poster) already covers
      // this same viewing session once History catches up.
    }

    heartbeat('pollOnce:done', {
      activeSeen: seenKeys.size,
      closed: toClose.length,
    })
    lastPollStatus = { ok: true, at: now, error: null }
    if (consecutiveFailures > 0) {
      console.log(`[ProxyStreamMonitor] Polling AIOStreams works again after ${consecutiveFailures} failed poll(s)`)
    }
    lastOkAt = now.getTime()
    consecutiveFailures = 0
    failingSince = null
    closedRowsThisOutage = false
    if (wasOk === false) await notifyProxyHealthChange(prisma, accountId, true, null)
  } catch (error) {
    heartbeat('pollOnce:error', { message: error.message, stack: error.stack })
    consecutiveFailures += 1
    if (!failingSince) failingSince = new Date()
    // Said once when it starts and then every ten minutes - not every 30
    // seconds, which buried it.
    if (consecutiveFailures === 1 || consecutiveFailures % 20 === 0) {
      console.warn(`[ProxyStreamMonitor] Polling AIOStreams is failing (${consecutiveFailures} in a row since ${failingSince.toISOString()}): ${error.message}`)
    }
    lastPollStatus = { ok: false, at: new Date(), error: error.message }
    // Not for a rate limit: AIOStreams is up and only asked for a slower pace.
    if (wasOk !== false && !error?.rateLimited) await notifyProxyHealthChange(prisma, accountId, false, error.message)
    // Nothing has confirmed the live rows for about three minutes: close
    // them, once per outage. A stream that is really still playing comes
    // back as a quiet reactivation on the first poll that works. Not while
    // AIOStreams is only asking us to slow down - that is not an outage.
    if (consecutiveFailures >= FAILURES_BEFORE_CLOSE && !closedRowsThisOutage && !error?.rateLimited) {
      closedRowsThisOutage = true
      await closeUnconfirmedRows(prisma, accountId)
    }
    // Everything else stays swallowed - a failed poll should not take the
    // scheduler down - but a rate limit has to reach the caller, which is
    // what decides how long to back off. Swallowing it here would leave the
    // poller retrying into the limiter every 30s forever.
    if (error?.rateLimited) throw error
  }
}

function scheduleProxyStreamMonitor(prisma, accountId, config) {
  heartbeat('scheduleProxyStreamMonitor:init', { accountId, baseUrl: config.baseUrl })
  clearProxyStreamMonitor()

  if (!config.baseUrl || !config.username || !config.password) {
    console.warn('[ProxyStreamMonitor] Missing AIOStreams config - not starting poller')
    // No poller means nothing will ever close a row left live by an earlier
    // setup, so it would show as playing for good.
    closeUnconfirmedRows(prisma, accountId).catch(() => {})
    return
  }
  monitoredAccountId = accountId

  const guardedPoll = async () => {
    // Still working on the previous tick - skip entirely rather than
    // stacking. The next tick picks it up 30s later.
    if (isPolling) {
      heartbeat('poll_skipped_still_running')
      return
    }
    // Backing off after a rate limit.
    if (Date.now() < rateLimitedUntil) {
      heartbeat('poll_skipped_rate_limited', { msRemaining: rateLimitedUntil - Date.now() })
      return
    }
    isPolling = true
    try {
      await pollOnce(prisma, accountId, config)
      noteRateLimitCleared()
    } catch (e) {
      if (e?.rateLimited) noteRateLimited(e.retryAfterSeconds)
      else console.error('[ProxyStreamMonitor] Poll failed:', e?.message)
    } finally {
      isPolling = false
    }
  }

  guardedPoll()
  pollTimer = setInterval(guardedPoll, CHECK_INTERVAL_MS)
}

module.exports = {
  scheduleProxyStreamMonitor,
  clearProxyStreamMonitor,
  parseDisplayName,
  resolveUserForActiveConnection,
  getProxyMonitorStatus,
  isProxyMonitorConfirming,
  CHECK_INTERVAL_MS,
  // For tests: the fetch against AIOStreams, one poll, and the module state.
  _test: {
    fetchLiveStreams,
    pollOnce,
    attemptPosterLookup,
    reset() {
      cachedCookie = null
      loginBlockedUntil = 0
      consecutiveLoginFailures = 0
      consecutiveFreshRejections = 0
      lastOkAt = 0
      consecutiveFailures = 0
      failingSince = null
      closedRowsThisOutage = false
      rateLimitedUntil = 0
      monitoredAccountId = null
      lastPollStatus = { ok: null, at: null, error: null }
    },
    setMonitored(accountId) { monitoredAccountId = accountId },
    setLastOk(ms) { lastOkAt = ms },
    setRateLimitedUntil(ms) { rateLimitedUntil = ms },
  },
}
