// Live-update channel (SSE): a tiny in-process event bus plus the request
// handler that streams it to browsers as text/event-stream.
//
// Deliberately an ACCELERANT, not a replacement: every consumer keeps its
// existing polling exactly as it was, and an event only tells the client
// "refetch now instead of waiting for your next tick". So a dropped
// connection, a proxy that buffers, or a browser without EventSource
// degrades to precisely the behavior the app has always had - nothing new
// can break by this channel failing. Events carry TYPE only, never data:
// the client refetches through the same authenticated endpoints it already
// uses, so this stream can't become a second, subtly-different data path.
//
// index.js's compression middleware explicitly skips text/event-stream -
// a gzip window would buffer events instead of delivering them.

const { EventEmitter } = require('events')

const bus = new EventEmitter()
// One listener per open browser tab; a household with several devices and
// tabs is still far under this, but don't warn-spam if someone leaves a
// wall of tabs open.
bus.setMaxListeners(200)

const HEARTBEAT_MS = 25 * 1000 // keeps idle connections alive through proxies (Traefik's default timeouts included)

/** Fire an event at every connected client of one account. Fire-and-forget
 * by design - callers never await or depend on delivery. */
function emitLive(accountId, type) {
  try {
    bus.emit('live', { accountId: accountId || 'default', type })
  } catch { /* a listener throwing must never break the caller */ }
}

/** Express handler for GET /api/events. Auth has already run (mounted after
 * the auth gate); getAccountId scopes which events this connection sees. */
function handleEventsRequest(req, res, getAccountId) {
  const accountId = getAccountId(req) || 'default'
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  res.write(': connected\n\n')

  const onEvent = (evt) => {
    if (evt.accountId !== accountId) return
    try { res.write(`data: ${JSON.stringify({ type: evt.type })}\n\n`) } catch { /* closed mid-write */ }
  }
  bus.on('live', onEvent)

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { /* closed */ }
  }, HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeat)
    bus.off('live', onEvent)
  })
}

module.exports = { emitLive, handleEventsRequest }
