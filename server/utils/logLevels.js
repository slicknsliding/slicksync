// What the server prints, by level.
//
// Errors always print. Ordinary progress lines (log/info) print only with
// NEXT_PUBLIC_DEBUG on, as before. Warnings used to be silenced along with
// them, which left anyone reading `docker logs` blind to the very messages
// meant for them (a sync that could not write, a backup that failed, a
// provider timing out). They now print, but the same warning is printed at
// most once a minute, with a count of the repeats it held back, so a warning
// inside a polling loop cannot flood the log.
//
// QUIET=true still silences everything except errors.

const WINDOW_MS = 60 * 1000
const MAX_KEYS = 500

function keyOf(args) {
  const first = args[0]
  const text = typeof first === 'string' ? first : (first?.message || String(first))
  return text.slice(0, 200)
}

function makeThrottledWarn(write, now = () => Date.now()) {
  const seen = new Map() // key -> { at, held }
  return (...args) => {
    const key = keyOf(args)
    const t = now()
    const entry = seen.get(key)
    if (entry && t - entry.at < WINDOW_MS) { entry.held++; return }
    if (entry?.held) write(...args, `(and ${entry.held} more like this in the last minute)`)
    else write(...args)
    if (seen.size >= MAX_KEYS && !entry) seen.delete(seen.keys().next().value)
    seen.set(key, { at: t, held: 0 })
  }
}

function applyLogLevels({ quiet, debug }) {
  const noop = () => {}
  if (quiet) {
    console.log = noop
    console.info = noop
    console.warn = noop
    return
  }
  if (!debug) {
    console.log = noop
    console.info = noop
    console.warn = makeThrottledWarn(console.warn.bind(console))
  }
}

module.exports = { applyLogLevels, makeThrottledWarn }
