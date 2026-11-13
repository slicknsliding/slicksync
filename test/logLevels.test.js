const test = require('node:test')
const assert = require('node:assert')
const { makeThrottledWarn } = require('../server/utils/logLevels')

test('the same warning prints once a minute, then reports what it held back', () => {
  let t = 0
  const out = []
  const warn = makeThrottledWarn((...a) => out.push(a.join(' ')), () => t)
  warn('Provider timed out', 'x')
  warn('Provider timed out', 'y')
  warn('Provider timed out', 'z')
  warn('Something else')
  assert.deepStrictEqual(out, ['Provider timed out x', 'Something else'])
  t = 61 * 1000
  warn('Provider timed out', 'w')
  assert.strictEqual(out[2], 'Provider timed out w (and 2 more like this in the last minute)')
  warn('Provider timed out')
  assert.strictEqual(out.length, 3)
})

test('errors passed as the first argument are keyed by their message', () => {
  const out = []
  const warn = makeThrottledWarn((...a) => out.push(a), () => 0)
  warn(new Error('boom'))
  warn(new Error('boom'))
  warn(new Error('other'))
  assert.strictEqual(out.length, 2)
})
