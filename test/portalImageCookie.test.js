const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { portalImageCookie } = require('../server/utils/portalImageCookie')
const { checkAccountClaims } = require('../server/utils/auth')

const SECRET = 'portal-image-test-secret'
const people = { p1: { isActive: true, accountId: 'acc1' }, p2: { isActive: false, accountId: 'acc1' } }
const prisma = { user: { findUnique: async ({ where }) => people[where.id] || null } }

test('opens only the two picture routes', () => {
  assert.ok(portalImageCookie.covers('/api/img'))
  assert.ok(portalImageCookie.covers('/api/poster/tt123'))
  for (const p of ['/api/imgx', '/api/users', '/api/posters', '/api/public-library/user-info']) assert.equal(portalImageCookie.covers(p), false, p)
})

test('names the account while the person is switched on', async () => {
  assert.equal(await portalImageCookie.account(portalImageCookie.sign('p1', 'acc1', SECRET), SECRET, prisma), 'acc1')
  assert.equal(await portalImageCookie.account(portalImageCookie.sign('p2', 'acc1', SECRET), SECRET, prisma), null, 'switched off')
  assert.equal(await portalImageCookie.account(portalImageCookie.sign('p1', 'acc9', SECRET), SECRET, prisma), null, 'another account')
  assert.equal(await portalImageCookie.account(portalImageCookie.sign('nobody', 'acc1', SECRET), SECRET, prisma), null)
  assert.equal(await portalImageCookie.account(portalImageCookie.sign('p1', 'acc1', 'other-secret'), SECRET, prisma), null, 'forged')
  assert.equal(await portalImageCookie.account(jwt.sign({ sub: 'p1', acc: 'acc1' }, SECRET), SECRET, prisma), null, 'not a picture cookie')
})

test('can never pass as an account sign-in', () => {
  const claims = jwt.verify(portalImageCookie.sign('p1', 'acc1', SECRET), SECRET)
  assert.throws(() => checkAccountClaims(claims, ['access']))
})
