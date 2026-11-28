// One addon sync at a time per person.
//
// A person's addons can be synced by the scheduler, Sync All, a group edit,
// an invitation, their own page and the Users page - and nothing stopped two
// of those running at once for the same person. Each reads the account,
// works out the list and writes it back, so two at once could each write a
// list worked out from what the other was about to replace. A second sync
// for someone now waits for the first to finish and then works from what the
// first one left, which is what a person would expect.
//
// Shutdown also uses this: it waits (briefly) for running syncs so a deploy
// does not stop a write halfway, and no sync starts once the stop signal has
// arrived (shutdownState.js).

const { isShuttingDown } = require('./shutdownState')

const queues = new Map() // key -> promise of the last sync queued for it
let running = 0
let idleWaiters = []

// What a sync asked for during shutdown gets: a wait that never ends. The
// process is about to go, so the caller is in the same place as if it had
// already gone. Answering with a failure instead would raise "sync failed"
// alerts for every person a restart happened to interrupt.
const NEVER = new Promise(() => {})

function settleIdle() {
  if (running !== 0) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve(true)
}

// Runs fn once every earlier sync for the same key has finished. Its result
// or error is passed through untouched; one sync failing never blocks the next.
function withPersonSync(key, fn) {
  // A sync started while the server is stopping would be cut off halfway,
  // and a part-written addon list is worse than a late one.
  if (isShuttingDown()) return NEVER
  const before = queues.get(key) || Promise.resolve()
  const run = before.catch(() => {}).then(async () => {
    // Was waiting its turn when the stop signal came: same answer.
    if (isShuttingDown()) return NEVER
    running++
    try {
      return await fn()
    } finally {
      running--
      settleIdle()
    }
  })
  const tail = run.catch(() => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}

// Resolves true once no sync is running, or false after timeoutMs.
function waitForSyncsIdle(timeoutMs) {
  if (running === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      idleWaiters = idleWaiters.filter((w) => w !== done)
      resolve(false)
    }, timeoutMs)
    const done = (v) => { clearTimeout(timer); resolve(v) }
    idleWaiters.push(done)
  })
}

const runningSyncs = () => running

// The key every writer to one person's addon list shares.
const personKey = (accountId, userId) => `${accountId || 'default'}:${userId}`

// For a route that reads a person's addon list, changes it and writes it back:
// the request takes its turn in that person's queue and gives it up when the
// answer has gone out. `keyOf(req)` names the person. A request that never
// answers gives its turn up after `maxMs`, so nothing can hold the queue for good.
function personLock(keyOf, maxMs = 90_000) {
  return (req, res, next) => {
    let key = null
    try { key = keyOf(req) } catch { key = null }
    if (!key) return next()
    // A change asked for while the server is stopping is turned away with a
    // plain answer, where it used to be started and then cut off.
    if (isShuttingDown()) {
      res.set('Retry-After', '15')
      return res.status(503).json({ message: 'SlickSync is restarting. Try again in a moment.' })
    }
    withPersonSync(key, () => new Promise((resolve) => {
      const timer = setTimeout(resolve, maxMs)
      const done = () => { clearTimeout(timer); resolve() }
      res.once('finish', done)
      res.once('close', done)
      next()
    })).catch(() => {})
  }
}

module.exports = { withPersonSync, waitForSyncsIdle, runningSyncs, personKey, personLock }
