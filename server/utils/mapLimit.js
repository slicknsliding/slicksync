/**
 * Run an async function over a list with a ceiling on how many are in
 * flight, keeping the results in the order the inputs were given.
 *
 * The pattern this replaces is a plain `for` loop that awaits a network
 * call per item. That is correct but serial: every item waits for the one
 * before it, so a list of forty pays forty round trips end to end, and any
 * item that has to wait out a timeout stalls everything behind it. The
 * limit exists so the cure is not its own problem - forty simultaneous
 * requests to one upstream is a good way to be rate-limited.
 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [...items]
  const results = new Array(list.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= list.length) return
      results[i] = await fn(list[i], i)
    }
  }
  // Every worker is allowed to finish before a failure is raised. With a
  // plain Promise.all the first rejection returns immediately and leaves the
  // other workers running against a result nobody will read - in-flight
  // requests nothing is waiting for. Both of today's callers hand in a
  // function that cannot throw, so this only matters for the next one.
  const workers = Math.max(1, Math.min(limit, list.length))
  const settled = await Promise.allSettled(Array.from({ length: workers }, worker))
  const failed = settled.find((s) => s.status === 'rejected')
  if (failed) throw failed.reason
  return results
}

module.exports = { mapLimit }
