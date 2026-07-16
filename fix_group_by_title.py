#!/usr/bin/env python3
"""
Fixes a real reproducible bug: seeking/rewinding creates a new AIOStreams
proxy connection (different byte-range request) while the OLD connection
sometimes lingers as "active" (AIOStreams keeps stale connections active up
to 6h unless explicitly told the request ended). This produces two active
ProxyStreamSession rows for the SAME real viewing session (same title,
different url) - and since disambiguation previously ran independently per
row, the old and new connections could get attributed to two DIFFERENT
SlickSync profiles, showing as a duplicate/split Now Playing entry.

Fix: group active proxy rows by normalized title BEFORE disambiguating,
and pick one profile per title group - not one profile per individual
connection row. All rows in a group get the same attribution.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

path = Path.cwd() / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    print(f"ERROR: {path} not found")
    sys.exit(1)

content = path.read_text(encoding="utf-8")

if "groupedByTitle" in content:
    print(f"SKIP: {path} already groups by title")
    sys.exit(0)

OLD = """  for (const proxy of proxySessions) {
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

if OLD not in content:
    print(f"ERROR: could not find the expected loop in {path} - may differ from what this patch expects")
    sys.exit(1)

NEW = """  // Group active proxy rows by normalized title before attributing them.
  // Seeking/rewinding creates a new connection (different byte-range
  // request) while the old one sometimes lingers as "active" - AIOStreams
  // keeps stale connections active up to 6h unless explicitly told the
  // request ended. Without grouping, the old and new rows for the SAME
  // real viewing session could get disambiguated to two DIFFERENT
  // profiles independently, showing as a split/duplicate entry. Grouping
  // ensures every row for one title gets the same single attribution.
  const groupedByTitle = new Map()
  for (const proxy of proxySessions) {
    const key = normalizeTitle(proxy.displayName) || proxy.url
    if (!groupedByTitle.has(key)) groupedByTitle.set(key, [])
    groupedByTitle.get(key).push(proxy)
  }

  for (const group of groupedByTitle.values()) {
    // Use the most recently active row in the group as the representative
    // for display fields (startTime, poster, etc.) - the freshest one is
    // most likely the real current connection, not a stale leftover.
    const representative = group.reduce((latest, p) =>
      p.lastSeenAt > latest.lastSeenAt ? p : latest
    )

    let candidates = []
    const aiostreamsUserLower = (representative.aiostreamsUser || '').toLowerCase()
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

    const user = disambiguateMatch(candidates, representative.displayName)
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
        name: representative.displayName || representative.filename || 'Unknown',
        type: null,
        year: null,
        poster: representative.posterUrl || null,
        season: null,
        episode: null,
      },
      videoId: existing?.videoId ?? null,
      // Proxy startTime/liveness is the authoritative signal here, not
      // whatever the WatchSession entry (if any) happened to record.
      watchedAt: representative.startTime.toISOString(),
      watchedAtTimestamp: representative.startTime.getTime(),
      startTime: representative.startTime,
      source: 'aiostreams-proxy',
    })
  }"""

path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
print(f"OK: added title-grouping to {path}")
