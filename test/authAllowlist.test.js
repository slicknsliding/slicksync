const test = require('node:test')
const assert = require('node:assert/strict')
const { pathIsAllowlisted } = require('../server/utils/auth')

test('without a login, /api/health answers health checks only; its other routes stay gated', () => {
  assert.equal(pathIsAllowlisted('/api/health/build'), true)
  assert.equal(pathIsAllowlisted('/health'), true)
  // Reachable for health checks, but answers only "ok" without a login.
  assert.equal(pathIsAllowlisted('/api/health'), true)
  assert.equal(pathIsAllowlisted('/api/healthz'), false)
  assert.equal(pathIsAllowlisted('/api/health/proxy-ignore'), false)
})
