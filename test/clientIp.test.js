const test = require('node:test')
const assert = require('node:assert/strict')
const { visitorAddress, cloudflareClientIp } = require('../server/utils/clientIp')

test('a request from a Cloudflare server counts against the visitor behind it', () => {
  assert.equal(visitorAddress('172.70.1.2', '203.0.113.9', true), '203.0.113.9')
  assert.equal(visitorAddress('::ffff:162.158.10.1', '203.0.113.9', true), '203.0.113.9')
  assert.equal(visitorAddress('2606:4700::1', '2001:db8::5', true), '2001:db8::5')
})

test('the header is ignored from anywhere else, or when the switch is off', () => {
  assert.equal(visitorAddress('198.51.100.7', '203.0.113.9', true), '198.51.100.7', 'not Cloudflare')
  assert.equal(visitorAddress('172.70.1.2', '203.0.113.9', false), '172.70.1.2', 'switch off')
  assert.equal(visitorAddress('172.70.1.2', 'not-an-ip', true), '172.70.1.2', 'junk header')
  assert.equal(visitorAddress('172.70.1.2', undefined, true), '172.70.1.2', 'no header')
})

test('the middleware changes req.ip only when it should', () => {
  const run = (env, ip, header) => {
    const req = { ip, get: (h) => (h === 'cf-connecting-ip' ? header : undefined) }
    cloudflareClientIp({ env })(req, {}, () => {})
    return req.ip
  }
  assert.equal(run({ TRUST_CLOUDFLARE: 'true' }, '104.16.0.9', '203.0.113.9'), '203.0.113.9')
  assert.equal(run({}, '104.16.0.9', '203.0.113.9'), '104.16.0.9')
})
