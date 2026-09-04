// Request coalescing: when several people ask for the same thing at the same
// moment, do the upstream work ONCE and hand everyone the same answer.
//
// The case this exists for is movie night: two or three people open the same
// title's detail popup within a minute of each other, and today that is two
// or three identical Cinemeta/TMDb/OMDb round-trips, each spending quota.
// The same shape covers Discover's browse pages, where a household opening
// the app together produces a burst of identical catalog fetches.
//
// Deliberately tiny and dependency-free:
//   - In-flight requests share one promise (that's the "single flight").
//   - A finished result is held for a short TTL so a request arriving just
//     after completion is served from it rather than starting a new flight.
//   - Rejections are never cached; a failure must be retryable immediately.
//
// It is a cache of the SERVER's own upstream calls, not of user data: keys
// are built by the caller and must include everything that changes the
// answer (account scope included where results differ per account).

const inflight = new Map()
const settled = new Map()

// Bounded so a long-running instance can't accumulate keys forever; entries
// expire by TTL anyway, this just caps the pathological case.
const MAX_SETTLED = 500

function sweep() {
  const now = Date.now()
  for (const [key, entry] of settled) {
    if (entry.expiresAt <= now) settled.delete(key)
  }
  if (settled.size > MAX_SETTLED) {
    // Oldest-first eviction; Map preserves insertion order.
    const excess = settled.size - MAX_SETTLED
    let i = 0
    for (const key of settled.keys()) {
      if (i++ >= excess) break
      settled.delete(key)
    }
  }
}

/**
 * @param {string} key      identity of the work - same key = same answer
 * @param {number} ttlMs    how long a completed result stays reusable
 * @param {() => Promise<any>} work
 */
async function coalesce(key, ttlMs, work) {
  const now = Date.now()
  const done = settled.get(key)
  if (done && done.expiresAt > now) return done.value

  const running = inflight.get(key)
  if (running) return running

  const promise = (async () => {
    try {
      const value = await work()
      if (ttlMs > 0) {
        settled.set(key, { value, expiresAt: Date.now() + ttlMs })
        if (settled.size % 50 === 0) sweep()
      }
      return value
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

/** Drops a key's cached result - for when a write makes it stale. */
function invalidate(key) {
  settled.delete(key)
}

function stats() {
  return { inflight: inflight.size, settled: settled.size }
}

module.exports = { coalesce, invalidate, stats }
