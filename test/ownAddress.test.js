const test = require('node:test')
const assert = require('node:assert/strict')
const { learnOwnAddress, publicBase } = require('../server/utils/ownAddress')
const { gateProblem } = require('../server/utils/streamGate')

// An account's settings, read and written the way accountSync does.
function account(start = {}) {
  let sync = { ...start }
  const prisma = {
    appAccount: {
      findUnique: async () => ({ sync: JSON.stringify(sync) }),
      findFirst: async () => ({ sync: JSON.stringify(sync) }),
      update: async ({ data }) => { sync = typeof data.sync === 'string' ? JSON.parse(data.sync) : data.sync },
    },
  }
  return { prisma, get sync() { return sync } }
}

// An admin request reaching the API at `host`.
const visit = async (mw, host, { accountId = 'acc', path = '/users' } = {}) => {
  await new Promise((resolve) => mw({ appAccountId: accountId, path, protocol: 'https', get: (h) => (h === 'host' ? host : undefined) }, {}, resolve))
  await new Promise((r) => setTimeout(r, 20))
}

test('SlickSync learns the address an admin opens it from - never an internal one', async () => {
  delete process.env.PUBLIC_APP_URL
  const a = account({ observedBaseUrl: 'http://slicksync-1:3000' })
  const mw = learnOwnAddress(a.prisma)
  await visit(mw, 'localhost:3900')
  assert.equal(a.sync.observedBaseUrl, 'http://slicksync-1:3000', 'localhost is never learned')
  await visit(mw, 'slicksync.example.com')
  assert.equal(a.sync.observedBaseUrl, 'https://slicksync.example.com', 'a real address replaces the internal one')
  await visit(mw, '192.168.1.20:3000')
  assert.equal(a.sync.observedBaseUrl, 'https://slicksync.example.com', 'opening it at home by its network address doesn\'t replace the name')
  await visit(mw, 'new-domain.example.org')
  assert.equal(a.sync.observedBaseUrl, 'https://new-domain.example.org', 'a new domain is picked up on the first visit there')
})

test('an address typed in before learning existed is used until it has learned one; person pages teach nothing', async () => {
  const typed = account({ publicBaseUrl: 'https://typed.example.com' })
  assert.equal(await publicBase(typed.prisma, 'acc2'), 'https://typed.example.com')
  await visit(learnOwnAddress(typed.prisma), 'slicksync.example.com', { accountId: 'acc2' })
  assert.equal(await publicBase(typed.prisma, 'acc2'), 'https://slicksync.example.com')
  const fresh = account()
  await visit(learnOwnAddress(fresh.prisma), 'slicksync.example.com', { accountId: 'acc3', path: '/public-library/screen-time' })
  assert.equal(fresh.sync.observedBaseUrl, undefined)
  const internalOnly = account({ observedBaseUrl: 'http://slicksync-1:3000', publicBaseUrl: 'https://typed.example.com' })
  assert.equal(await publicBase(internalOnly.prisma, 'acc4'), 'https://typed.example.com', 'an internal learned address never wins over a usable typed one')
})

test('the Limits popup is told why the gate can\'t be used, in words', () => {
  assert.equal(gateProblem({ ok: true }), null)
  assert.match(gateProblem({ ok: false, reason: 'no-address' }), /doesn’t know the address/)
  assert.match(gateProblem({ ok: false, reason: 'internal-address', base: 'http://slicksync-1:3000' }), /only knows itself as slicksync-1:3000/)
  assert.match(gateProblem({ ok: false, reason: 'login', base: 'https://s.example.com' }), /sign-in page answers at s\.example\.com\/trax\//)
})
