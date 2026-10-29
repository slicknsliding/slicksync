// A sync only ever reaches a person of the caller's own account. On an instance
// serving strangers, Sync All and a person's Sync used to load the person by id
// alone and build their provider from the caller's settings - so one household
// could sync another's people and have their Nuvio sign-in sent to a backend it
// chose.
const test = require('node:test')
const assert = require('node:assert/strict')

const { syncUserAddons } = require('../server/routes/users')

function fakePrisma(rows) {
  const lookups = []
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v)
  return {
    lookups,
    user: {
      findFirst: async ({ where }) => { lookups.push(where); return rows.find((r) => matches(r, where)) || null },
      update: async () => { throw new Error('nothing should be written') },
    },
  }
}

test('a person of another account is not found, and nothing is fetched or written', async (t) => {
  const realFetch = global.fetch
  const fetched = []
  global.fetch = async (url) => { fetched.push(String(url)); throw new Error('no network in this test') }
  t.after(() => { global.fetch = realFetch })
  const prisma = fakePrisma([{ id: 'victim', accountId: 'acctB', isActive: true, providerType: 'nuvio', username: 'victim' }])
  const req = { appAccountId: 'acctA', headers: {} }
  const result = await syncUserAddons(prisma, 'victim', [], false, req, (v) => v, () => 'acctA', true)
  assert.equal(result.success, false)
  assert.equal(result.error, 'User not found')
  assert.ok(prisma.lookups.every((w) => w.accountId === 'acctA'), 'every lookup is bound to the caller\'s account')
  assert.deepEqual(fetched, [])
})

test('with no account to bind to, nobody is found', async () => {
  const prisma = fakePrisma([{ id: 'someone', accountId: 'acctB', isActive: true }])
  const result = await syncUserAddons(prisma, 'someone', [], false, { headers: {} }, (v) => v, () => null, true)
  assert.equal(result.error, 'User not found')
  assert.deepEqual(prisma.lookups, [])
})
