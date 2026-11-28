// Whether the server has been told to stop.
//
// On every update the container gets a stop signal and a few seconds to
// finish what is in flight (index.js). Background jobs used to keep starting
// in that window - a scheduled sync, a backup, an alert check - and whatever
// started there was cut off partway when the process ended. Three things
// read this flag so nothing new begins once the signal has arrived:
//
//  - every repeating timer: guardRepeatingJobs() swaps the global
//    setInterval for one whose ticks do nothing during shutdown, so a job
//    added later is covered without anyone having to remember this file;
//  - the per-person sync queue (syncLock.js), whoever asked for the sync;
//  - the few jobs that re-arm a one-shot timer instead (backups, access
//    expiry), which check it themselves.
//
// Work already running is left alone: it uses one-shot timers for its own
// waits and time limits, and those keep working.

let shuttingDown = false

const isShuttingDown = () => shuttingDown

function markShuttingDown() {
  shuttingDown = true
}

let realSetInterval = null

// Called once at boot, before any job is scheduled.
function guardRepeatingJobs() {
  if (realSetInterval) return
  realSetInterval = global.setInterval
  const real = realSetInterval
  global.setInterval = function guardedSetInterval(fn, ...rest) {
    if (typeof fn !== 'function') return real(fn, ...rest)
    return real(function tick(...args) {
      if (shuttingDown) return undefined
      return fn.apply(this, args)
    }, ...rest)
  }
}

// Tests only: back to a server that is running, with the real setInterval.
function resetForTests() {
  shuttingDown = false
  if (realSetInterval) {
    global.setInterval = realSetInterval
    realSetInterval = null
  }
}

module.exports = { isShuttingDown, markShuttingDown, guardRepeatingJobs, resetForTests }
