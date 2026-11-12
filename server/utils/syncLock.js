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
// does not stop a write halfway.

const queues = new Map() // key -> promise of the last sync queued for it
let running = 0
let idleWaiters = []

function settleIdle() {
  if (running !== 0) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve(true)
}

// Runs fn once every earlier sync for the same key has finished. Its result
// or error is passed through untouched; one sync failing never blocks the next.
function withPersonSync(key, fn) {
  const before = queues.get(key) || Promise.resolve()
  const run = before.catch(() => {}).then(async () => {
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

module.exports = { withPersonSync, waitForSyncsIdle, runningSyncs }
