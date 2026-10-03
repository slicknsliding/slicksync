// One "started watching" per viewing, whichever pipeline sees it first.
//
// The AIOStreams proxy and AIOStreams' own apps (through Watch State) can
// both report the same viewing starting: an Odin stream that also runs
// through the proxy reaches SlickSync twice, seconds apart. Each pipeline
// claims the start here before announcing it, and only the first claim for a
// person and title within the window wins.

const WINDOW_MS = 10 * 60 * 1000
const claims = new Map() // `${accountId}:${userId}:${itemId}` -> expiresAt

function claimStart(accountId, userId, itemId) {
  if (!userId || !itemId) return true
  const now = Date.now()
  for (const [key, expiresAt] of claims) if (expiresAt <= now) claims.delete(key)
  const key = `${accountId || 'default'}:${userId}:${itemId}`
  if (claims.has(key)) return false
  claims.set(key, now + WINDOW_MS)
  return true
}

module.exports = { claimStart, WINDOW_MS }
