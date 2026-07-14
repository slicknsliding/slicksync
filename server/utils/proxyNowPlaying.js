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

  for (const proxy of proxySessions) {
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
  }

  for (const np of watchSessionNowPlaying) {
    const uid = np.user && np.user.id
    if (!uid || !coveredUserIds.has(uid)) result.push(np)
  }

  return result
}

module.exports = { mergeProxyNowPlaying }
