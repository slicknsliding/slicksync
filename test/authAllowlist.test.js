const test = require('node:test')
const assert = require('node:assert/strict')
const { pathIsAllowlisted } = require('../server/utils/auth')

test('only the build stamp of /api/health is open without a login', () => {
  assert.equal(pathIsAllowlisted('/api/health/build'), true)
  assert.equal(pathIsAllowlisted('/health'), true)
  assert.equal(pathIsAllowlisted('/api/health'), false)
  assert.equal(pathIsAllowlisted('/api/health/'), false)
  assert.equal(pathIsAllowlisted('/api/health/proxy-ignore'), false)
})
