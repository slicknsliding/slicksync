/*
 * A CONNECTION IS NOT A VIEWING UNTIL DATA KEEPS FLOWING.
 *
 * Apps open sources for reasons other than playing them: Nuvio warms up the
 * top few sources while a title's page is open, so the one that is pressed
 * starts sooner, and some apps check a source answers before listing it.
 * Each of those used to be announced as "started watching", appear in Now
 * Playing and flag a sync mismatch - several at once for one page opened.
 *
 * Counting requests (the first attempt: "playing from the second request")
 * isn't enough. A warm-up of a Matroska file reads the start and then the
 * index at the end - two requests in two or three seconds - and some players
 * stream a whole film over a single long request. Measured on a real
 * household's 400 most recent connections: the two warm-ups that fooled Now
 * Playing carried data for 2 and 3 seconds; Nuvio's longest warm-ups ran
 * about 20 seconds; real viewings ran 461 to 3,394 seconds, some with only 3
 * requests.
 *
 * So a connection counts as playing once data has kept flowing through it
 * for MIN_PLAYING_SECONDS - AIOStreams moves lastSeenAt with every chunk it
 * serves, so lastSeenAt - startTime is how long it has carried data. Older
 * AIOStreams builds only moved it per request; a connection with
 * MANY_REQUESTS requests counts too, which no warm-up comes near. Paused
 * playback keeps counting: the time it already played doesn't go away.
 *
 * Every connection is still recorded (the Proxy tab lists them all); only
 * what is announced, listed as playing and compared against the library
 * waits for this. Read by proxyStreamMonitor.js (the notification),
 * proxyNowPlaying.js (Now Playing) and watchSyncMismatch.js (the mismatch
 * warning).
 */
const MIN_PLAYING_SECONDS = 45
const MANY_REQUESTS = 20

/** conn: a ProxyStreamSession row ({ requestCount, startTime, lastSeenAt }) or a polled stream ({ requests, startedAt, lastSeenAt }). */
function isPlayingConnection(conn) {
  if (!conn || typeof conn !== 'object') return false
  const requests = Number(conn.requestCount ?? conn.requests ?? 0)
  if (requests >= MANY_REQUESTS) return true
  const start = new Date(conn.startTime ?? conn.startedAt).getTime()
  const last = new Date(conn.lastSeenAt ?? conn.startTime ?? conn.startedAt).getTime()
  return Number.isFinite(start) && Number.isFinite(last) && last - start >= MIN_PLAYING_SECONDS * 1000
}

module.exports = { MIN_PLAYING_SECONDS, MANY_REQUESTS, isPlayingConnection }
