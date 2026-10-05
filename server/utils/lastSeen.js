// When each person was last seen watching anything, from SlickSync's own
// records - worked out when the page asks, never stored (a column would be a
// schema change, and every pipeline would have to remember to write it).
//
// Deliberately NOT the Jellyfin server's LastActivityDate: SlickSync reads
// each person's server with their own sign-in, and that read moves the date,
// so everyone would look active all the time.
//
// Sources, newest wins:
// - WatchActivity.createdAt - every positive watch-time delta (the day column
//   is a bucket, not a time).
// - Movie/EpisodeWatchHistory.watchedAt - History, including bulk "played".
// - WatchSession.startTime - a native viewing SlickSync noticed.
// - ProxyStreamSession.lastSeenAt - the proxy's own login name, matched to a
//   person the same way Now Playing does (an ambiguous name counts for nobody).
// - WatchSnapshot.lastWatched - the app's own "last watched" time for each
//   title, as SlickSync last read it from their Stremio or Nuvio library (or
//   a Jellyfin server's last-played date). Something watched only part-way,
//   or first seen after a sign-in had expired, leaves no History row and no
//   watch time, so without this "last seen" lagged the app's own record.

const { resolveUserForActiveConnection } = require('./proxyStreamMonitor')

const latest = (a, b) => (!a ? b : !b ? a : (b > a ? b : a))

async function maxBy(model, accountId, userIds, field) {
  const rows = await model.groupBy({
    by: ['userId'],
    where: { accountId, userId: { in: userIds } },
    _max: { [field]: true },
  })
  return rows.map((r) => [r.userId, r._max?.[field] ? new Date(r._max[field]) : null])
}

/**
 * @param {object} prisma
 * @param {string} accountId
 * @param {{id: string, username?: string|null, email?: string|null}[]} users
 * @returns {Promise<Map<string, Date>>} only people with any record
 */
async function lastSeenByUser(prisma, accountId, users) {
  const out = new Map()
  if (!Array.isArray(users) || users.length === 0) return out
  const ids = users.map((u) => u.id)
  const note = (userId, when) => {
    if (!userId || !when || Number.isNaN(when.getTime())) return
    out.set(userId, latest(out.get(userId), when))
  }

  const lists = await Promise.all([
    maxBy(prisma.watchActivity, accountId, ids, 'createdAt'),
    maxBy(prisma.movieWatchHistory, accountId, ids, 'watchedAt'),
    maxBy(prisma.episodeWatchHistory, accountId, ids, 'watchedAt'),
    maxBy(prisma.watchSession, accountId, ids, 'startTime'),
    maxBy(prisma.watchSnapshot, accountId, ids, 'lastWatched'),
  ].map((p) => p.catch((error) => {
    console.warn('[LastSeen] a source failed:', error.message)
    return []
  })))
  for (const list of lists) for (const [userId, when] of list) note(userId, when)

  try {
    const proxy = await prisma.proxyStreamSession.groupBy({
      by: ['aiostreamsUser'],
      where: { accountId },
      _max: { lastSeenAt: true },
    })
    for (const row of proxy) {
      const user = resolveUserForActiveConnection(users, row.aiostreamsUser)
      if (user && row._max?.lastSeenAt) note(user.id, new Date(row._max.lastSeenAt))
    }
  } catch (error) {
    console.warn('[LastSeen] proxy streams failed:', error.message)
  }

  // A clock running ahead somewhere must not read as "seen in the future".
  const now = new Date()
  for (const [userId, when] of out) if (when > now) out.set(userId, now)
  return out
}

/** One person's last seen, or null. Matches proxy names against everyone on
 *  the account, so a name two people could own counts for neither - the same
 *  answer the Users list gives. */
async function lastSeenFor(prisma, accountId, userId) {
  const users = await prisma.user.findMany({ where: { accountId }, select: { id: true, username: true, email: true } })
  return (await lastSeenByUser(prisma, accountId, users)).get(userId) || null
}

module.exports = { lastSeenByUser, lastSeenFor }
