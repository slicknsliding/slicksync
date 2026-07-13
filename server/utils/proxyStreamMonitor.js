// Proxy stream monitor - polls AIOStreams' built-in proxy stats endpoint and
// mirrors active/ended connections into ProxyStreamSession rows, giving
// SlickSync a "Now Playing" signal for Stremio users that AIOStreams itself
// can see (this proxy sits in the middle of every stream request, regardless
// of provider), independent of the Nuvio-sourced WatchSession pipeline.
//
// AIOStreams' /api/v1/proxy/stats route is gated by requireAdmin (dashboard
// session cookie auth) - there is no separate API key mechanism in this
// version of AIOStreams. So this module logs in with AIOSTREAMS_AUTH
// credentials the same way the browser dashboard does, caches the resulting
// session cookie, and re-logs-in on a 401.

const CHECK_INTERVAL_MS = 30 * 1000 // 30s - streams start/stop faster than the 1min library-sync interval

let pollTimer = null
let cachedCookie = null

// Direct file-based heartbeat, same pattern as activityMonitor.js - console
// output from this backend has not reliably reached `docker logs` in steady
// state, so this gives an independent way to check the scheduler is actually
// running.
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

/**
 * Best-effort cleanup of a release-style filename into a display title.
 * "Powder.1995.1080p.AMZN.WEB-DL.DD5.1.H.264-SiGMA" -> "Powder (1995)"
 * Not a full parser - just strips the common tags/dots so the raw scene
 * filename isn't shown verbatim in the UI. Falls back to the raw filename
 * (dots->spaces) if no year is found.
 */
function parseDisplayName(filename) {
  if (!filename) return null

  const withoutExt = filename.replace(/\.[a-zA-Z0-9]{2,4}$/, '')
  const yearMatch = withoutExt.match(/^(.*?)[.\s](\d{4})[.\s]/)

  if (yearMatch) {
    const title = yearMatch[1].replace(/\./g, ' ').trim()
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

async function pollOnce(prisma, accountId, config) {
  heartbeat('pollOnce:start', { accountId })
  try {
    const stats = await fetchProxyStats(config.baseUrl, config.username, config.password)
    const now = new Date()
    const seenRequestIds = new Set()

    for (const user of stats.users ?? []) {
      for (const conn of user.active ?? []) {
        seenRequestIds.add(conn.requestId)

        const displayName = parseDisplayName(conn.filename)

        await prisma.proxyStreamSession.upsert({
          where: {
            accountId_requestId: { accountId, requestId: conn.requestId },
          },
          create: {
            accountId,
            aiostreamsUser: user.username,
            clientIp: conn.clientIp,
            requestId: conn.requestId,
            url: conn.url,
            filename: conn.filename ?? null,
            displayName,
            startTime: new Date(conn.timestamp),
            isActive: true,
          },
          update: {
            isActive: true,
            endTime: null,
          },
        })
      }
    }

    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: { id: true, requestId: true },
    })

    const toClose = staleActive.filter((row) => !seenRequestIds.has(row.requestId))
    if (toClose.length > 0) {
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })
    }

    heartbeat('pollOnce:done', {
      activeSeen: seenRequestIds.size,
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
