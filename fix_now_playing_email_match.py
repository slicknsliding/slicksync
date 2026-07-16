#!/usr/bin/env python3
"""
Adds a second matching tier to proxyNowPlaying.js: if the AIOStreams auth
username doesn't directly match a SlickSync User.username, try matching it
against the local-part of each user's email (e.g. "slicknslidin" from
"someuser@example.com") before falling back to the hardcoded
AIOSTREAMS_FALLBACK_USER_IDS list. More robust than the ID list alone since
it works automatically for any future per-provider profile sharing the same
email, without needing the .env list updated each time.

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
    fail(f"{path} not found")

content = path.read_text()

if "userByEmailLocalPart" in content:
    print(f"SKIP: {path} already has email-local-part matching")
    sys.exit(0)

OLD_MAP_SETUP = """  const userByUsername = new Map(
    users.filter((u) => u.username).map((u) => [u.username.toLowerCase(), u])
  )"""

if OLD_MAP_SETUP not in content:
    fail(f"could not find userByUsername map setup in {path} - file may differ from expected")

NEW_MAP_SETUP = OLD_MAP_SETUP + """
  // Secondary match: local-part of email (e.g. "slicknslidin" from
  // "someuser@example.com"). Handles the common case where one
  // AIOStreams login covers multiple per-provider SlickSync profiles that
  // share the same email but have provider-specific usernames (e.g. "SLICK
  // STREMIO", "NuvioSLICK") that don't match the AIOStreams username at all.
  const userByEmailLocalPart = new Map(
    users
      .filter((u) => u.email && u.email.includes('@'))
      .map((u) => [u.email.split('@')[0].toLowerCase(), u])
  )"""

content = content.replace(OLD_MAP_SETUP, NEW_MAP_SETUP, 1)

OLD_MATCH_LOGIC = """    let matchedUsers = []
    const directMatch = userByUsername.get((proxy.aiostreamsUser || '').toLowerCase())
    if (directMatch) {
      matchedUsers = [directMatch]
    } else if (fallbackUserIds.length > 0) {
      matchedUsers = fallbackUserIds
        .map((id) => usersById.get(id))
        .filter(Boolean)
    }"""

if OLD_MATCH_LOGIC not in content:
    fail(f"could not find matching logic in {path} - file may differ from expected (did the fallback ID script run first?)")

aios_user_lower = "(proxy.aiostreamsUser || '').toLowerCase()"
NEW_MATCH_LOGIC = f"""    let matchedUsers = []
    const aiostreamsUserLower = {aios_user_lower}
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)

    if (directMatch) {{
      matchedUsers = [directMatch]
    }} else if (emailMatch) {{
      // One AIOStreams login, multiple per-provider profiles sharing an
      // email - matched by email local-part rather than username.
      matchedUsers = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
    }} else if (fallbackUserIds.length > 0) {{
      matchedUsers = fallbackUserIds
        .map((id) => usersById.get(id))
        .filter(Boolean)
    }}"""

content = content.replace(OLD_MATCH_LOGIC, NEW_MATCH_LOGIC, 1)
path.write_text(content)
print(f"OK: added email-local-part matching tier to {path}")

print()
print("=" * 60)
print("Done. Matching order is now: username -> email local-part -> hardcoded ID list.")
print("For your setup, email local-part should now match both profiles")
print("automatically (both share someuser@example.com) - the")
print("AIOSTREAMS_FALLBACK_USER_IDS env var becomes a pure safety net,")
print("not strictly required anymore, but leave it set regardless.")
print()
print("Commit/push/tag/release from Windows as usual:")
print("  git add server/utils/proxyNowPlaying.js")
print("  git commit -m 'feat: match AIOStreams user by email local-part as a fallback tier'")
print("  git push && git tag v1.9.42 && git push --tags")
print('  gh release create v1.9.42 --title "v1.9.42" --notes "Email-based fallback matching for proxy Now Playing"')
print()
print("VPS: still add AIOSTREAMS_FALLBACK_USER_IDS to apps/slicksync/.env as a")
print("safety net, then git pull + rebuild, then retest.")
print("=" * 60)
