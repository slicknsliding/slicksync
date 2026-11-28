'use strict'
// Deleting a group is undoable from the toast: the delete route hands back the
// Trash item's id, and restoring it brings the group back with its people
// (kept in the group row's own list) and its addons.
const test = require('node:test')
const assert = require('node:assert/strict')
const { archiveGroupDelete, archiveMembershipRemoval, restoreTrashItem } = require('../server/utils/trash')

function fakePrisma() {
  const db = { groups: new Map(), groupAddons: [], trash: new Map(), n: 0 }
  return {
    db,
    group: {
      findFirst: async ({ where }) => { const g = db.groups.get(where.id); return g && g.accountId === where.accountId ? { ...g } : null },
      findUnique: async ({ where }) => { const g = db.groups.get(where.id); return g ? { ...g } : null },
      create: async ({ data }) => { const g = { ...data, id: data.id || `g${++db.n}` }; db.groups.set(g.id, g); return g },
    },
    user: { findFirst: async ({ where }) => ({ id: where.id, username: 'Sam' }) },
    groupAddon: {
      findMany: async ({ where }) => db.groupAddons.filter((x) => x.groupId === where.groupId).map(({ addonId, isEnabled }) => ({ addonId, isEnabled })),
      create: async ({ data }) => { db.groupAddons.push(data); return data },
    },
    trashItem: {
      create: async ({ data }) => { const row = { ...data, id: `t${++db.n}`, deletedAt: new Date() }; db.trash.set(row.id, row); return row },
      findFirst: async ({ where }) => { const r = db.trash.get(where.id); return r && r.accountId === where.accountId ? r : null },
      delete: async ({ where }) => { db.trash.delete(where.id) },
    },
  }
}

test('a deleted group comes back with its people and addons', async () => {
  const prisma = fakePrisma()
  prisma.db.groups.set('g1', { id: 'g1', accountId: 'a', name: 'Family', userIds: '["u1","u2"]' })
  prisma.db.groupAddons.push({ groupId: 'g1', addonId: 'x', isEnabled: true })

  const trashed = await archiveGroupDelete(prisma, 'a', 'g1')
  assert.ok(trashed.id, 'the route needs an id to hand to the page')
  prisma.db.groups.delete('g1')
  prisma.db.groupAddons.length = 0

  const back = await restoreTrashItem(prisma, 'a', trashed.id)
  assert.equal(back.kind, 'group')
  assert.equal(back.label, 'Family')
  assert.deepEqual(JSON.parse(prisma.db.groups.get('g1').userIds), ['u1', 'u2'])
  assert.deepEqual(prisma.db.groupAddons.map((x) => x.addonId), ['x'])
  assert.equal(prisma.db.trash.size, 0, 'a restored item leaves the Trash')
})

test('taking someone out of a group leaves an item the page can undo', async () => {
  const prisma = fakePrisma()
  prisma.db.groups.set('g1', { id: 'g1', accountId: 'a', name: 'Kids', userIds: '["u1"]' })
  const trashed = await archiveMembershipRemoval(prisma, 'a', 'g1', 'u1')
  assert.ok(trashed.id)
  assert.equal(trashed.kind, 'membership')
  assert.deepEqual(JSON.parse(trashed.payload), { groupId: 'g1', userId: 'u1' })
})
