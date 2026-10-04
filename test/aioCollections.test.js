const test = require('node:test')
const assert = require('node:assert/strict')
const { membersOf } = require('../server/utils/aioCollections')

const lists = [
  { id: 'a', itemsJson: JSON.stringify([{ id: 'tt1' }, { id: 'tt2' }, { id: 'tt3' }, { id: 'kitsu:5' }]) },
  { id: 'b', itemsJson: JSON.stringify([{ id: 'tt4' }, { id: 'tt2' }]) },
]
const ids = (items) => items.map((i) => i.id).join(',')

test('titles: catalogs in order, each title once, IMDb ids only', () => {
  assert.equal(ids(membersOf({ catalogIds: ['a', 'b'] }, lists)), 'tt1,tt2,tt3,tt4')
  assert.equal(ids(membersOf({ catalogIds: ['b', 'a'] }, lists)), 'tt4,tt2,tt1,tt3')
})

test('titles: a dragged order wins, titles it does not mention keep their place after', () => {
  assert.equal(ids(membersOf({ catalogIds: ['a', 'b'], order: ['tt4', 'tt1'] }, lists)), 'tt4,tt1,tt2,tt3')
  assert.equal(ids(membersOf({ catalogIds: ['a', 'b'], order: ['tt9', 'tt3'] }, lists)), 'tt3,tt1,tt2,tt4')
  assert.equal(ids(membersOf({ catalogIds: ['a', 'b'], order: [] }, lists)), 'tt1,tt2,tt3,tt4')
})

function fakePrisma(sync) {
  const state = { sync }
  return {
    state,
    appAccount: {
      findUnique: async () => ({ sync: state.sync }),
      update: async ({ data }) => { state.sync = data.sync },
    },
    customList: { findMany: async () => lists },
  }
}

test('per account: own arrangement, else the older shared one, else one per catalog', async () => {
  const { loadCollections, saveCollections } = require('../server/utils/aioCollections')
  const shared = { collections: [{ id: 'x', name: 'Shared', catalogIds: ['b'], hidden: false }] }
  const prisma = fakePrisma({ aioCollections: shared })

  let r = await loadCollections(prisma, 'acc', 'sam')
  assert.equal(r.configured, true)
  assert.deepEqual(r.collections.map((c) => c.name), ['Shared'])

  await saveCollections(prisma, 'acc', 'sam', [{ id: 'y', name: 'Sam only', catalogIds: ['a'] }])
  assert.deepEqual((await loadCollections(prisma, 'acc', 'sam')).collections.map((c) => c.name), ['Sam only'])
  assert.deepEqual((await loadCollections(prisma, 'acc', 'kim')).collections.map((c) => c.name), ['Shared'])

  await saveCollections(prisma, 'acc', 'sam', null)
  r = await loadCollections(prisma, 'acc', 'sam')
  assert.equal(r.configured, false)
  assert.deepEqual(r.collections.map((c) => c.id), ['a', 'b'])
  assert.deepEqual((await loadCollections(prisma, 'acc', 'kim')).collections.map((c) => c.name), ['Shared'])

  await assert.rejects(saveCollections(prisma, 'acc', '', []))
})
