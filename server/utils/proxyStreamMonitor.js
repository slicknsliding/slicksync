// Proxy stream monitor - polls AIOStreams' built-in proxy stats endpoint and
// mirrors active/ended connections into ProxyStreamSession rows, giving
// SlickSync a "Now Playing" signal for Stremio/Nuvio users that AIOStreams
// itself can see (this proxy sits in the middle of every stream request),
// independent of the Nuvio-sourced WatchSession pipeline.
//
// AIOStreams' /api/v1/proxy/stats route is gated by requireAdmin (dashboard
// session cookie auth) - there is no separate API key mechanism in this
// version of AIOStreams. So this module logs in with AIOSTREAMS_AUTH
// credentials the same way the browser dashboard does, caches the resulting
// session cookie, and re-logs-in on a 401.
//
// Connection identity: AIOStreams' BuiltinProxyStats keys each connection by
// (ip, url), not by a single requestId - concurrent requests (e.g. range
// requests for the same file) merge into one entry with a `count` and a
// growing/shrinking `requestIds[]` array. This module mirrors that: identity
// here is (accountId, aiostreamsUser, clientIp, url).

const { searchCinemetaPosterByTitle } = require('./libraryHelpers')
const { sendSessionStartNotification } = require('./sessionTracker')
const { notifyPushForType } = require('./pushNotifications')

const CHECK_INTERVAL_MS = 30 * 1000 // 30s - streams start/stop faster than the 1min library-sync interval

let pollTimer = null
let cachedCookie = null

function heartbeat(event, data = {}) {
  try {
    const fs = require('fs')
    const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}\n`
    fs.appendFileSync('/app/data/proxy-stream-monitor-debug.log', line)
  } catch {}
}

function clearProxyStreamMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  cachedCookie = null
}

function parseDisplayName(filename) {
  if (!filename) return null

  const withoutExt = filename.replace(/\.[a-zA-Z0-9]{2,4}$/, '')
  // Year may or may not be parenthesized in the release name (e.g. both
  // "Send.Help.2026.WEB-DL" and "Send.Help.(2026).VU.Blu-ray" occur) -
  // accept an optional paren on either side so both forms match, and so
  // everything after the year (quality/release tags) gets dropped below
  // regardless of what they contain.
  const yearMatch = withoutExt.match(/^(.*?)[.\s]\(?(\d{4})\)?(?:[.\s]|$)/)

  if (yearMatch) {
    let title = yearMatch[1].replace(/\./g, ' ').trim()
    // Strip numeric-junk parenthetical groups (e.g. a literal "(1.23.45)"
    // timestamp/version marker from the release name) that survive the
    // dot-to-space cleanup untouched, since only dots get replaced there -
    // not the parentheses. This kind of content is never real title text.
    title = title.replace(/\(\s*[\d\s:.-]+\s*\)/g, '').replace(/\s+/g, ' ').trim()
    const year = yearMatch[2]
    return `${title} (${year})`
  }

  const cleaned = withoutExt
    .replace(/[._]/g, ' ')
    .replace(/\b(1080p|2160p|720p|480p|4K|HDR|WEB-?DL|WEBRip|BluRay|BRRip|HDTV|x264|x265|H\s?264|H\s?265|DD5\s?1|DDP5\s?1|AAC|AC3|REMUX)\b.*$/i, '')
    .trim()

  return cleaned || withoutExt.replace(/[._]/g, ' ').trim()
}

async function loginToAiostreams(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (!res.ok) {
    throw new Error(`AIOStreams login failed: ${res.status} ${res.statusText}`)
  }

  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) {
    throw new Error('AIOStreams login succeeded but no Set-Cookie header returned')
  }

  return setCookie.split(';')[0]
}

async function fetchProxyStats(baseUrl, username, password) {
  if (!cachedCookie) {
    cachedCookie = await loginToAiostreams(baseUrl, username, password)
    heartbeat('fetchProxyStats:logged_in')
  }

  let res = await fetch(`${baseUrl}/api/v1/proxy/stats`, {
    headers: { Cookie: cachedCookie },
  })

  if (res.status === 401) {
    heartbeat('fetchProxyStats:session_expired_relogging_in')
    cachedCookie = await loginToAiostreams(baseUrl, username, password)
    res = await fetch(`${baseUrl}/api/v1/proxy/stats`, {
      headers: { Cookie: cachedCookie },
    })
  }

  if (!res.ok) {
    throw new Error(`AIOStreams /proxy/stats failed: ${res.status} ${res.statusText}`)
  }

  return res.json()
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
    const result = await searchCinemetaPosterByTitle(parsed.searchTitle, parsed.year, parsed.type)
    const updatedRow = await prisma.proxyStreamSession.update({
      where: { id: rowId },
      data: {
        posterUrl: result?.poster ?? null,
        metadataItemId: result?.id ?? null,
        metadataItemType: result?.type ?? null,
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
  const stuck = await prisma.proxyStreamSession.findMany({
    where: { accountId, metadataMatchedAt: null },
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
// order). Returns null if nothing matches.
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
  if (candidates.length > 1 && fallbackUserIds.length > 0) {
    const byRank = candidates
      .map((u) => ({ u, rank: fallbackUserIds.indexOf(u.id) }))
      .filter((c) => c.rank !== -1)
      .sort((a, b) => a.rank - b.rank)
    if (byRank.length) return byRank[0].u
  }
  return candidates[0]
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

    const fresh = await prisma.proxyStreamSession.findUnique({
      where: { id: rowId },
      select: { posterUrl: true, metadataItemId: true, metadataItemType: true, startTime: true },
    })
    if (webhookUrl) {
      await sendSessionStartNotification(webhookUrl, {
        itemName: displayName,
        itemType: fresh?.metadataItemType === 'series' ? 'series' : 'movie',
        itemId: fresh?.metadataItemId || null,
        videoId: null,
        season: null,
        episode: null,
        startTime: fresh?.startTime || new Date(),
        poster: fresh?.posterUrl || null,
      }, user)
    }
    // Mirror to phone push (self-gates on the same notifyOnActivity toggle).
    const whoName = user.username || user.email || 'Someone'
    await notifyPushForType(prisma, accountId, 'notifyOnActivity', {
      title: `${whoName} started watching`,
      body: displayName,
      icon: fresh?.posterUrl || '/android-chrome-192x192.png',
      url: '/activity',
    })
  } catch (error) {
    heartbeat('pollOnce:start_notify_error', { message: error.message, rowId })
  }
}

// NOTE: the proxy writes NO watch history. History is owned entirely by the
// native provider pipeline, which records every source this deployment uses -
// including usenet (confirmed: a newznab usenet watch lands in History via
// native, with the real library title/poster/duration). A proxy-side usenet
// history writer briefly existed for a usenet backend that DID route through
// the proxy; with an indexer-API setup usenet never becomes a proxy connection
// at all, so that writer could never fire and was removed. The proxy remains a
// live presence signal only: Now Playing + the instant "started watching"
// notification.

async function pollOnce(prisma, accountId, config) {
  heartbeat('pollOnce:start', { accountId })
  try {
    await retryMissingPosters(prisma, accountId)
    const stats = await fetchProxyStats(config.baseUrl, config.username, config.password)
    const now = new Date()
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
          select: { id: true, username: true, email: true, colorIndex: true },
        })
      }
    } catch {}

    for (const user of stats.users ?? []) {
      for (const conn of user.active ?? []) {
        // Real shape from BuiltinProxyStats: { ip, url, filename, timestamp,
        // lastSeen, count, requestIds }. No clientIp/requestId fields exist.
        const clientIp = conn.ip
        const url = conn.url
        if (!clientIp || !url) {
          heartbeat('pollOnce:skipped_malformed_connection', { user: user.username, conn })
          continue
        }

        const key = `${user.username}:::${clientIp}:::${url}`
        seenKeys.add(key)

        const displayName = parseDisplayName(conn.filename)

        // Was this connection already known before this poll? A brand-new
        // row means playback just started - the trigger for an instant
        // "started watching" notification below.
        const existingRow = await prisma.proxyStreamSession.findUnique({
          where: { accountId_aiostreamsUser_clientIp_url: { accountId, aiostreamsUser: user.username, clientIp, url } },
          select: { id: true },
        })

        const row = await prisma.proxyStreamSession.upsert({
          where: {
            accountId_aiostreamsUser_clientIp_url: {
              accountId,
              aiostreamsUser: user.username,
              clientIp,
              url,
            },
          },
          create: {
            accountId,
            aiostreamsUser: user.username,
            clientIp,
            url,
            filename: conn.filename ?? null,
            displayName,
            requestCount: conn.count ?? 1,
            startTime: new Date(conn.timestamp),
            lastSeenAt: new Date(conn.lastSeen ?? conn.timestamp),
            isActive: true,
          },
          update: {
            requestCount: conn.count ?? 1,
            lastSeenAt: new Date(conn.lastSeen ?? Date.now()),
            isActive: true,
            endTime: null,
          },
        })

        // Strict poster lookup once per stream (cached via
        // metadataMatchedAt), not on every 30s poll while it stays active.
        if (!row.metadataMatchedAt) {
          await attemptPosterLookup(prisma, row.id, displayName)
        }

        // Instant "started watching" notification for a genuinely new watch
        // (runs after the poster lookup so the embed can include it).
        if (notifyActivity && !existingRow) {
          await maybeNotifyStart(prisma, accountId, notifyWebhook, notifyUsers, user.username, row.id, displayName)
        }
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
      select: { id: true, aiostreamsUser: true, clientIp: true, url: true, lastSeenAt: true },
    })

    const toClose = staleActive.filter(
      (row) =>
        !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`) &&
        (now.getTime() - row.lastSeenAt.getTime()) > GRACE_MS
    )
    if (toClose.length > 0) {
      // Just mark the connection ended - no history is written here (see the
      // note above pollOnce). Closing the row is what lets the Now Playing
      // merge know this stream really stopped, so it can drop the native
      // pipeline's stale "still watching" echo of it.
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })
    }

    heartbeat('pollOnce:done', {
      activeSeen: seenKeys.size,
      closed: toClose.length,
    })
  } catch (error) {
    heartbeat('pollOnce:error', { message: error.message, stack: error.stack })
    console.warn('[ProxyStreamMonitor] pollOnce failed:', error.message)
  }
}

function scheduleProxyStreamMonitor(prisma, accountId, config) {
  heartbeat('scheduleProxyStreamMonitor:init', { accountId, baseUrl: config.baseUrl })
  clearProxyStreamMonitor()

  if (!config.baseUrl || !config.username || !config.password) {
    console.warn('[ProxyStreamMonitor] Missing AIOStreams config - not starting poller')
    return
  }

  pollOnce(prisma, accountId, config)
  pollTimer = setInterval(() => {
    pollOnce(prisma, accountId, config)
  }, CHECK_INTERVAL_MS)
}

module.exports = {
  scheduleProxyStreamMonitor,
  clearProxyStreamMonitor,
  parseDisplayName,
  resolveUserForActiveConnection,
  CHECK_INTERVAL_MS,
}
