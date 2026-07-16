#!/usr/bin/env python3
"""
Fixes ProxyStreamSession schema + proxyStreamMonitor.js to match AIOStreams'
real connection object shape, discovered from builtin.js:

  { ip, url, filename, timestamp, lastSeen, count, requestIds: [] }

Previous version wrongly assumed a `clientIp` field and a single `requestId`
- AIOStreams actually keys connections by `ip:url` and tracks `requestIds` as
an array (multiple concurrent requests, e.g. range requests, merge into one
entry). This script corrects the unique identity to (accountId,
aiostreamsUser, ip, url), which is the real stable key.

Run ON THE VPS, from inside the repo directory:

    cd /opt/docker/build/slicksync
    python3 fix_proxy_stream_fields.py

Then generate a patch and move it to Windows as usual (this script does NOT
commit/push/tag anything itself - VPS never pushes, per your workflow).
"""
import re
import sys
from pathlib import Path

REPO = Path.cwd()

def fail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

if not (REPO / "server" / "index.js").exists():
    fail("server/index.js not found - run this from the slicksync repo root")

# --- 1. Replace the ProxyStreamSession model in both schema files ---
OLD_MODEL_RE = re.compile(
    r"// Metrics: Proxy stream sessions.*?@@map\(\"proxy_stream_sessions\"\)\n\}\n",
    re.DOTALL,
)

NEW_MODEL = '''// Metrics: Proxy stream sessions - "Now Playing" data sourced from AIOStreams'
// built-in proxy (which sees every stream request passing through it in real
// time, regardless of provider - Stremio, Nuvio, anything using the proxy).
// Deliberately NOT merged into WatchSession: WatchSession was built for a
// different, live-detection purpose and is currently unreliably populated for
// both providers (see MovieWatchHistory comment above). This table is fully
// independent so the AIOStreams integration doesn't inherit that bug, and so
// it keeps working regardless of whether/how the WatchSession issue is fixed.
//
// Identity key matches AIOStreams' own BuiltinProxyStats: it keys connections
// by (ip, url), not by a single requestId - concurrent requests (e.g. range
// requests for the same file) merge into one entry with a growing/shrinking
// requestIds[] array and a count. So (accountId, aiostreamsUser, clientIp,
// url) is the real stable identity here, not requestId.
model ProxyStreamSession {
  id              String    @id @default(cuid())
  accountId       String    @default("default")
  aiostreamsUser  String    // Username as reported by AIOStreams proxy stats (may not map 1:1 to a SlickSync User)
  clientIp        String    // AIOStreams' `ip` field - client IP that opened this connection
  url             String    // Full upstream URL being proxied (may contain the raw source link) - part of AIOStreams' own identity key alongside ip
  filename        String?   // Raw filename AIOStreams reported, e.g. "Powder.1995.1080p.AMZN.WEB-DL.DD5.1.H.264-SiGMA"
  displayName     String?   // Best-effort cleaned-up title parsed from filename, e.g. "Powder (1995)"
  requestCount    Int       @default(1) // AIOStreams' `count` - number of individual requests merged into this entry
  startTime       DateTime  // AIOStreams' `timestamp` - when this connection was first opened
  lastSeenAt      DateTime  // AIOStreams' `lastSeen` - most recent activity on this connection, updates as long as it's active
  endTime         DateTime? // When AIOStreams stopped reporting this active (null = still active)
  isActive        Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([accountId, aiostreamsUser, clientIp, url])
  @@index([accountId, isActive])
  @@index([accountId, aiostreamsUser, isActive])
  @@map("proxy_stream_sessions")
}
'''

for schema_path in [REPO / "prisma" / "schema.sqlite.prisma", REPO / "prisma" / "schema.postgres.prisma"]:
    if not schema_path.exists():
        fail(f"{schema_path} not found")
    content = schema_path.read_text()
    if "model ProxyStreamSession" not in content:
        fail(f"{schema_path} has no ProxyStreamSession model - run the original apply script first")
    new_content, count = OLD_MODEL_RE.subn(NEW_MODEL, content)
    if count == 0:
        fail(f"could not match old ProxyStreamSession model in {schema_path} to replace it - may have been hand-edited")
    schema_path.write_text(new_content)
    print(f"OK: replaced ProxyStreamSession model in {schema_path}")

# --- 2. Rewrite proxyStreamMonitor.js with corrected field mapping ---
monitor_path = REPO / "server" / "utils" / "proxyStreamMonitor.js"
if not monitor_path.exists():
    fail(f"{monitor_path} not found - run the original apply script first")

monitor_content = '''// Proxy stream monitor - polls AIOStreams' built-in proxy stats endpoint and
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

const CHECK_INTERVAL_MS = 30 * 1000 // 30s - streams start/stop faster than the 1min library-sync interval

let pollTimer = null
let cachedCookie = null

function heartbeat(event, data = {}) {
  try {
    const fs = require('fs')
    const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}\\n`
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

  const withoutExt = filename.replace(/\\.[a-zA-Z0-9]{2,4}$/, '')
  const yearMatch = withoutExt.match(/^(.*?)[.\\s](\\d{4})[.\\s]/)

  if (yearMatch) {
    const title = yearMatch[1].replace(/\\./g, ' ').trim()
    const year = yearMatch[2]
    return `${title} (${year})`
  }

  const cleaned = withoutExt
    .replace(/[._]/g, ' ')
    .replace(/\\b(1080p|2160p|720p|480p|4K|HDR|WEB-?DL|WEBRip|BluRay|BRRip|HDTV|x264|x265|H\\s?264|H\\s?265|DD5\\s?1|DDP5\\s?1|AAC|AC3|REMUX)\\b.*$/i, '')
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

        await prisma.proxyStreamSession.upsert({
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
      }
    }

    // Anything previously active that AIOStreams no longer lists: mark ended.
    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: { id: true, aiostreamsUser: true, clientIp: true, url: true },
    })

    const toClose = staleActive.filter(
      (row) => !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`)
    )
    if (toClose.length > 0) {
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
  CHECK_INTERVAL_MS,
}
'''

monitor_path.write_text(monitor_content)
print(f"OK: rewrote {monitor_path} with corrected field mapping")

print()
print("=" * 60)
print("Done. Next steps:")
print("  1. Generate a patch and move it to Windows (VPS never pushes):")
print("       git add -A")
print("       git commit -m 'fix: correct ProxyStreamSession field mapping to match AIOStreams'")
print("       git format-patch -1 HEAD --stdout > /tmp/0002-fix-proxy-stream-fields.patch")
print("  2. scp that patch to Windows Downloads, git am it there, push, tag, gh release")
print("  3. VPS: git pull, then docker compose --profile slicksync up -d --build")
print("     (db push --accept-data-loss will auto-migrate the column changes)")
print("  4. Re-run the live-stream test")
print("=" * 60)
