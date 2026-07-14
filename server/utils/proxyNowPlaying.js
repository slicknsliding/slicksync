// Merges AIOStreams proxy-detected active streams (ProxyStreamSession) into
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
  // Secondary match: local-part of email (e.g. "slicknslidin" from
  // "someuser@example.com"). Handles the common case where one
  // AIOStreams login covers multiple per-provider SlickSync profiles that
  // share the same email but have provider-specific usernames (e.g. "SLICK
  // STREMIO", "NuvioSLICK") that don't match the AIOStreams username at all.
  const userByEmailLocalPart = new Map(
    users
      .filter((u) => u.email && u.email.includes('@'))
      .map((u) => [u.email.split('@')[0].toLowerCase(), u])
  )
  const watchSessionByUserId = new Map(
    watchSessionNowPlaying.filter((np) => np.user && np.user.id).map((np) => [np.user.id, np])
  )

  const result = []
  const coveredUserIds = new Set()

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
      watchedAt: earliestStartTime.toISOString(),
      watchedAtTimestamp: earliestStartTime.getTime(),
      startTime: earliestStartTime,
      // Most recent connection's own start time (e.g. when the last seek
      // happened) - kept separately, not used for duration display.
      lastConnectionStartTime: representative.startTime.toISOString(),
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
