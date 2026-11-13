const test = require('node:test')
const assert = require('node:assert')
const { withPersonSync, waitForSyncsIdle, runningSyncs } = require('../server/utils/syncLock')

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

test('syncs for the same person run one after another', async () => {
  const log = []
  const job = (name, ms) => async () => { log.push(`${name}:start`); await tick(ms); log.push(`${name}:end`); return name }
  const [a, b] = await Promise.all([withPersonSync('acct:p1', job('a', 30)), withPersonSync('acct:p1', job('b', 5))])
  assert.deepStrictEqual([a, b], ['a', 'b'])
  assert.deepStrictEqual(log, ['a:start', 'a:end', 'b:start', 'b:end'])
})

test('different people sync at the same time', async () => {
  const log = []
  const job = (name, ms) => async () => { log.push(`${name}:start`); await tick(ms); log.push(`${name}:end`) }
  await Promise.all([withPersonSync('acct:p2', job('a', 30)), withPersonSync('acct:p3', job('b', 5))])
  assert.deepStrictEqual(log.slice(0, 2).sort(), ['a:start', 'b:start'])
})

test('a failed sync passes its error through and does not block the next', async () => {
  const failed = withPersonSync('acct:p4', async () => { throw new Error('boom') })
  const next = withPersonSync('acct:p4', async () => 'ok')
  await assert.rejects(failed, /boom/)
  assert.strictEqual(await next, 'ok')
})

test('waitForSyncsIdle resolves when syncs finish, or false on timeout', async () => {
  assert.strictEqual(await waitForSyncsIdle(10), true)
  const long = withPersonSync('acct:p5', () => tick(60))
  await tick(1)
  assert.strictEqual(runningSyncs(), 1)
  assert.strictEqual(await waitForSyncsIdle(10), false)
  assert.strictEqual(await waitForSyncsIdle(500), true)
  await long
  assert.strictEqual(runningSyncs(), 0)
})
