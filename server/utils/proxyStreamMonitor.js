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


// Same loose title comparison used for Now Playing disambiguation - good
// enough to tell "Powder" apart from something unrelated, not exact.
function normalizeTitleForHistory(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Resolves which SlickSync user a closed AIOStreams connection belongs to.
 * Same tiers as the Now Playing merge (proxyNowPlaying.js): username ->
 * email local-part -> fallback ID list - but since there's no live
 * WatchSession entry to disambiguate against at this point (the whole
 * point of this function is to WRITE that history, not read it), ties
 * within the fallback list are broken by whichever candidate already has
 * an existing history row (WatchSession, EpisodeWatchHistory, or
 * MovieWatchHistory) for this exact title, falling back to the first
 * configured ID if none do.
 */
async function resolveUserForClosedConnection(prisma, accountId, aiostreamsUser, title) {
  const users = await prisma.user.findMany({
    where: { accountId },
    select: { id: true, username: true, email: true },
  })

  const lower = (aiostreamsUser || '').toLowerCase()
  const directMatch = users.find((u) => u.username && u.username.toLowerCase() === lower)
  if (directMatch) return directMatch

  const emailMatches = users.filter(
    (u) => u.email && u.email.split('@')[0].toLowerCase() === lower
  )
  if (emailMatches.length === 1) return emailMatches[0]

  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const candidates = emailMatches.length > 0
    ? emailMatches
    : fallbackUserIds.map((id) => users.find((u) => u.id === id)).filter(Boolean)

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const normalizedTitle = normalizeTitleForHistory(title)
  if (normalizedTitle) {
    for (const candidate of candidates) {
      const [existingSession, existingEpisode, existingMovie] = await Promise.all([
        prisma.watchSession.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { updatedAt: 'desc' },
          select: { itemName: true },
        }),
        prisma.episodeWatchHistory.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { watchedAt: 'desc' },
          select: { showName: true },
        }),
        prisma.movieWatchHistory.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { watchedAt: 'desc' },
          select: { itemName: true },
        }),
      ])
      const names = [existingSession?.itemName, existingEpisode?.showName, existingMovie?.itemName]
      if (names.some((n) => n && normalizeTitleForHistory(n) === normalizedTitle)) {
        return candidate
      }
    }
  }

  // No title-match signal available. Use the fallback list's order as the
  // tiebreaker (same fix already applied to the live Now Playing merge in
  // proxyNowPlaying.js) rather than candidates[0] in arbitrary database
  // row order - confirmed via a real duplicate/misattributed history entry
  // that this path was still hitting the same bug independently.
  if (fallbackUserIds.length > 0) {
    const byFallbackOrder = candidates
      .map((u) => ({ u, rank: fallbackUserIds.indexOf(u.id) }))
      .filter((c) => c.rank !== -1)
      .sort((a, b) => a.rank - b.rank)
    if (byFallbackOrder.length > 0) return byFallbackOrder[0].u
  }

  return candidates[0]
}

/**
 * Groups just-closed proxy connections by title (same reasoning as the Now
 * Playing merge: a seek can leave two connection rows for one real viewing
 * session) and writes one completed WatchSession row per group, so it shows
 * up in the Today/Yesterday history timeline the same way any other
 * completed session does.
 */
async function writeCompletedWatchSessions(prisma, accountId, closedRows, endTime) {
  const groups = new Map()
  for (const row of closedRows) {
    const key = normalizeTitleForHistory(row.displayName) || row.url
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  for (const group of groups.values()) {
    const representative = group.reduce((latest, r) =>
      (!latest || r.startTime > latest.startTime) ? r : latest
    , null)
    const earliestStartTime = group.reduce((earliest, r) =>
      r.startTime < earliest ? r.startTime : earliest
    , representative.startTime)

    const title = representative.displayName || representative.filename || 'Unknown'
    const user = await resolveUserForClosedConnection(prisma, accountId, representative.aiostreamsUser, title)
    if (!user) {
      heartbeat('writeCompletedWatchSessions:no_user_match', { aiostreamsUser: representative.aiostreamsUser, title })
      continue
    }

    // The wall-clock lifetime of the AIOStreams proxy connection is NOT a
    // valid measure of watch time and must never be stored as one. A proxy
    // connection can linger "active" for hours after playback actually
    // stopped (AIOStreams keeps stale connections up to 6h - see the poll
    // loop's stale-close logic), and HTTP range/keep-alive behaviour means
    // connection lifetime never tracked real playback anyway. Storing it
    // produced absurd durations (a 5-minute view showing as 22h) that then
    // accumulated across replays and inflated "Watch Time Today" into the
    // tens of hours. Real watch duration comes exclusively from the native
    // provider pipeline (metricsProcessor.js, via overallTimeWatched
    // deltas) - the proxy is a PRESENCE signal only (Now Playing liveness
    // + a history marker that something was streamed), never a duration
    // source.
    //
    // We still compute the lifetime purely to skip near-instant probe
    // blips, but it is never stored.
    const connectionLifetimeSeconds = Math.max(0, Math.round((endTime.getTime() - earliestStartTime.getTime()) / 1000))
    if (connectionLifetimeSeconds < 10) continue

    const itemId = representative.metadataItemId || `proxy:${normalizeTitleForHistory(title).replace(/\s+/g, '-')}`
    const itemType = representative.metadataItemType === 'series' ? 'series' : 'movie'

    // Deliberately does NOT write WatchActivity. WatchActivity feeds
    // "Watch Time Today" and must only contain real, provider-measured
    // watch time from the native pipeline - never proxy connection
    // lifetime.

    // Write a history marker WatchSession with NO duration (durationSeconds
    // stays 0 - the client hides the duration badge for proxy entries,
    // which are identified by requestCount). Never accumulate: this is a
    // presence record, not a running total. If the native pipeline also
    // tracked this same item it will carry the real duration separately;
    // the read-time cross-pipeline merge (metricsBuilder.js) uses max(),
    // so a native duration always wins over this 0.
    const existingForItem = await prisma.watchSession.findUnique({
      where: { accountId_userId_itemId: { accountId, userId: user.id, itemId } },
    })
    const overallStartTime = existingForItem?.startTime && existingForItem.startTime < earliestStartTime
      ? existingForItem.startTime
      : earliestStartTime
    const groupRequestCount = group.reduce((sum, r) => sum + (r.requestCount || 0), 0)

    const watchSessionRow = await prisma.watchSession.upsert({
      where: {
        accountId_userId_itemId: { accountId, userId: user.id, itemId },
      },
      create: {
        accountId,
        userId: user.id,
        itemId,
        itemName: title,
        itemType,
        poster: representative.posterUrl || null,
        startTime: overallStartTime,
        endTime,
        durationSeconds: 0,
        requestCount: groupRequestCount,
        isActive: false,
      },
      update: {
        // Only fill fields that make sense for a presence marker. Crucially
        // do NOT touch durationSeconds here - if the native pipeline wrote a
        // real duration onto this same row, the proxy must not clobber it.
        endTime,
        requestCount: groupRequestCount,
        isActive: false,
        poster: representative.posterUrl || undefined,
      },
    })

    // Link every ProxyStreamSession row in this group to the WatchSession
    // row just written, so a poster found later (e.g. by the retry pass,
    // if the lookup was still in flight when this stream closed) can be
    // backfilled into the history entry too - not just left stuck on this
    // now-inactive tracking row.
    await prisma.proxyStreamSession.updateMany({
      where: { id: { in: group.map((r) => r.id) } },
      data: { linkedWatchSessionId: watchSessionRow.id },
    })
  }
}

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

async function pollOnce(prisma, accountId, config) {
  heartbeat('pollOnce:start', { accountId })
  try {
    await retryMissingPosters(prisma, accountId)
    const stats = await fetchProxyStats(config.baseUrl, config.username, config.password)
    const now = new Date()
    // Track which (aiostreamsUser, clientIp, url) combos are active this poll
    const seenKeys = new Set()

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
      }
    }

    // Anything previously active that AIOStreams no longer lists: mark ended
    // - but only after a short grace period, not on the very first miss.
    // A seek/rebuffer renegotiates the connection (new byte-range request,
    // sometimes a new url) and can legitimately drop out of one 30s poll's
    // response before reappearing in the next - closing (and writing
    // completed history for) a connection that's actually still ongoing
    // produced exactly that: a still-actively-playing stream already
    // showing up in History with a "final" duration while a fresh
    // connection for the same content kept it live in Now Playing at the
    // same time. GRACE_MS gives one full extra poll cycle before treating
    // a miss as a real stop.
    const GRACE_MS = CHECK_INTERVAL_MS * 2
    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: {
        id: true,
        aiostreamsUser: true,
        clientIp: true,
        url: true,
        displayName: true,
        filename: true,
        posterUrl: true,
        metadataItemId: true,
        metadataItemType: true,
        startTime: true,
        lastSeenAt: true,
        requestCount: true,
      },
    })

    const toClose = staleActive.filter(
      (row) =>
        !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`) &&
        (now.getTime() - row.lastSeenAt.getTime()) > GRACE_MS
    )
    if (toClose.length > 0) {
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })

      try {
        await writeCompletedWatchSessions(prisma, accountId, toClose, now)
      } catch (error) {
        heartbeat('pollOnce:history_write_error', { message: error.message, stack: error.stack })
      }
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
  writeCompletedWatchSessions,
  CHECK_INTERVAL_MS,
}
