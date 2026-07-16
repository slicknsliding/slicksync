#!/usr/bin/env python3
"""
Fixes a real gap: our AIOStreams-proxy tracking only ever wrote into "Now
Playing" (ProxyStreamSession.isActive) - it never wrote a completed history
record once a stream ends. WatchSession rows with endTime set are what feed
the Today/Yesterday timeline in the frontend (transformMetricsToActivity),
and our proxy code never touched that table - so a proxy-only stream would
correctly vanish from Now Playing but leave zero historical trace.

This adds:
  1. ProxyStreamSession.metadataItemId / metadataItemType - captures the
     real IMDb-style ID from AIOMetadata (previously fetched but discarded,
     keeping only posterUrl).
  2. aiometadataLookup.js now returns { posterUrl, id, type } instead of
     just { posterUrl }.
  3. proxyStreamMonitor.js: when connections close, groups them by title,
     resolves which SlickSync user they belong to (username -> email
     local-part -> matching existing history -> fallback list), and upserts
     a completed WatchSession row (keyed by accountId+userId+itemId per the
     existing schema's unique constraint) so it appears in the timeline
     exactly like any other completed session.

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

# --- 1. Schema: metadataItemId / metadataItemType ---
for schema_path in [REPO / "prisma" / "schema.sqlite.prisma", REPO / "prisma" / "schema.postgres.prisma"]:
    content = schema_path.read_text(encoding="utf-8")
    if "metadataItemId" in content:
        print(f"SKIP: {schema_path} already has metadataItemId")
        continue
    OLD = "  metadataMatchedAt DateTime? // When the AIOMetadata lookup was attempted (whether or not it found a match) - null means not yet attempted\n"
    if OLD not in content:
        fail(f"could not find metadataMatchedAt anchor in {schema_path}")
    NEW = OLD + (
        "  metadataItemId   String?   // Real IMDb-style ID from the AIOMetadata match, e.g. \"tt1032819\" - used to key the completed-history WatchSession row when this stream ends\n"
        "  metadataItemType String?   // \"movie\" or \"series\" from the AIOMetadata match\n"
    )
    schema_path.write_text(content.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"OK: added metadataItemId/metadataItemType to {schema_path}")

# --- 2. aiometadataLookup.js: return id/type too ---
lookup_path = REPO / "server" / "utils" / "aiometadataLookup.js"
lookup_content = lookup_path.read_text(encoding="utf-8")

OLD_RETURN = """  if (!match || !match.poster) return null
  return { posterUrl: match.poster }
}"""
NEW_RETURN = """  if (!match) return null
  return {
    posterUrl: match.poster || null,
    id: match.id || null,
    type: match.type || null,
  }
}"""
if "id: match.id" in lookup_content:
    print(f"SKIP: {lookup_path} already returns id/type")
elif OLD_RETURN not in lookup_content:
    fail(f"could not find expected return block in {lookup_path}")
else:
    lookup_path.write_text(lookup_content.replace(OLD_RETURN, NEW_RETURN, 1), encoding="utf-8")
    print(f"OK: {lookup_path} now returns id/type alongside posterUrl")

# --- 3. proxyStreamMonitor.js: capture id/type, and write history on close ---
monitor_path = REPO / "server" / "utils" / "proxyStreamMonitor.js"
monitor_content = monitor_path.read_text(encoding="utf-8")

if "writeCompletedWatchSession" in monitor_content:
    print(f"SKIP: {monitor_path} already writes completed history")
    sys.exit(0)

# 3a. Store metadataItemId/metadataItemType alongside posterUrl
OLD_UPDATE = """              await prisma.proxyStreamSession.update({
                where: { id: row.id },
                data: {
                  posterUrl: result?.posterUrl ?? null,
                  metadataMatchedAt: new Date(),
                },
              })"""
NEW_UPDATE = """              await prisma.proxyStreamSession.update({
                where: { id: row.id },
                data: {
                  posterUrl: result?.posterUrl ?? null,
                  metadataItemId: result?.id ?? null,
                  metadataItemType: result?.type ?? null,
                  metadataMatchedAt: new Date(),
                },
              })"""
if OLD_UPDATE not in monitor_content:
    fail(f"could not find expected poster-lookup update block in {monitor_path}")
monitor_content = monitor_content.replace(OLD_UPDATE, NEW_UPDATE, 1)

# 3b. Expand staleActive select to include everything needed for history writing
OLD_SELECT = """    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: { id: true, aiostreamsUser: true, clientIp: true, url: true },
    })"""
NEW_SELECT = """    const staleActive = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      select: {
        id: true,
        aiostreamsUser: true,
        clientIp: true,
        url: true,
        displayName: true,
        filename: true,
        posterUrl: true,
        metadataItemId: true,
        metadataItemType: true,
        startTime: true,
      },
    })"""
if OLD_SELECT not in monitor_content:
    fail(f"could not find expected staleActive select in {monitor_path}")
monitor_content = monitor_content.replace(OLD_SELECT, NEW_SELECT, 1)

# 3c. Replace the toClose block with one that also writes completed history
OLD_CLOSE = """    const toClose = staleActive.filter(
      (row) => !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`)
    )
    if (toClose.length > 0) {
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })
    }"""
NEW_CLOSE = """    const toClose = staleActive.filter(
      (row) => !seenKeys.has(`${row.aiostreamsUser}:::${row.clientIp}:::${row.url}`)
    )
    if (toClose.length > 0) {
      await prisma.proxyStreamSession.updateMany({
        where: { id: { in: toClose.map((r) => r.id) } },
        data: { isActive: false, endTime: now },
      })

      try {
        await writeCompletedWatchSessions(prisma, accountId, toClose, now)
      } catch (error) {
        heartbeat('pollOnce:history_write_error', { message: error.message, stack: error.stack })
      }
    }"""
if OLD_CLOSE not in monitor_content:
    fail(f"could not find expected toClose block in {monitor_path}")
monitor_content = monitor_content.replace(OLD_CLOSE, NEW_CLOSE, 1)

# 3d. Add the history-writing function + its helpers, right before pollOnce
HISTORY_FUNCTIONS = '''
// Same loose title comparison used for Now Playing disambiguation - good
// enough to tell "Powder" apart from something unrelated, not exact.
function normalizeTitleForHistory(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\\(\\d{4}\\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Resolves which SlickSync user a closed AIOStreams connection belongs to.
 * Same tiers as the Now Playing merge (proxyNowPlaying.js): username ->
 * email local-part -> fallback ID list - but since there's no live
 * WatchSession entry to disambiguate against at this point (the whole
 * point of this function is to WRITE that history, not read it), ties
 * within the fallback list are broken by whichever candidate already has
 * an existing history row (WatchSession, EpisodeWatchHistory, or
 * MovieWatchHistory) for this exact title, falling back to the first
 * configured ID if none do.
 */
async function resolveUserForClosedConnection(prisma, accountId, aiostreamsUser, title) {
  const users = await prisma.user.findMany({
    where: { accountId },
    select: { id: true, username: true, email: true },
  })

  const lower = (aiostreamsUser || '').toLowerCase()
  const directMatch = users.find((u) => u.username && u.username.toLowerCase() === lower)
  if (directMatch) return directMatch

  const emailMatches = users.filter(
    (u) => u.email && u.email.split('@')[0].toLowerCase() === lower
  )
  if (emailMatches.length === 1) return emailMatches[0]

  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const candidates = emailMatches.length > 0
    ? emailMatches
    : fallbackUserIds.map((id) => users.find((u) => u.id === id)).filter(Boolean)

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const normalizedTitle = normalizeTitleForHistory(title)
  if (normalizedTitle) {
    for (const candidate of candidates) {
      const [existingSession, existingEpisode, existingMovie] = await Promise.all([
        prisma.watchSession.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { updatedAt: 'desc' },
          select: { itemName: true },
        }),
        prisma.episodeWatchHistory.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { watchedAt: 'desc' },
          select: { showName: true },
        }),
        prisma.movieWatchHistory.findFirst({
          where: { accountId, userId: candidate.id },
          orderBy: { watchedAt: 'desc' },
          select: { itemName: true },
        }),
      ])
      const names = [existingSession?.itemName, existingEpisode?.showName, existingMovie?.itemName]
      if (names.some((n) => n && normalizeTitleForHistory(n) === normalizedTitle)) {
        return candidate
      }
    }
  }

  return candidates[0]
}

/**
 * Groups just-closed proxy connections by title (same reasoning as the Now
 * Playing merge: a seek can leave two connection rows for one real viewing
 * session) and writes one completed WatchSession row per group, so it shows
 * up in the Today/Yesterday history timeline the same way any other
 * completed session does.
 */
async function writeCompletedWatchSessions(prisma, accountId, closedRows, endTime) {
  const groups = new Map()
  for (const row of closedRows) {
    const key = normalizeTitleForHistory(row.displayName) || row.url
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  for (const group of groups.values()) {
    const representative = group.reduce((latest, r) =>
      (!latest || r.startTime > latest.startTime) ? r : latest
    , null)
    const earliestStartTime = group.reduce((earliest, r) =>
      r.startTime < earliest ? r.startTime : earliest
    , representative.startTime)

    const title = representative.displayName || representative.filename || 'Unknown'
    const user = await resolveUserForClosedConnection(prisma, accountId, representative.aiostreamsUser, title)
    if (!user) {
      heartbeat('writeCompletedWatchSessions:no_user_match', { aiostreamsUser: representative.aiostreamsUser, title })
      continue
    }

    const durationSeconds = Math.max(0, Math.round((endTime.getTime() - earliestStartTime.getTime()) / 1000))
    // Skip near-instant blips (e.g. a preview/probe request) rather than
    // logging a 0-second "watch" in history.
    if (durationSeconds < 10) continue

    const itemId = representative.metadataItemId || `proxy:${normalizeTitleForHistory(title).replace(/\\s+/g, '-')}`
    const itemType = representative.metadataItemType === 'series' ? 'series' : 'movie'

    await prisma.watchSession.upsert({
      where: {
        accountId_userId_itemId: { accountId, userId: user.id, itemId },
      },
      create: {
        accountId,
        userId: user.id,
        itemId,
        itemName: title,
        itemType,
        poster: representative.posterUrl || null,
        startTime: earliestStartTime,
        endTime,
        durationSeconds,
        isActive: false,
      },
      update: {
        endTime,
        durationSeconds,
        isActive: false,
        poster: representative.posterUrl || undefined,
      },
    })
  }
}

'''
ANCHOR = "async function pollOnce(prisma, accountId, config) {"
if ANCHOR not in monitor_content:
    fail(f"could not find pollOnce anchor in {monitor_path}")
monitor_content = monitor_content.replace(ANCHOR, HISTORY_FUNCTIONS + ANCHOR, 1)

monitor_path.write_text(monitor_content, encoding="utf-8")
print(f"OK: added completed-history writing to {monitor_path}")

print()
print("=" * 60)
print("Done. Commit/push/tag/release from Windows as usual:")
print("  git add prisma/schema.sqlite.prisma prisma/schema.postgres.prisma \\")
print("          server/utils/aiometadataLookup.js server/utils/proxyStreamMonitor.js")
print("  git commit -m 'feat: write completed WatchSession history when a proxy stream ends'")
print("  git push && git tag v1.9.49 && git push --tags")
print('  gh release create v1.9.49 --title "v1.9.49" --notes "Proxy streams now appear in watch history after they end"')
print()
print("VPS: git pull + rebuild, then test: play something proxied, stop it,")
print("wait ~30s for the next poll cycle, and check the Today timeline.")
print("=" * 60)
