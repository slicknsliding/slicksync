// Best-effort correlation: was a watch about to be written to
// MovieWatchHistory/EpisodeWatchHistory actually observed by the AIOStreams
// proxy, and if so, which debrid service resolved the stream? This is
// deliberately narrow in scope - CLAUDE.md's "the proxy must never write
// watch history or durations" rule is about presence/duration data leaking
// into History; this never touches durationSeconds or watchedAt, only adds
// an informational label, and only when BOTH a confident title+user+time
// correlation to a ProxyStreamSession is found AND that session's URL
// matches a known, confirmed debrid pattern. No match (unrecognized user,
// unrecognized title, or an unrecognized URL shape) means no label -
// never a guess.

const { resolveUserForActiveConnection } = require('./proxyStreamMonitor')

// 3 hours - same window metricsBuilder.js's mergeCrossPipelineDuplicates
// uses to correlate these same two pipelines for the Activity feed. The
// proxy's stream-open/close timestamps and the native pipeline's own
// watchedAt checkpoint can legitimately be that far apart.
const CORRELATION_WINDOW_MS = 3 * 60 * 60 * 1000

// Display names for recognized services. Keys are the values stored in
// MovieWatchHistory/EpisodeWatchHistory.debridService.
const DEBRID_LABELS = {
  torbox: 'TorBox',
}

function normalizeTitle(name) {
  return (name || '').toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Only confirmed URL shapes are recognized - verified against real
// ProxyStreamSession.url values captured on a live instance (see
// scripts/debug-proxy-sessions.js), not from a resolver addon's documented
// conventions alone. Add a new pattern only once you've confirmed it the
// same way - a wrong guess here shows up as a factual-looking label on
// someone's watch history.
function detectDebridService(url) {
  if (!url) return null
  // Torrentio-style: https://<host>/resolve/torbox/<hash>/...
  if (/\/resolve\/torbox\//i.test(url)) return 'torbox'
  // StremThru-style: https://<host>/stremio/torz/<b64>/_/strem/<id>/tb/<hash>/...
  // "tb" is StremThru's own short code for TorBox, appearing as a plain
  // path segment right after the video/item ID.
  if (/\/strem\/[^/]+\/tb\//i.test(url)) return 'torbox'
  return null
}

// Looks for a ProxyStreamSession that plausibly corresponds to the watch
// about to be recorded. Matches on normalized title text (exact, or the
// proxy's own longer filename-derived title starting with it) within a
// wide time window, confirmed against the SAME user via
// resolveUserForActiveConnection - a title match alone isn't enough, since
// two users could plausibly watch the same title within the window.
// itemId/videoId are deliberately NOT used as a join key:
// ProxyStreamSession.metadataItemId comes from a fuzzy Cinemeta title
// search (see proxyStreamMonitor.js's attemptPosterLookup), not a verified
// match to the native pipeline's own item ID, so it isn't trustworthy here.
async function findDebridServiceForWatch(prisma, { accountId, userId, title, watchedAt, users }) {
  if (!title || !watchedAt || !Array.isArray(users) || users.length === 0) return null
  try {
    const windowStart = new Date(watchedAt.getTime() - CORRELATION_WINDOW_MS)
    const windowEnd = new Date(watchedAt.getTime() + CORRELATION_WINDOW_MS)
    const candidates = await prisma.proxyStreamSession.findMany({
      where: {
        accountId,
        lastSeenAt: { gte: windowStart },
        startTime: { lte: windowEnd },
      },
      select: { aiostreamsUser: true, url: true, displayName: true, filename: true },
    })
    if (candidates.length === 0) return null

    const wantTitle = normalizeTitle(title)
    if (!wantTitle) return null

    for (const candidate of candidates) {
      const candidateTitle = normalizeTitle(candidate.displayName || candidate.filename)
      if (!candidateTitle) continue
      const isMatch = candidateTitle === wantTitle || candidateTitle.startsWith(`${wantTitle} `)
      if (!isMatch) continue

      const resolvedUser = resolveUserForActiveConnection(users, candidate.aiostreamsUser)
      if (!resolvedUser || resolvedUser.id !== userId) continue

      const service = detectDebridService(candidate.url)
      if (service) return service
    }
    return null
  } catch (error) {
    console.warn('[DebridDetection] Correlation lookup failed:', error.message)
    return null
  }
}

module.exports = { detectDebridService, findDebridServiceForWatch, DEBRID_LABELS }
