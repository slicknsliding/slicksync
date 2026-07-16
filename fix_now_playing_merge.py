#!/usr/bin/env python3
"""
Adds server/utils/proxyNowPlaying.js (merges ProxyStreamSession into
WatchSession-derived Now Playing data: proxy wins on liveness/timing,
WatchSession's richer metadata is borrowed when available) and wires it into
both existing Now Playing call sites:

  - server/utils/metricsBuilder.js  (account-wide nowPlaying)
  - server/routes/publicLibrary.js  (per-user nowPlaying)

Run on WINDOWS, from inside the repo directory (this repo pushes from
Windows, never from the VPS):

    cd C:\\Users\\aybay\\Downloads\\slicksync
    python fix_now_playing_merge.py

Then commit/push/tag/release as usual, and on the VPS: git pull + rebuild.
"""
import sys
from pathlib import Path

REPO = Path.cwd()

def fail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

if not (REPO / "server" / "index.js").exists():
    fail("server/index.js not found - run this from the slicksync repo root")

# --- 1. New shared helper module ---
helper_path = REPO / "server" / "utils" / "proxyNowPlaying.js"
helper_content = '''// Merges AIOStreams proxy-detected active streams (ProxyStreamSession) into
// a WatchSession-derived nowPlaying list. The proxy signal is authoritative
// for whether something is actually playing right now and exactly when it
// started/stopped (confirmed accurate to one ~30s poll cycle - see
// proxyStreamMonitor.js), which the WatchSession/library-poll pipeline is
// not always reliable at (see MovieWatchHistory / ProxyStreamSession schema
// comments for background on that).
//
// When a user has both an active proxy stream and a WatchSession-derived
// entry, the proxy entry wins for liveness/timing but borrows the richer
// item metadata (poster, season, episode, real title) from the WatchSession
// entry when available, since ProxyStreamSession only has a filename-derived
// display name. Users covered by WatchSession but not currently seen by the
// proxy (e.g. a stream that didn't route through AIOStreams) are kept as-is,
// so nothing already working is lost.
//
// `users` must be objects with at least { id, username }. `watchSessionNowPlaying`
// entries must have a `user.id` field - callers with a differently-shaped
// list (e.g. the per-user publicLibrary.js route, which has no `user` field
// at all since it's already scoped to one user) should wrap/unwrap around
// this call - see publicLibrary.js for that pattern.
async function mergeProxyNowPlaying(prisma, accountId, users, watchSessionNowPlaying) {
  let proxySessions
  try {
    proxySessions = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      orderBy: { startTime: 'desc' },
    })
  } catch (error) {
    console.warn('[ProxyNowPlaying] Failed to fetch active proxy sessions:', error.message)
    return watchSessionNowPlaying
  }

  if (proxySessions.length === 0) return watchSessionNowPlaying

  const userByUsername = new Map(
    users.filter((u) => u.username).map((u) => [u.username.toLowerCase(), u])
  )
  const watchSessionByUserId = new Map(
    watchSessionNowPlaying.filter((np) => np.user && np.user.id).map((np) => [np.user.id, np])
  )

  const result = []
  const coveredUserIds = new Set()

  for (const proxy of proxySessions) {
    const user = userByUsername.get((proxy.aiostreamsUser || '').toLowerCase())
    if (!user) continue // AIOStreams username doesn't map to a known SlickSync user - skip rather than guess

    coveredUserIds.add(user.id)
    const existing = watchSessionByUserId.get(user.id)

    result.push({
      user: existing?.user ?? {
        id: user.id,
        username: user.username || user.email,
        email: user.email,
        colorIndex: user.colorIndex || 0,
        avatarUrl: user.avatarUrl || null,
        useGravatar: user.useGravatar ?? false,
      },
      item: existing?.item ?? {
        id: null,
        name: proxy.displayName || proxy.filename || 'Unknown',
        type: null,
        year: null,
        poster: null,
        season: null,
        episode: null,
      },
      videoId: existing?.videoId ?? null,
      // Proxy startTime/liveness is the authoritative signal here, not
      // whatever the WatchSession entry (if any) happened to record.
      watchedAt: proxy.startTime.toISOString(),
      watchedAtTimestamp: proxy.startTime.getTime(),
      startTime: proxy.startTime,
      source: 'aiostreams-proxy',
    })
  }

  for (const np of watchSessionNowPlaying) {
    const uid = np.user && np.user.id
    if (!uid || !coveredUserIds.has(uid)) result.push(np)
  }

  return result
}

module.exports = { mergeProxyNowPlaying }
'''

if helper_path.exists():
    print(f"SKIP: {helper_path} already exists")
else:
    helper_path.write_text(helper_content)
    print(f"OK: wrote {helper_path}")

# --- 2. Wire into metricsBuilder.js (account-wide) ---
metrics_path = REPO / "server" / "utils" / "metricsBuilder.js"
metrics_content = metrics_path.read_text()

METRICS_ANCHOR = """      videoId: session.videoId ?? null,
      watchedAt: session.startTime.toISOString(),
      watchedAtTimestamp: session.startTime.getTime()
    })
  }
"""
METRICS_MARKER = "mergeProxyNowPlaying(prisma"

if METRICS_MARKER in metrics_content:
    print(f"SKIP: {metrics_path} already wired up")
elif METRICS_ANCHOR not in metrics_content:
    fail(f"could not find expected nowPlaying loop in {metrics_path} - file may have changed since this script was written")
else:
    insertion = METRICS_ANCHOR + """
  // Merge in AIOStreams proxy-detected active streams (faster/more accurate
  // start/stop detection than the WatchSession poll-based pipeline above).
  // Proxy-detected entries take priority per user; WatchSession entries
  // above remain as a fallback for any user not currently covered by the
  // proxy (e.g. a stream that didn't route through AIOStreams).
  try {
    const { mergeProxyNowPlaying } = require('./proxyNowPlaying')
    const merged = await mergeProxyNowPlaying(prisma, accountIdValue || 'default', activeUsers, nowPlaying)
    nowPlaying.length = 0
    nowPlaying.push(...merged)
  } catch (error) {
    console.warn('[MetricsBuilder] Failed to merge proxy now playing:', error.message)
  }
"""
    new_content = metrics_content.replace(METRICS_ANCHOR, insertion, 1)
    metrics_path.write_text(new_content)
    print(f"OK: wired mergeProxyNowPlaying into {metrics_path}")

# --- 3. Wire into publicLibrary.js (per-user) ---
lib_path = REPO / "server" / "routes" / "publicLibrary.js"
lib_content = lib_path.read_text()

LIB_ANCHOR = """      const nowPlaying = activeSessions.map(s => ({
        item: {
          id: s.itemId,
          name: s.itemName,
          type: s.itemType,
          poster: s.poster,
          season: s.season,
          episode: s.episode
        },
        startTime: s.startTime,
        videoId: s.videoId
      }));
"""
LIB_MARKER = "mergeProxyNowPlaying(prisma"

if LIB_MARKER in lib_content:
    print(f"SKIP: {lib_path} already wired up")
elif LIB_ANCHOR not in lib_content:
    fail(f"could not find expected nowPlaying block in {lib_path} - file may have changed since this script was written")
else:
    insertion = LIB_ANCHOR + """
      // Merge in an AIOStreams proxy-detected active stream for this user
      // (faster/more accurate start/stop detection than the WatchSession
      // pipeline above). Wrapped/unwrapped around the shared helper since
      // this route's nowPlaying entries have no `user` field (already
      // scoped to one user) unlike metricsBuilder.js's account-wide list.
      try {
        const { mergeProxyNowPlaying } = require('../utils/proxyNowPlaying');
        const wrapped = nowPlaying.map(np => ({ user: { id: userId }, item: np.item, startTime: np.startTime, videoId: np.videoId }));
        const merged = await mergeProxyNowPlaying(prisma, user.accountId || DEFAULT_ACCOUNT_ID, [user], wrapped);
        nowPlaying.length = 0;
        nowPlaying.push(...merged.map(m => ({ item: m.item, startTime: m.startTime, videoId: m.videoId })));
      } catch (error) {
        console.warn('[PublicLibrary] Failed to merge proxy now playing:', error.message);
      }
"""
    new_content = lib_content.replace(LIB_ANCHOR, insertion, 1)
    lib_path.write_text(new_content)
    print(f"OK: wired mergeProxyNowPlaying into {lib_path}")

print()
print("=" * 60)
print("Done. Next steps (Windows, this repo pushes from here - not the VPS):")
print("  git add server/utils/proxyNowPlaying.js server/utils/metricsBuilder.js server/routes/publicLibrary.js")
print("  git commit -m 'feat: merge AIOStreams proxy data into Now Playing'")
print("  git push")
print("  git tag v1.9.41")
print("  git push --tags")
print('  gh release create v1.9.41 --title "v1.9.41" --notes "Merge AIOStreams proxy into Now Playing"')
print()
print("Then on VPS: cd /opt/docker/build/slicksync && git pull && cd /opt/docker && docker compose --profile slicksync up -d --build")
print()
print("NOTE: user.username must exist and match AIOStreams' AIOSTREAMS_AUTH")
print("username (case-insensitive) for the merge to attribute a proxy stream")
print("to the right SlickSync user - worth confirming with a live test after deploy.")
print("=" * 60)
