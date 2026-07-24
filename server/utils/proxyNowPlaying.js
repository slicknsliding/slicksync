// Merges AIOStreams proxy-detected active streams (ProxyStreamSession) into
// a WatchSession-derived nowPlaying list. The proxy signal is authoritative
// for whether something is actually playing right now and exactly when it
// started/stopped (confirmed accurate to one ~30s poll cycle - see
// proxyStreamMonitor.js), which the WatchSession/library-poll pipeline is
// not always reliable at (see MovieWatchHistory / ProxyStreamSession schema
// comments for background on that).
//
// When a user has both an active proxy stream and a matching (same-title)
// WatchSession-derived entry, the proxy entry wins for liveness/timing but
// borrows the richer item metadata (poster, season, episode, real title)
// from the WatchSession entry when available, since ProxyStreamSession only
// has a filename-derived display name. Coverage is per-title, not per-user:
// a WatchSession entry for a DIFFERENT title than any of that user's active
// proxy rows (e.g. a usenet stream, which never routes through AIOStreams'
// proxy at all, watched while a stale/unrelated debrid proxy row is still
// active for the same user) is kept as-is, so nothing already working is
// lost.
//
// `users` must be objects with at least { id, username }. `watchSessionNowPlaying`
// entries must have a `user.id` field - callers with a differently-shaped
// list (e.g. the per-user publicLibrary.js route, which has no `user` field
// at all since it's already scoped to one user) should wrap/unwrap around
// this call - see publicLibrary.js for that pattern.
// How far back a closed proxy connection still counts as "the proxy knows
// this stream ended". Must comfortably exceed the native tracker's
// actively-watching freshness window (~18 min as of 2026-07-20, widened from
// 15min - see sessionTracker.js), since that window is exactly how long a
// native session lingers as "active" after the provider's final checkpoint.
// Kept at the same ~5min margin above that window as before (was 20 vs 15).
const RECENTLY_CLOSED_MS = 23 * 60 * 1000

async function mergeProxyNowPlaying(prisma, accountId, users, watchSessionNowPlaying) {
  let proxySessions
  let recentlyClosedSessions
  try {
    proxySessions = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      orderBy: { startTime: 'desc' },
    })
    // Also load streams the proxy recently finished. The proxy is
    // authoritative for content it carries: if it saw a stream and that
    // stream has ended, a native "still watching" entry for the same title is
    // a stale echo (native only learns of a session when the provider writes
    // a checkpoint - at stop, for Nuvio - and then holds it "active" for its
    // whole freshness window). Suppressing those keeps an exited stream from
    // lingering in Now Playing. Content the proxy NEVER carried (e.g. usenet
    // via newznab, which bypasses the proxy entirely) has no such signal, so
    // its native entry is left alone - native is the only truth for it.
    recentlyClosedSessions = await prisma.proxyStreamSession.findMany({
      where: {
        accountId,
        isActive: false,
        endTime: { gte: new Date(Date.now() - RECENTLY_CLOSED_MS) },
      },
      orderBy: { endTime: 'desc' },
    })
  } catch (error) {
    console.warn('[ProxyNowPlaying] Failed to fetch proxy sessions:', error.message)
    return watchSessionNowPlaying
  }

  if (proxySessions.length === 0 && recentlyClosedSessions.length === 0) {
    return watchSessionNowPlaying
  }

  const userByUsername = new Map(
    users.filter((u) => u.username).map((u) => [u.username.toLowerCase(), u])
  )
  // Secondary match: local-part of email (e.g. "someuser" from
  // "someuser@example.com"). Handles the common case where one AIOStreams
  // login covers multiple per-provider SlickSync profiles that share the same
  // email but have provider-specific usernames that don't match the AIOStreams
  // username at all.
  const userByEmailLocalPart = new Map(
    users
      .filter((u) => u.email && u.email.includes('@'))
      .map((u) => [u.email.split('@')[0].toLowerCase(), u])
  )
  const watchSessionByUserId = new Map(
    watchSessionNowPlaying.filter((np) => np.user && np.user.id).map((np) => [np.user.id, np])
  )

  const result = []
  // Tracks, per user, the normalized titles of proxy-covered streams - NOT
  // just which users have any active proxy row. A stale/unrelated active
  // proxy connection (AIOStreams keeps rows active up to 6h - see the
  // grouping comment below) or a debrid stream watched earlier must not
  // blank out a genuinely different, still-active WatchSession entry for
  // the same user (e.g. a usenet stream that never routes through the
  // proxy at all) - only the specific title the proxy is covering should
  // be suppressed from the WatchSession pass below.
  const coveredTitlesByUser = new Map()
  // Same idea, but for titles the proxy recently FINISHED carrying - used only
  // to suppress a native entry that's a stale echo of an already-ended stream.
  const recentlyClosedTitlesByUser = new Map()

  // Fallback: AIOStreams only has one login username, but a single person
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

  // Normalizes a title for loose comparison: lowercase, strip year/parens,
  // collapse whitespace. Good enough to tell "Obsession" vs "Obsession
  // (2025)" apart from something unrelated, not meant to be exact.
  function normalizeTitle(name) {
    return (name || '')
      .toLowerCase()
      .replace(/\(\d{4}\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  }

  // When multiple SlickSync profiles match one AIOStreams login (this
  // login has no way to say which actual client/profile made the
  // request), pick a single one instead of showing the stream duplicated
  // under all of them. Prefers whichever candidate has an existing active
  // WatchSession entry whose title matches the proxy's parsed name; falls
  // back to the first candidate if no title match narrows it down.
  // Substring containment, not exact equality - the proxy's parsed
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

    // No title-match signal available (common when multiple profiles share
    // one email, since the email-match tier always returns all of them as
    // candidates - AIOSTREAMS_FALLBACK_USER_IDS never even gets consulted
    // in that case otherwise). Use the fallback list's order as the
    // tiebreaker here too: whichever candidate appears earliest in
    // AIOSTREAMS_FALLBACK_USER_IDS wins, rather than picking candidates[0]
    // in arbitrary database row order.
    if (fallbackUserIds.length > 0) {
      const byFallbackOrder = candidates
        .map((u) => ({ u, rank: fallbackUserIds.indexOf(u.id) }))
        .filter((c) => c.rank !== -1)
        .sort((a, b) => a.rank - b.rank)
      if (byFallbackOrder.length > 0) return byFallbackOrder[0].u
    }

    return candidates[0]
  }

  // Group active proxy rows by normalized title before attributing them.
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
    // for display fields (poster, displayName, liveness) - the freshest one
    // is most likely the real current connection, not a stale leftover.
    const representative = group.reduce((latest, p) =>
      p.lastSeenAt > latest.lastSeenAt ? p : latest
    )
    // Earliest startTime across the whole group is used for the reported
    // watch duration - a seek creates a new connection with a new (later)
    // startTime, and using the representative's own startTime alone would
    // make "Watching for Xm" reset toward 0 after every seek instead of
    // counting continuously from when viewing actually began. The
    // representative's own startTime is kept too (lastConnectionStartTime,
    // below) rather than discarded, in case a future UI wants to show
    // something like "resumed 2m ago" alongside the total duration.
    const earliestStartTime = group.reduce((earliest, p) =>
      p.startTime < earliest ? p.startTime : earliest
    , representative.startTime)

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

    if (!coveredTitlesByUser.has(user.id)) coveredTitlesByUser.set(user.id, new Set())
    coveredTitlesByUser.get(user.id).add(normalizeTitle(representative.displayName))
    const existing = watchSessionByUserId.get(user.id)
    // Only borrow the existing WatchSession's item/videoId if it's actually
    // about the same title the proxy detected - an existing session for
    // this user that's about something else entirely (a real, unrelated,
    // still-active session) must not be shown as if it were the proxied
    // content. User identity (avatar/username/email) is unaffected by this
    // check - that's about the person, not the content.
    const existingTitleMatches = existing &&
      titlesMatch(normalizeTitle(existing.item?.name), normalizeTitle(representative.displayName))

    result.push({
      user: existing?.user ?? {
        id: user.id,
        username: user.username || user.email,
        email: user.email,
        colorIndex: user.colorIndex || 0,
        avatarUrl: user.avatarUrl || null,
        useGravatar: user.useGravatar ?? false,
      },
      item: existingTitleMatches ? existing.item : {
        id: null,
        name: representative.displayName || representative.filename || 'Unknown',
        type: null,
        year: null,
        poster: representative.posterUrl || null,
        season: null,
        episode: null,
      },
      videoId: existingTitleMatches ? existing.videoId : null,
      // Same borrow-if-same-title rule as item/videoId above - the proxy
      // itself has no semantic playback position (it only sees byte-range
      // requests), so this is native's data riding along on the proxy's
      // liveness signal, not something the proxy actually knows.
      lastPosition: existingTitleMatches ? (existing.lastPosition ?? null) : null,
      totalDuration: existingTitleMatches ? (existing.totalDuration ?? null) : null,
      ...(existingTitleMatches && existing.stremioAppUrl ? { stremioAppUrl: existing.stremioAppUrl, nuvioAppUrl: existing.nuvioAppUrl } : {}),
      // Proxy startTime/liveness is the authoritative signal here, not
      // whatever the WatchSession entry (if any) happened to record.
      watchedAt: earliestStartTime.toISOString(),
      watchedAtTimestamp: earliestStartTime.getTime(),
      startTime: earliestStartTime,
      // Most recent connection's own start time (e.g. when the last seek
      // happened) - kept separately, not used for duration display.
      lastConnectionStartTime: representative.startTime.toISOString(),
      source: 'aiostreams-proxy',
    })
  }

  // Titles the proxy recently FINISHED carrying, per user. A native entry for
  // one of these is a stale echo of a stream the proxy knows already ended -
  // drop it so an exited stream doesn't linger in Now Playing for the length
  // of native's freshness window.
  for (const closed of recentlyClosedSessions) {
    const aiostreamsUserLower = (closed.aiostreamsUser || '').toLowerCase()
    let candidates = []
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)
    if (directMatch) {
      candidates = [directMatch]
    } else if (emailMatch) {
      candidates = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
    } else if (fallbackUserIds.length > 0) {
      candidates = fallbackUserIds.map((id) => usersById.get(id)).filter(Boolean)
    }
    // A closed stream can't be disambiguated by a live title match, so mark
    // the title as recently-carried for every candidate this login maps to.
    // That's deliberate: it only ever suppresses a native entry for THAT
    // exact title, which the proxy has confirmed ended.
    for (const candidate of candidates) {
      if (!recentlyClosedTitlesByUser.has(candidate.id)) recentlyClosedTitlesByUser.set(candidate.id, new Set())
      recentlyClosedTitlesByUser.get(candidate.id).add(normalizeTitle(closed.displayName))
    }
  }

  for (const np of watchSessionNowPlaying) {
    const uid = np.user && np.user.id
    const npTitle = normalizeTitle(np.item?.name)
    const activeTitles = uid ? coveredTitlesByUser.get(uid) : null
    const endedTitles = uid ? recentlyClosedTitlesByUser.get(uid) : null

    // Superseded when the proxy is currently carrying this title (the proxy
    // entry above replaces it), or recently finished carrying it (stale echo).
    const matches = (titles) =>
      !!titles && !!npTitle && Array.from(titles).some((t) => titlesMatch(t, npTitle))
    const isSuperseded = matches(activeTitles) || matches(endedTitles)
    if (!isSuperseded) result.push(np)
  }

  return result
}

module.exports = { mergeProxyNowPlaying }
