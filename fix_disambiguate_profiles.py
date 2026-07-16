#!/usr/bin/env python3
"""
Fixes duplicate Now Playing attribution: previously, when an AIOStreams
username matched multiple SlickSync profiles (e.g. via email local-part, or
the ID fallback list), the stream was shown under ALL of them - since
AIOStreams itself has no way to say which actual client (Stremio vs Nuvio)
made the request. This showed the same stream duplicated under both
profiles even when only one was really watching.

New behavior: when multiple profiles match, pick ONE:
  1. Prefer whichever matched profile has an existing active WatchSession
     entry whose title matches the proxy's parsed display name - this is
     the only real signal available to disambiguate.
  2. If no title match exists for any candidate, fall back to just the
     FIRST matched profile (by whichever tier matched) rather than
     broadcasting to all - wrong-but-single beats duplicated-and-wrong.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

path = Path.cwd() / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    print(f"ERROR: {path} not found")
    sys.exit(1)

content = path.read_text(encoding="utf-8")

if "disambiguateMatch" in content:
    print(f"SKIP: {path} already has disambiguation logic")
    sys.exit(0)

OLD = """  for (const proxy of proxySessions) {
    let matchedUsers = []
    const aiostreamsUserLower = (proxy.aiostreamsUser || '').toLowerCase()
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)

    if (directMatch) {
      matchedUsers = [directMatch]
    } else if (emailMatch) {
      // One AIOStreams login, multiple per-provider profiles sharing an
      // email - matched by email local-part rather than username.
      matchedUsers = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
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
          poster: proxy.posterUrl || null,
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

if OLD not in content:
    print(f"ERROR: could not find the expected matching loop in {path} - may have been hand-edited since the last patch")
    sys.exit(1)

NEW = """  // Normalizes a title for loose comparison: lowercase, strip year/parens,
  // collapse whitespace. Good enough to tell "Obsession" vs "Obsession
  // (2025)" apart from something unrelated, not meant to be exact.
  function normalizeTitle(name) {
    return (name || '')
      .toLowerCase()
      .replace(/\\(\\d{4}\\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  }

  // When multiple SlickSync profiles match one AIOStreams login (this
  // login has no way to say which actual client/profile made the
  // request), pick a single one instead of showing the stream duplicated
  // under all of them. Prefers whichever candidate has an existing active
  // WatchSession entry whose title matches the proxy's parsed name; falls
  // back to the first candidate if no title match narrows it down.
  function disambiguateMatch(candidates, proxyDisplayName) {
    if (candidates.length <= 1) return candidates[0] || null

    const proxyTitle = normalizeTitle(proxyDisplayName)
    if (proxyTitle) {
      const titleMatch = candidates.find((u) => {
        const existing = watchSessionByUserId.get(u.id)
        return existing && normalizeTitle(existing.item?.name) === proxyTitle
      })
      if (titleMatch) return titleMatch
    }

    return candidates[0]
  }

  for (const proxy of proxySessions) {
    let candidates = []
    const aiostreamsUserLower = (proxy.aiostreamsUser || '').toLowerCase()
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)

    if (directMatch) {
      candidates = [directMatch]
    } else if (emailMatch) {
      // One AIOStreams login, multiple per-provider profiles sharing an
      // email - matched by email local-part rather than username.
      candidates = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
    } else if (fallbackUserIds.length > 0) {
      candidates = fallbackUserIds
        .map((id) => usersById.get(id))
        .filter(Boolean)
    }

    if (candidates.length === 0) continue // no direct match and no usable fallback - skip rather than guess

    const user = disambiguateMatch(candidates, proxy.displayName)
    if (!user) continue

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
        poster: proxy.posterUrl || null,
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

path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
print(f"OK: added disambiguation logic to {path}")
