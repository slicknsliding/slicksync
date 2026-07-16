#!/usr/bin/env python3
"""
Fixes disambiguation title matching: it was using exact string equality
between the proxy's parsed displayName (e.g. "Man on Fire S01E01" - includes
episode info from the filename) and WatchSession's itemName (e.g. "Man on
Fire" - just the show title, no episode). These never matched exactly even
when they were obviously the same show, so disambiguation silently fell
back to an arbitrary first candidate instead of correctly identifying the
real match - confirmed with real data where the WatchSession row belonged
to the correct user (NuvioSLICK) but got attributed to the wrong one
(SLICK STREMIO) purely because of this string-equality bug.

Fix: use substring containment (either title contains the other) instead
of exact equality.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

path = Path.cwd() / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    print(f"ERROR: {path} not found")
    sys.exit(1)

content = path.read_text(encoding="utf-8")

if "titlesMatch" in content:
    print(f"SKIP: {path} already uses substring title matching")
    sys.exit(0)

OLD = """  function disambiguateMatch(candidates, proxyDisplayName) {
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
  }"""

if OLD not in content:
    print(f"ERROR: could not find the expected disambiguateMatch function in {path}")
    sys.exit(1)

NEW = """  // Substring containment, not exact equality - the proxy's parsed
  // displayName includes episode info from the filename (e.g. "Man on
  // Fire S01E01"), while WatchSession's itemName is just the show title
  // ("Man on Fire"). These are the same show but never match via strict
  // equality, which silently broke disambiguation (confirmed with real
  // data: a correct WatchSession match existed but wasn't recognized,
  // causing a fallback to the wrong candidate).
  function titlesMatch(a, b) {
    if (!a || !b) return false
    return a.includes(b) || b.includes(a)
  }

  function disambiguateMatch(candidates, proxyDisplayName) {
    if (candidates.length <= 1) return candidates[0] || null

    const proxyTitle = normalizeTitle(proxyDisplayName)
    if (proxyTitle) {
      const titleMatch = candidates.find((u) => {
        const existing = watchSessionByUserId.get(u.id)
        return existing && titlesMatch(normalizeTitle(existing.item?.name), proxyTitle)
      })
      if (titleMatch) return titleMatch
    }

    return candidates[0]
  }"""

path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
print(f"OK: fixed title matching to use substring containment in {path}")
