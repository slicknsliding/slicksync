// Once the stop signal has arrived nothing new starts: repeating timers do
// nothing, no sync begins (asked for directly or waiting its turn), and a
// change asked for through a route is turned away with a plain answer.
const test = require('node:test')
const assert = require('node:assert/strict')
const shutdownState = require('../server/utils/shutdownState')
const { withPersonSync, personLock, runningSyncs } = require('../server/utils/syncLock')

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
// "Did this settle within ms?" for a promise that is meant to stay pending.
const settledWithin = (promise, ms) => Promise.race([promise.then(() => true, () => true), tick(ms).then(() => false)])
// Timers are coarse on some machines, so wait for the ticks, not for a time.
async function until(condition, ms = 2000) {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await tick(5)
  return condition()
}

test.afterEach(() => shutdownState.resetForTests())

test('a repeating job ticks until the stop signal, then does nothing', async () => {
  const real = global.setInterval
  shutdownState.guardRepeatingJobs()
  assert.notEqual(global.setInterval, real)
  let runs = 0
  const timer = setInterval(() => { runs++ }, 5)
  try {
    assert.ok(await until(() => runs >= 2), `ticked ${runs} times before the signal`)
    shutdownState.markShuttingDown()
    const before = runs
    assert.equal(shutdownState.isShuttingDown(), true)
    await tick(80)
    assert.equal(runs, before)
  } finally {
    clearInterval(timer)
  }
  shutdownState.resetForTests()
  assert.equal(global.setInterval, real)
  assert.equal(shutdownState.isShuttingDown(), false)
})

test('the guarded timer passes arguments through and can still be cleared or unref-ed', async () => {
  shutdownState.guardRepeatingJobs()
  const seen = []
  const timer = setInterval((a, b) => { seen.push([a, b]) }, 5, 'x', 2)
  assert.equal(typeof timer.unref, 'function')
  assert.ok(await until(() => seen.length >= 1))
  clearInterval(timer)
  const count = seen.length
  assert.deepEqual(seen[0], ['x', 2])
  await tick(60)
  assert.equal(seen.length, count)
})

test('guarding twice keeps the real timer to go back to', () => {
  const real = global.setInterval
  shutdownState.guardRepeatingJobs()
  const guarded = global.setInterval
  shutdownState.guardRepeatingJobs()
  assert.equal(global.setInterval, guarded)
  shutdownState.resetForTests()
  assert.equal(global.setInterval, real)
})

test('no sync starts once the stop signal has arrived, and none is reported as failed', async () => {
  shutdownState.markShuttingDown()
  let started = false
  const asked = withPersonSync('acct:s1', async () => { started = true })
  assert.equal(await settledWithin(asked, 30), false)
  assert.equal(started, false)
  assert.equal(runningSyncs(), 0)
})

test('a sync waiting its turn when the signal comes does not start; the running one finishes', async () => {
  const log = []
  const first = withPersonSync('acct:s2', async () => { log.push('first:start'); await tick(30); log.push('first:end'); return 'done' })
  const second = withPersonSync('acct:s2', async () => { log.push('second:start') })
  await tick(5)
  shutdownState.markShuttingDown()
  assert.equal(await first, 'done')
  assert.equal(await settledWithin(second, 30), false)
  assert.deepEqual(log, ['first:start', 'first:end'])
  assert.equal(runningSyncs(), 0)
})

test('a change asked for through a route during shutdown gets a plain "restarting" answer', () => {
  shutdownState.markShuttingDown()
  const answer = {}
  const res = {
    set: (name, value) => { answer.header = [name, value] },
    status: (code) => { answer.status = code; return res },
    json: (body) => { answer.body = body; return res },
    once: () => {},
  }
  let wentOn = false
  personLock(() => 'acct:s3')({}, res, () => { wentOn = true })
  assert.equal(wentOn, false)
  assert.equal(answer.status, 503)
  assert.deepEqual(answer.header, ['Retry-After', '15'])
  assert.match(answer.body.message, /restarting/i)
})

test('while the server is running the route lock still lets the request through', async () => {
  const handlers = {}
  const res = { once: (name, fn) => { handlers[name] = fn } }
  let wentOn = false
  personLock(() => 'acct:s4')({}, res, () => { wentOn = true })
  await tick(5)
  assert.equal(wentOn, true)
  handlers.finish()
  await tick(5)
  assert.equal(runningSyncs(), 0)
})
