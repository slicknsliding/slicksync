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

const { lookupAiometadataPoster } = require('./aiometadataLookup')

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
  const yearMatch = withoutExt.match(/^(.*?)[.\s](\d{4})[.\s]/)

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

    const durationSeconds = Math.max(0, Math.round((endTime.getTime() - earliestStartTime.getTime()) / 1000))
    // Skip near-instant blips (e.g. a preview/probe request) rather than
    // logging a 0-second "watch" in history.
    if (durationSeconds < 10) continue

    const itemId = representative.metadataItemId || `proxy:${normalizeTitleForHistory(title).replace(/\s+/g, '-')}`
    const itemType = representative.metadataItemType === 'series' ? 'series' : 'movie'

    // Look up any existing entry for this exact item first, so a
    // stop-then-resume of the same content accumulates duration across
    // segments instead of the later segment silently overwriting (and
    // discarding credit for) the earlier one.
    const existingForItem = await prisma.watchSession.findUnique({
      where: { accountId_userId_itemId: { accountId, userId: user.id, itemId } },
    })
    const accumulatedDuration = (existingForItem?.durationSeconds || 0) + durationSeconds
    const overallStartTime = existingForItem?.startTime && existingForItem.startTime < earliestStartTime
      ? existingForItem.startTime
      : earliestStartTime

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
        durationSeconds: accumulatedDuration,
        isActive: false,
      },
      update: {
        startTime: overallStartTime,
        endTime,
        durationSeconds: accumulatedDuration,
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

/**
 * Attempts an AIOMetadata poster lookup for one row and records the
 * result (or the fact that none was found) via metadataMatchedAt, so it's
 * never retried indefinitely. Used both at connection-creation time and by
 * the retry pass below for rows that missed that first attempt.
 */
async function attemptPosterLookup(prisma, accountId, rowId, displayName) {
  try {
    const account = await prisma.appAccount.findUnique({
      where: { id: accountId },
      select: { aiometadataManifestUrl: true },
    })
    const manifestUrl = account?.aiometadataManifestUrl
    if (!manifestUrl || !displayName) return

    const yearMatch = displayName.match(/\((\d{4})\)$/)
    const year = yearMatch ? yearMatch[1] : null
    let title = year ? displayName.replace(/\s*\(\d{4}\)$/, '') : displayName

    // For series episodes without a year in the display name, the episode
    // title/quality tags before a SxxExx marker were surviving the earlier
    // cleanup and getting sent as part of the search query (e.g. "Spider-
    // Noir S01E01 Step Into My Office True-Hue Full Color" instead of just
    // "Spider-Noir") - not a searchable title, causing genuine no-match
    // results for shows that should have been findable. Strip from the
    // SxxExx marker onward for the search query specifically; the full
    // descriptive name is still what gets displayed/stored elsewhere.
    const seasonEpisodeMatch = title.match(/^(.*?)\s+S\d{1,2}E\d{1,3}\b/i)
    if (seasonEpisodeMatch) {
      title = seasonEpisodeMatch[1].trim()
    } else {
      // Bare episode marker without an attached season marker (e.g.
      // "Chernobyl E01" rather than "Chernobyl S01E01")
      const bareEpisodeMatch = title.match(/^(.*?)\s+E\d{1,3}\b/i)
      if (bareEpisodeMatch) {
        title = bareEpisodeMatch[1].trim()
      }
    }

    const result = await lookupAiometadataPoster(manifestUrl, title, year)
    const updatedRow = await prisma.proxyStreamSession.update({
      where: { id: rowId },
      data: {
        posterUrl: result?.posterUrl ?? null,
        metadataItemId: result?.id ?? null,
        metadataItemType: result?.type ?? null,
        metadataMatchedAt: new Date(),
      },
    })

    // Backfill into the linked history entry too, if this stream had
    // already ended and its completed WatchSession row was written before
    // this lookup finished (a real race - closing can happen faster than
    // the AIOMetadata request completes). Only fills in a still-missing
    // poster - never overwrites one that's already set.
    if (result?.posterUrl && updatedRow.linkedWatchSessionId) {
      await prisma.watchSession.updateMany({
        where: { id: updatedRow.linkedWatchSessionId, poster: null },
        data: { poster: result.posterUrl },
      })
    }
  } catch (error) {
    heartbeat('pollOnce:poster_lookup_error', { message: error.message, rowId })
  }
}

/**
 * Safety net: finds rows (active or not) that never got a poster lookup
 * attempt at all - confirmed with real data that this can happen (e.g. a
 * connection ending mid-lookup before the one-shot attempt in the main
 * loop finished). Capped to a handful per cycle so a large backlog doesn't
 * hammer AIOMetadata all at once.
 */
async function retryMissingPosters(prisma, accountId) {
  const stuck = await prisma.proxyStreamSession.findMany({
    where: { accountId, metadataMatchedAt: null },
    select: { id: true, displayName: true },
    take: 5,
    orderBy: { createdAt: 'asc' },
  })

  for (const row of stuck) {
    await attemptPosterLookup(prisma, accountId, row.id, row.displayName)
  }

  if (stuck.length > 0) {
    heartbeat('retryMissingPosters:done', { attempted: stuck.length })
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

        // Poster lookup runs once per stream (cached via metadataMatchedAt),
        // not on every 30s poll while the same stream is still active. A
        // retry pass elsewhere in this file catches any row that missed
        // this attempt entirely (e.g. the connection ended mid-lookup).
        if (!row.metadataMatchedAt) {
          await attemptPosterLookup(prisma, accountId, row.id, displayName)
        }
      }
    }

    // Anything previously active that AIOStreams no longer lists: mark ended.
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
      },
    })

    const toClose = staleActive.filter(
      (row) => !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`)
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
  CHECK_INTERVAL_MS,
}
