/*
 * A CONNECTION IS NOT A VIEWING UNTIL IT ASKS TWICE.
 *
 * Apps open a source for reasons other than playing it: some warm the top
 * few sources up while a title's page is being read - a two-byte range
 * request to each, so the one that is pressed starts sooner - and some
 * check a source answers before listing it. Each of those is one request
 * through the proxy and then nothing, and each was announced here as
 * "started watching", appeared in Now Playing and flagged a sync mismatch -
 * three at once for one page opened, measured: three different files of the
 * same episode, opened within 2ms, one request each.
 *
 * A player never stops at one: it reads the header, then the index or the
 * part it needs, within seconds (every real viewing in the same record made
 * 2 to 1,144 requests). So a connection counts as playing from its second
 * request. Every connection is still recorded; only what is announced,
 * listed as playing and compared against the library waits for that.
 *
 * Read by proxyStreamMonitor.js (the notification), proxyNowPlaying.js (Now
 * Playing) and watchSyncMismatch.js (the mismatch warning).
 */
const MIN_PLAYING_REQUESTS = 2

function isPlayingConnection(requestCount) {
  return Number(requestCount || 0) >= MIN_PLAYING_REQUESTS
}

module.exports = { MIN_PLAYING_REQUESTS, isPlayingConnection }
