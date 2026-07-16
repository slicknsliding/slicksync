#!/usr/bin/env python3
"""
Small follow-up fix: the item-poster block in proxyNowPlaying.js ended up
indented one extra level (nested inside a `for (const user of matchedUsers)`
loop added by an earlier patch), so the previous script's anchor didn't
match. This targets the real current indentation.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

path = Path.cwd() / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    print(f"ERROR: {path} not found")
    sys.exit(1)

content = path.read_text(encoding="utf-8")

if "proxy.posterUrl" in content:
    print(f"SKIP: {path} already uses posterUrl")
    sys.exit(0)

OLD = """        item: existing?.item ?? {
          id: null,
          name: proxy.displayName || proxy.filename || 'Unknown',
          type: null,
          year: null,
          poster: null,
          season: null,
          episode: null,
        },"""

NEW = """        item: existing?.item ?? {
          id: null,
          name: proxy.displayName || proxy.filename || 'Unknown',
          type: null,
          year: null,
          poster: proxy.posterUrl || null,
          season: null,
          episode: null,
        },"""

if OLD not in content:
    print(f"ERROR: could not find the expected item block in {path} even at this indentation - paste more context")
    sys.exit(1)

path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
print(f"OK: wired posterUrl into {path}")
