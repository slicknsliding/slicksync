#!/usr/bin/env python3
"""
Adds a fallback mapping to proxyNowPlaying.js: when AIOStreams' auth
username doesn't match any SlickSync User.username (common in this setup,
where one AIOStreams login covers multiple per-provider SlickSync profiles
for the same person), attribute the proxy stream to a configured list of
SlickSync user IDs instead of silently skipping it.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

REPO = Path.cwd()

def fail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

path = REPO / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    fail(f"{path} not found - run the previous now-playing merge script first")

content = path.read_text()

OLD = """  for (const proxy of proxySessions) {
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
  }"""

if "AIOSTREAMS_FALLBACK_USER_IDS" in content:
    print(f"SKIP: {path} already has the fallback mapping")
else:
    if OLD not in content:
        fail(f"could not find the expected loop body in {path} to patch - may have been hand-edited")

    NEW = """  // Fallback: AIOStreams only has one login username, but a single person
  // can have multiple per-provider SlickSync profiles (e.g. one Stremio
  // profile, one Nuvio profile) that don't match that username at all.
  // AIOSTREAMS_FALLBACK_USER_IDS lists which SlickSync user IDs should
  // receive proxy-detected activity when the username lookup above finds
  // no match, rather than silently dropping it. Comma-separated, set in
  // this app's own .env.
  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const usersById = new Map(users.map((u) => [u.id, u]))

  for (const proxy of proxySessions) {
    let matchedUsers = []
    const directMatch = userByUsername.get((proxy.aiostreamsUser || '').toLowerCase())
    if (directMatch) {
      matchedUsers = [directMatch]
    } else if (fallbackUserIds.length > 0) {
      matchedUsers = fallbackUserIds
        .map((id) => usersById.get(id))
        .filter(Boolean)
    }

    if (matchedUsers.length === 0) continue // no direct match and no usable fallback - skip rather than guess

    for (const user of matchedUsers) {
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
  }"""

    new_content = content.replace(OLD, NEW, 1)
    path.write_text(new_content)
    print(f"OK: added AIOSTREAMS_FALLBACK_USER_IDS fallback to {path}")

print()
print("=" * 60)
print("Done. Still needed:")
print("  1. Add to apps/slicksync/.env on the VPS:")
print("       AIOSTREAMS_FALLBACK_USER_IDS=cmr9xo9qq003do02k15qre4lx,cmr9xp6aw003eo02k9efxf3bh")
print("     (the two user IDs we found: SLICK STREMIO and NuvioSLICK)")
print("  2. Commit/push/tag/release from Windows as usual:")
print("       git add server/utils/proxyNowPlaying.js")
print("       git commit -m 'fix: fallback user mapping for AIOStreams Now Playing attribution'")
print("       git push && git tag v1.9.42 && git push --tags")
print('       gh release create v1.9.42 --title "v1.9.42" --notes "Fallback user mapping for proxy Now Playing"')
print("  3. VPS: git pull, rebuild, retest with a live stream")
print("=" * 60)
