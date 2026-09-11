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
  const workers = Math.max(1, Math.min(limit, list.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

module.exports = { mapLimit }
