#!/usr/bin/env python3
"""
Adds AIOMetadata-based poster enrichment for proxy-only Now Playing entries:

  - AppAccount.aiometadataManifestUrl (nullable, user-editable via new route)
  - ProxyStreamSession.posterUrl / metadataMatchedAt (cached lookup result)
  - server/utils/aiometadataLookup.js - searches AIOMetadata's search.movie/
    search.series catalogs, picks best match by year, returns poster URL
  - server/routes/aiometadata.js - GET/POST /api/aiometadata/manifest-url
  - Wired into proxyStreamMonitor.js (runs lookup once per new stream, cached)
    and proxyNowPlaying.js (uses proxy.posterUrl when no WatchSession match)

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

REPO = Path.cwd()

def fail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

if not (REPO / "server" / "index.js").exists():
    fail("run this from the slicksync repo root")

# --- 1. Schema: AppAccount.aiometadataManifestUrl ---
for schema_path in [REPO / "prisma" / "schema.sqlite.prisma", REPO / "prisma" / "schema.postgres.prisma"]:
    content = schema_path.read_text(encoding="utf-8")
    if "aiometadataManifestUrl" in content:
        print(f"SKIP: {schema_path} already has aiometadataManifestUrl")
        continue
    OLD = '  apiKeyHash   String? // Encrypted API key\n'
    if OLD not in content:
        fail(f"could not find AppAccount.apiKeyHash anchor in {schema_path}")
    NEW = OLD + '  aiometadataManifestUrl String? // User-editable AIOMetadata addon manifest URL, used to look up posters for AIOStreams-proxy-detected Now Playing entries that have no WatchSession match\n'
    schema_path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"OK: added aiometadataManifestUrl to {schema_path}")

# --- 2. Schema: ProxyStreamSession.posterUrl / metadataMatchedAt ---
for schema_path in [REPO / "prisma" / "schema.sqlite.prisma", REPO / "prisma" / "schema.postgres.prisma"]:
    content = schema_path.read_text(encoding="utf-8")
    if "metadataMatchedAt" in content:
        print(f"SKIP: {schema_path} already has metadataMatchedAt")
        continue
    OLD = "  displayName     String?   // Best-effort cleaned-up title parsed from filename, e.g. \"Powder (1995)\"\n"
    if OLD not in content:
        fail(f"could not find ProxyStreamSession.displayName anchor in {schema_path}")
    NEW = OLD + (
        "  posterUrl       String?   // Poster URL from an AIOMetadata search lookup, cached so we don't re-query on every poll while a stream is still active\n"
        "  metadataMatchedAt DateTime? // When the AIOMetadata lookup was attempted (whether or not it found a match) - null means not yet attempted\n"
    )
    schema_path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"OK: added posterUrl/metadataMatchedAt to {schema_path}")

# --- 3. New lookup helper ---
lookup_path = REPO / "server" / "utils" / "aiometadataLookup.js"
lookup_content = '''// Looks up a poster from the account's configured AIOMetadata addon, for
// AIOStreams-proxy-detected streams that have no matching WatchSession entry
// (and therefore no library-derived poster/title already available).
//
// AIOMetadata is a standard Stremio-protocol addon: given a manifest URL like
// https://host/stremio/<uuid>/manifest.json, its search catalogs live at
// {base}/catalog/{type}/search.{type}/search={query}.json and return a
// `metas` array with { id, name, poster, year, releaseInfo, type, ... }.
//
// A bare title search can match the wrong title/year (e.g. "Powder" matched
// "Powder Blue" (2009) ahead of "Powder" (1995) in testing) - so this picks
// the result whose year best matches the parsed year, falling back to the
// top result only if no year match exists.

const LOOKUP_TIMEOUT_MS = 8000

function stripManifestSuffix(manifestUrl) {
  return manifestUrl.replace(/\\/manifest\\.json\\/?$/, '')
}

async function searchCatalog(baseUrl, type, query) {
  const url = `${baseUrl}/catalog/${type}/search.${type}/search=${encodeURIComponent(query)}.json`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.metas) ? data.metas : []
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function pickBestMatch(metas, year) {
  if (metas.length === 0) return null
  if (year) {
    const yearMatch = metas.find((m) => {
      const metaYear = (m.year || m.releaseInfo || '').toString().slice(0, 4)
      return metaYear === String(year)
    })
    if (yearMatch) return yearMatch
  }
  return metas[0]
}

/**
 * title: parsed display title, e.g. "Powder" (year stripped out separately)
 * year: parsed year string, e.g. "1995", or null if not parsed
 * Returns { posterUrl } or null if no manifest configured / no match found.
 */
async function lookupAiometadataPoster(manifestUrl, title, year) {
  if (!manifestUrl || !title) return null

  const baseUrl = stripManifestSuffix(manifestUrl)

  let metas = await searchCatalog(baseUrl, 'movie', title)
  let match = pickBestMatch(metas, year)

  if (!match) {
    metas = await searchCatalog(baseUrl, 'series', title)
    match = pickBestMatch(metas, year)
  }

  if (!match || !match.poster) return null
  return { posterUrl: match.poster }
}

module.exports = { lookupAiometadataPoster }
'''
if lookup_path.exists():
    print(f"SKIP: {lookup_path} already exists")
else:
    lookup_path.write_text(lookup_content, encoding="utf-8")
    print(f"OK: wrote {lookup_path}")

# --- 4. New settings route ---
route_path = REPO / "server" / "routes" / "aiometadata.js"
route_content = '''// GET/POST the account's AIOMetadata manifest URL - lets it be changed from
// the UI rather than requiring a redeploy/env var change.
const { Router } = require('express')

module.exports = ({ prisma, getAccountId }) => {
  const router = Router()

  router.get('/manifest-url', async (req, res) => {
    try {
      const accountId = getAccountId(req)
      const account = await prisma.appAccount.findUnique({
        where: { id: accountId },
        select: { aiometadataManifestUrl: true },
      })
      res.json({ manifestUrl: account?.aiometadataManifestUrl || null })
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch AIOMetadata manifest URL', error: error.message })
    }
  })

  router.post('/manifest-url', async (req, res) => {
    try {
      const accountId = getAccountId(req)
      const { manifestUrl } = req.body || {}

      if (manifestUrl !== null && typeof manifestUrl !== 'string') {
        return res.status(400).json({ message: 'manifestUrl must be a string or null' })
      }
      if (manifestUrl && !/^https?:\\/\\/.+\\/manifest\\.json\\/?$/.test(manifestUrl)) {
        return res.status(400).json({ message: 'manifestUrl must end in /manifest.json' })
      }

      await prisma.appAccount.update({
        where: { id: accountId },
        data: { aiometadataManifestUrl: manifestUrl || null },
      })

      res.json({ success: true, manifestUrl: manifestUrl || null })
    } catch (error) {
      res.status(500).json({ message: 'Failed to update AIOMetadata manifest URL', error: error.message })
    }
  })

  return router
}
'''
if route_path.exists():
    print(f"SKIP: {route_path} already exists")
else:
    route_path.write_text(route_content, encoding="utf-8")
    print(f"OK: wrote {route_path}")

# --- 5. Wire route into index.js ---
index_path = REPO / "server" / "index.js"
index_content = index_path.read_text(encoding="utf-8")

if "aiometadataRouter" in index_content:
    print(f"SKIP: {index_path} already wires up aiometadataRouter")
else:
    ANCHOR = "const vaultRouter = require('./routes/vault');"
    if ANCHOR not in index_content:
        fail(f"could not find vaultRouter require line in {index_path}")
    index_content = index_content.replace(
        ANCHOR,
        ANCHOR + "\nconst aiometadataRouter = require('./routes/aiometadata');",
        1,
    )

    MOUNT_ANCHOR = "app.use('/api/vault', vaultRouter({ prisma, getAccountId, encrypt, decrypt }));"
    if MOUNT_ANCHOR not in index_content:
        fail(f"could not find vault router mount line in {index_path}")
    index_content = index_content.replace(
        MOUNT_ANCHOR,
        MOUNT_ANCHOR + "\napp.use('/api/aiometadata', aiometadataRouter({ prisma, getAccountId }));",
        1,
    )
    index_path.write_text(index_content, encoding="utf-8")
    print(f"OK: wired aiometadata route into {index_path}")

# --- 6. Integrate lookup into proxyStreamMonitor.js ---
monitor_path = REPO / "server" / "utils" / "proxyStreamMonitor.js"
monitor_content = monitor_path.read_text(encoding="utf-8")

if "lookupAiometadataPoster" in monitor_content:
    print(f"SKIP: {monitor_path} already integrates aiometadata lookup")
else:
    # Add the require near the top
    REQUIRE_ANCHOR = "const CHECK_INTERVAL_MS = 30 * 1000"
    if REQUIRE_ANCHOR not in monitor_content:
        fail(f"could not find CHECK_INTERVAL_MS anchor in {monitor_path}")
    monitor_content = monitor_content.replace(
        REQUIRE_ANCHOR,
        "const { lookupAiometadataPoster } = require('./aiometadataLookup')\n\n" + REQUIRE_ANCHOR,
        1,
    )

    # Parse year out of parseDisplayName's output for reuse in the lookup call.
    # Simplest: re-derive year from filename inline where we already have it.
    OLD_UPSERT = """        await prisma.proxyStreamSession.upsert({
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
        })"""

    if OLD_UPSERT not in monitor_content:
        fail(f"could not find expected upsert block in {monitor_path} to add poster lookup")

    NEW_UPSERT = """        const row = await prisma.proxyStreamSession.upsert({
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
        // not on every 30s poll while the same stream is still active.
        if (!row.metadataMatchedAt) {
          try {
            const account = await prisma.appAccount.findUnique({
              where: { id: accountId },
              select: { aiometadataManifestUrl: true },
            })
            const manifestUrl = account?.aiometadataManifestUrl
            if (manifestUrl && displayName) {
              const yearMatch = displayName.match(/\\((\\d{4})\\)$/)
              const year = yearMatch ? yearMatch[1] : null
              const title = year ? displayName.replace(/\\s*\\(\\d{4}\\)$/, '') : displayName
              const result = await lookupAiometadataPoster(manifestUrl, title, year)
              await prisma.proxyStreamSession.update({
                where: { id: row.id },
                data: {
                  posterUrl: result?.posterUrl ?? null,
                  metadataMatchedAt: new Date(),
                },
              })
            }
          } catch (error) {
            heartbeat('pollOnce:poster_lookup_error', { message: error.message })
          }
        }"""

    monitor_content = monitor_content.replace(OLD_UPSERT, NEW_UPSERT, 1)
    monitor_path.write_text(monitor_content, encoding="utf-8")
    print(f"OK: integrated AIOMetadata poster lookup into {monitor_path}")

# --- 7. Use posterUrl in proxyNowPlaying.js's fallback item metadata ---
merge_path = REPO / "server" / "utils" / "proxyNowPlaying.js"
merge_content = merge_path.read_text(encoding="utf-8")

OLD_ITEM = """      item: existing?.item ?? {
        id: null,
        name: proxy.displayName || proxy.filename || 'Unknown',
        type: null,
        year: null,
        poster: null,
        season: null,
        episode: null,
      },"""
NEW_ITEM = """      item: existing?.item ?? {
        id: null,
        name: proxy.displayName || proxy.filename || 'Unknown',
        type: null,
        year: null,
        poster: proxy.posterUrl || null,
        season: null,
        episode: null,
      },"""

if "proxy.posterUrl" in merge_content:
    print(f"SKIP: {merge_path} already uses posterUrl")
elif OLD_ITEM not in merge_content:
    fail(f"could not find expected item block in {merge_path}")
else:
    merge_path.write_text(merge_content.replace(OLD_ITEM, NEW_ITEM, 1), encoding="utf-8")
    print(f"OK: wired posterUrl into {merge_path}")

print()
print("=" * 60)
print("Done. Next steps (Windows, this repo pushes from here):")
print("  git add prisma/schema.sqlite.prisma prisma/schema.postgres.prisma \\")
print("          server/utils/aiometadataLookup.js server/routes/aiometadata.js \\")
print("          server/index.js server/utils/proxyStreamMonitor.js server/utils/proxyNowPlaying.js")
print("  git commit -m 'feat: AIOMetadata poster lookup for proxy-only Now Playing entries'")
print("  git push && git tag v1.9.43 && git push --tags")
print('  gh release create v1.9.43 --title "v1.9.43" --notes "AIOMetadata poster enrichment"')
print()
print("VPS: git pull + rebuild, then set the manifest URL once via:")
print('  curl -X POST https://slicksync.slickssns.vip/api/aiometadata/manifest-url \\')
print('    -H "Content-Type: application/json" \\')
print('    -d \'{"manifestUrl":"https://aiometadata.slickssns.vip/stremio/78ae51e7-0554-4ee0-baa4-62415d09920f/manifest.json"}\'')
print("  (this needs an authenticated session cookie to succeed - easiest done")
print("   by wiring a small settings-page field later; curl works for a one-time test")
print("   if you grab your slicksync session cookie from the browser first)")
print("=" * 60)
