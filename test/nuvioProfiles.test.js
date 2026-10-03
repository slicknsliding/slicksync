const test = require('node:test')
const assert = require('node:assert/strict')
const { ownerOf, ownedProfileIndexes } = require('../server/utils/nuvioProfiles')
const { findSharedEmailUserIds, dedupWatchActivityBySharedEmail } = require('../server/utils/watchDedup')

const main = { id: 'main', nuvioProfileId: 1 }
const kids = { id: 'kids', nuvioProfileId: 3 }

test('ownerOf: a profile with no person of its own counts for the main person', () => {
  assert.equal(ownerOf(2, [main], new Map()), 'main')
})

test('ownerOf: a profile with its own person counts for them', () => {
  assert.equal(ownerOf(3, [main, kids], new Map()), 'kids')
  assert.equal(ownerOf(1, [main, kids], new Map()), 'main')
})

test('ownerOf: a route moves a profile to another person on the account, or to nobody', () => {
  assert.equal(ownerOf(2, [main, kids], new Map([[2, { targetUserId: 'kids', skip: false }]])), 'kids')
  assert.equal(ownerOf(2, [main, kids], new Map([[2, { targetUserId: null, skip: true }]])), null)
})

test('ownerOf: a profile\'s own person beats a stale route, and a route to someone gone falls back', () => {
  assert.equal(ownerOf(3, [main, kids], new Map([[3, { targetUserId: 'main', skip: false }]])), 'kids')
  assert.equal(ownerOf(3, [main, kids], new Map([[3, { targetUserId: null, skip: true }]])), 'kids')
  assert.equal(ownerOf(2, [main, kids], new Map([[2, { targetUserId: 'deleted', skip: false }]])), 'main')
})

function fakePrisma({ users, routes = [] }) {
  return {
    user: {
      findUnique: async ({ where }) => users.find((u) => u.id === where.id) || null,
      findMany: async ({ where }) => users.filter((u) => u.providerType === where.providerType && u.nuvioUserId === where.nuvioUserId && u.accountId === where.accountId),
    },
    nuvioProfileRoute: {
      findMany: async ({ where }) => routes.filter((r) => r.nuvioUserId === where.nuvioUserId && r.accountId === where.accountId),
    },
  }
}

const account = { accountId: 'a', providerType: 'nuvio', nuvioUserId: 'n1', createdAt: new Date(0) }

test('ownedProfileIndexes: each person reads only their own profiles', async () => {
  const prisma = fakePrisma({ users: [{ ...account, id: 'main', nuvioProfileId: 1 }, { ...account, id: 'kids', nuvioProfileId: 3 }] })
  assert.deepEqual(await ownedProfileIndexes(prisma, 'main', [1, 2, 3]), [1, 2])
  assert.deepEqual(await ownedProfileIndexes(prisma, 'kids', [1, 2, 3]), [3])
})

test('ownedProfileIndexes: a single person still reads every profile, as before', async () => {
  const prisma = fakePrisma({ users: [{ ...account, id: 'main', nuvioProfileId: 1 }] })
  assert.deepEqual(await ownedProfileIndexes(prisma, 'main', [1, 2, 3]), [1, 2, 3])
})

test('ownedProfileIndexes: a skipped profile is read by nobody', async () => {
  const prisma = fakePrisma({
    users: [{ ...account, id: 'main', nuvioProfileId: 1 }],
    routes: [{ accountId: 'a', nuvioUserId: 'n1', profileIndex: 2, skip: true, targetUserId: null }],
  })
  assert.deepEqual(await ownedProfileIndexes(prisma, 'main', [1, 2]), [1])
})

test('ownedProfileIndexes: anyone who is not a Nuvio person keeps every profile', async () => {
  const prisma = fakePrisma({ users: [{ ...account, id: 'stremio', providerType: 'stremio' }] })
  assert.deepEqual(await ownedProfileIndexes(prisma, 'stremio', [1, 2]), [1, 2])
})

test('dedupe: two profiles of one Nuvio account watching the same title the same day both count', () => {
  const users = [{ id: 'main', email: 'e', nuvioProfileId: 1 }, { id: 'kids', email: 'e', nuvioProfileId: 3 }]
  const day = new Date('2026-10-01T00:00:00Z')
  const rows = [
    { userId: 'main', itemId: 'tt1', date: day, watchTimeSeconds: 600, profileLabel: 'Main' },
    { userId: 'kids', itemId: 'tt1', date: day, watchTimeSeconds: 900, profileLabel: 'Kids' },
  ]
  assert.equal(dedupWatchActivityBySharedEmail(rows, findSharedEmailUserIds(users)).length, 2)
})

test('dedupe: older unlabelled copies across profile people still collapse to one', () => {
  const users = [{ id: 'main', email: 'e', nuvioProfileId: 1 }, { id: 'kids', email: 'e', nuvioProfileId: 3 }]
  const day = new Date('2026-10-01T00:00:00Z')
  const rows = [
    { userId: 'main', itemId: 'tt1', date: day, watchTimeSeconds: 600, profileLabel: null },
    { userId: 'kids', itemId: 'tt1', date: day, watchTimeSeconds: 600, profileLabel: null },
  ]
  assert.equal(dedupWatchActivityBySharedEmail(rows, findSharedEmailUserIds(users)).length, 1)
})

test('dedupe: a Stremio and Nuvio pair on one email still collapses, labels or not', () => {
  const users = [{ id: 'nuvio', email: 'e', nuvioProfileId: 1 }, { id: 'stremio', email: 'e', nuvioProfileId: 1 }]
  const day = new Date('2026-10-01T00:00:00Z')
  const rows = [
    { userId: 'nuvio', itemId: 'tt1', date: day, watchTimeSeconds: 600, profileLabel: 'Main' },
    { userId: 'stremio', itemId: 'tt1', date: day, watchTimeSeconds: 500, profileLabel: null },
  ]
  assert.equal(dedupWatchActivityBySharedEmail(rows, findSharedEmailUserIds(users)).length, 1)
})

test('dedupe: history rows opt out, because their older copies were labelled too', () => {
  const users = [{ id: 'main', email: 'e', nuvioProfileId: 1 }, { id: 'kids', email: 'e', nuvioProfileId: 3 }]
  const at = new Date('2026-10-01T10:00:00Z')
  const rows = [
    { userId: 'main', itemId: 'tt1', watchedAt: at, durationSeconds: 600, profileLabel: 'Main' },
    { userId: 'kids', itemId: 'tt1', watchedAt: at, durationSeconds: 600, profileLabel: 'Main' },
  ]
  const kept = dedupWatchActivityBySharedEmail(rows, findSharedEmailUserIds(users), { dateField: 'watchedAt', durationField: 'durationSeconds', independentProfiles: false })
  assert.equal(kept.length, 1)
})
