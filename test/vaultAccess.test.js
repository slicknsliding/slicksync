// A Vault key's History and the show/copy limit (server/utils/vaultAccess.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const va = require('../server/utils/vaultAccess')

test('the device reads as browser on system', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
  const fx = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  assert.equal(va.deviceFromUserAgent(win), 'Chrome on Windows')
  assert.equal(va.deviceFromUserAgent(iphone), 'Safari on iPhone')
  assert.equal(va.deviceFromUserAgent(edge), 'Edge on Windows')
  assert.equal(va.deviceFromUserAgent(fx), 'Firefox on Linux')
  assert.equal(va.deviceFromUserAgent(android), 'Chrome on Android')
  assert.equal(va.deviceFromUserAgent('curl/8.5.0'), 'A script')
  assert.equal(va.deviceFromUserAgent(''), null)
})

test('the address drops the IPv6 wrapper', () => {
  assert.equal(va.clientAddress({ ip: '::ffff:203.0.113.24' }), '203.0.113.24')
  assert.equal(va.clientAddress({ ip: '2001:db8::1' }), '2001:db8::1')
})

test('showing and copying stop after the limit, per account, and come back after the window', () => {
  va.resetRevealSlots()
  const t0 = 1_000_000
  for (let i = 0; i < va.REVEAL_LIMIT; i++) assert.equal(va.takeRevealSlot('a', t0 + i), true)
  assert.equal(va.takeRevealSlot('a', t0 + 100), false)
  assert.equal(va.takeRevealSlot('b', t0 + 100), true, 'another account is not affected')
  assert.equal(va.takeRevealSlot('a', t0 + va.REVEAL_WINDOW_MS + 50), true)
  va.resetRevealSlots()
})

test('recording keeps only known actions and never throws', async () => {
  const made = []
  const prisma = { vaultAccessLog: { create: async ({ data }) => { made.push(data) }, deleteMany: async () => ({ count: 0 }) } }
  const req = { ip: '203.0.113.9', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' } }
  await va.recordVaultAccess(prisma, { accountId: 'acc', entryId: 'e1', action: 'copied', req })
  await va.recordVaultAccess(prisma, { accountId: 'acc', entryId: 'e1', action: 'peeked', req })
  await va.recordVaultAccess(prisma, { accountId: 'acc', entryId: 'e1', action: 'swapped' })
  assert.equal(made.length, 2)
  assert.deepEqual(made[0], { accountId: 'acc', entryId: 'e1', action: 'copied', device: 'Safari on Mac', ip: '203.0.113.9' })
  assert.equal(made[1].device, null)
  await va.recordVaultAccess({ vaultAccessLog: { create: async () => { throw new Error('db down') } } }, { entryId: 'e1', action: 'shown' })
})
