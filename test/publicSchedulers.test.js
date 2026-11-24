// Background jobs on a public instance are started with no account
// (index.js schedulerReq.appAccountId is undefined there). The monthly poster
// recap and the Sync Guardian used to run once with that missing account: the
// recap's account lookup failed every 6 hours, and the Guardian looked people
// up without an account, so neither ever ran for anyone on a public instance.
const test = require('node:test')
const assert = require('node:assert/strict')
const { scheduleMosaicMonitor } = require('../server/utils/posterMosaic')
const { scheduleSyncGuardian, clearSyncGuardian } = require('../server/utils/syncGuardian')

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

// Records every query. Accounts honor a `disabled` filter; everything else
// answers empty.
function fakePrisma(accounts, overrides = {}) {
  const calls = []
  const model = (name) => new Proxy({}, {
    get: (_, method) => {
      if (method === 'then') return undefined
      return async (args = {}) => {
        calls.push({ model: name, method, args })
        const custom = overrides[`${name}.${method}`]
        if (custom) return custom(args)
        if (name === 'appAccount' && method === 'findMany') {
          const where = args.where || {}
          return accounts
            .filter((a) => where.disabled === undefined || !!a.disabled === where.disabled)
            .map((a) => ({ id: a.id, sync: a.sync }))
        }
        if (name === 'appAccount' && (method === 'findUnique' || method === 'findFirst')) {
          const a = accounts.find((x) => x.id === args.where?.id)
          return a ? { sync: a.sync } : null
        }
        if (method === 'findMany') return []
        if (method === 'count') return 0
        return null
      }
    },
  })
  const prisma = new Proxy({}, {
    get: (_, name) => {
      if (name === 'then') return undefined
      if (name === '$transaction') return async (fn) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))
      return model(name)
    },
  })
  return { prisma, calls }
}

// A query with an account field present but empty would cover every account.
const withoutAccount = (calls) => calls.filter(({ args }) => {
  const w = args?.where
  return w && (('id' in w && w.id === undefined) || ('accountId' in w && w.accountId === undefined))
})

const ACCOUNTS = [
  { id: 'acct-1', sync: { notifyOnMosaic: true } },
  { id: 'acct-2', sync: { notifyOnMosaic: false } },
  { id: 'acct-3', disabled: true, sync: { notifyOnMosaic: true } },
]

test('public: the monthly poster recap runs for each account on its own', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { prisma, calls } = fakePrisma(ACCOUNTS)
  scheduleMosaicMonitor(prisma, undefined)
  await flush()

  assert.deepEqual(withoutAccount(calls), [], 'no query without an account')
  const looked = calls.filter((c) => c.model === 'appAccount' && c.method === 'findUnique').map((c) => c.args.where.id)
  assert.deepEqual([...new Set(looked)].sort(), ['acct-1', 'acct-2'], 'each switched-on account read its own settings')
  const built = calls.filter((c) => c.model === 'movieWatchHistory').map((c) => c.args.where.accountId)
  assert.deepEqual(built, ['acct-1'], 'only the account with the recap turned on gathered its month')
})

test('private: the monthly poster recap checks the one household only', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { prisma, calls } = fakePrisma([{ id: 'default', sync: { notifyOnMosaic: true } }])
  scheduleMosaicMonitor(prisma, 'default')
  await flush()

  assert.equal(calls.filter((c) => c.model === 'appAccount' && c.method === 'findMany').length, 0, 'no account list on private')
  const built = calls.filter((c) => c.model === 'movieWatchHistory').map((c) => c.args.where.accountId)
  assert.deepEqual(built, ['default'])
})

test('public: Sync Guardian checks each account\'s own people', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { prisma, calls } = fakePrisma(ACCOUNTS)
  scheduleSyncGuardian(prisma, {}, undefined)
  await flush()
  clearSyncGuardian()

  assert.deepEqual(withoutAccount(calls), [], 'no query without an account')
  const people = calls.filter((c) => c.model === 'user' && c.method === 'findMany').map((c) => c.args.where.accountId)
  assert.deepEqual(people.sort(), ['acct-1', 'acct-2'], 'switched-off accounts are left alone')
})

test('private: Sync Guardian checks the one household only', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { prisma, calls } = fakePrisma([{ id: 'default', sync: {} }])
  scheduleSyncGuardian(prisma, {}, 'default')
  await flush()
  clearSyncGuardian()

  assert.equal(calls.filter((c) => c.model === 'appAccount' && c.method === 'findMany').length, 0)
  const people = calls.filter((c) => c.model === 'user' && c.method === 'findMany').map((c) => c.args.where.accountId)
  assert.deepEqual(people, ['default'])
})

test('Sync Guardian does not start a second pass while one is still going', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let release
  const slow = new Promise((r) => { release = r })
  const { prisma, calls } = fakePrisma(ACCOUNTS, { 'user.findMany': () => slow.then(() => []) })
  scheduleSyncGuardian(prisma, {}, undefined)
  await flush()
  t.mock.timers.tick(5 * 60 * 1000)
  await flush()
  const during = calls.filter((c) => c.model === 'user' && c.method === 'findMany').length
  release()
  await flush()
  clearSyncGuardian()
  assert.equal(during, 1, 'the 5-minute tick waited for the pass in progress')
})
