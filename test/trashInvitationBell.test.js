'use strict'
// Undo for a deleted invitation and for the bell's Clear (utils/trash.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const trash = require('../server/utils/trash')

function db(seed = {}) {
  const t = { invitation: [...(seed.invitation || [])], inviteRequest: [...(seed.inviteRequest || [])], notification: [...(seed.notification || [])], trashItem: [], bellState: seed.bellState || null }
  let n = 0
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => v === undefined || (v && typeof v === 'object' ? true : row[k] === v))
  return {
    t,
    invitation: {
      findFirst: async ({ where, include }) => { const r = t.invitation.find((x) => match(x, where)); return r ? (include?.requests ? { ...r, requests: t.inviteRequest.filter((q) => q.invitationId === r.id) } : r) : null },
      findUnique: async ({ where }) => t.invitation.find((x) => (where.id ? x.id === where.id : x.inviteCode === where.inviteCode)) || null,
      create: async ({ data }) => { t.invitation.push(data); return data },
    },
    inviteRequest: { create: async ({ data }) => { t.inviteRequest.push(data); return data } },
    notification: {
      findMany: async () => t.notification,
      findUnique: async ({ where }) => t.notification.find((x) => x.id === where.id) || null,
      create: async ({ data }) => { t.notification.push(data); return data },
      updateMany: async ({ where, data }) => { for (const r of t.notification) if (r.id === where.id) Object.assign(r, data); return { count: 1 } },
    },
    bellState: {
      findUnique: async () => t.bellState,
      upsert: async ({ create, update }) => { t.bellState = { ...(t.bellState || create), ...update }; return t.bellState },
    },
    trashItem: {
      create: async ({ data }) => { const row = { id: `tr${++n}`, deletedAt: new Date(), ...data }; t.trashItem.push(row); return row },
      findFirst: async ({ where }) => t.trashItem.find((x) => x.id === where.id && x.accountId === where.accountId) || null,
      delete: async ({ where }) => { t.trashItem = t.trashItem.filter((x) => x.id !== where.id) },
    },
  }
}

const inv = { id: 'i1', accountId: 'a', name: 'Family', inviteCode: 'ABC', maxUses: 0 }

test('a deleted invitation comes back under its own id, with its requests', async () => {
  const p = db({ invitation: [inv], inviteRequest: [{ id: 'r1', invitationId: 'i1', accountId: 'a', email: 'x@example.invalid' }] })
  const held = await trash.archiveInvitationDelete(p, 'a', 'i1')
  p.t.invitation = []; p.t.inviteRequest = []
  const out = await trash.restoreTrashItem(p, 'a', held.id)
  assert.equal(out.kind, 'invitation')
  assert.equal(p.t.invitation[0].id, 'i1')
  assert.equal(p.t.inviteRequest.length, 1)
  assert.equal(p.t.trashItem.length, 0)
})

test('an invitation is not restored over a taken id or a taken code', async () => {
  const p = db({ invitation: [inv] })
  const held = await trash.archiveInvitationDelete(p, 'a', 'i1')
  await assert.rejects(() => trash.restoreTrashItem(p, 'a', held.id), /already exists/)
  p.t.invitation = [{ ...inv, id: 'other' }]
  await assert.rejects(() => trash.restoreTrashItem(p, 'a', held.id), /invite code/)
  assert.equal(p.t.trashItem.length, 1)
})

test('archiving a missing invitation refuses', async () => {
  await assert.rejects(() => trash.archiveInvitationDelete(db(), 'a', 'nope'), /not found/)
})

test('Clear then Undo: one-off rows return, hidden rows show again, the bell state is put back', async () => {
  const p = db({
    notification: [
      { id: 'n1', accountId: 'a', type: 'sync', title: 't', body: '', dedupeKey: null, read: false },
      { id: 'n2', accountId: 'a', type: 'vault', title: 'v', body: '', dedupeKey: 'k', read: false, dismissedAt: null },
    ],
    bellState: { accountId: 'a', clearedBefore: null, dismissed: '["x"]', readIds: '[]' },
  })
  const held = await trash.archiveBellClear(p, 'a')
  // what Clear does
  p.t.notification = p.t.notification.filter((r) => r.dedupeKey)
  p.t.notification[0].dismissedAt = new Date(); p.t.notification[0].read = true
  p.t.bellState = { accountId: 'a', clearedBefore: new Date(), dismissed: '[]', readIds: '[]' }

  const out = await trash.restoreTrashItem(p, 'a', held.id)
  assert.equal(out.kind, 'bell')
  assert.deepEqual(p.t.notification.map((r) => r.id).sort(), ['n1', 'n2'])
  assert.equal(p.t.notification.find((r) => r.id === 'n2').dismissedAt, null)
  assert.equal(p.t.notification.find((r) => r.id === 'n2').read, false)
  assert.equal(p.t.bellState.clearedBefore, null)
  assert.equal(p.t.bellState.dismissed, '["x"]')
})

test('restoring Clear twice does not duplicate rows', async () => {
  const p = db({ notification: [{ id: 'n1', accountId: 'a', type: 'sync', title: 't', body: '', dedupeKey: null }] })
  const held = await trash.archiveBellClear(p, 'a')
  await trash.restoreTrashItem(p, 'a', held.id)
  assert.equal(p.t.notification.length, 1)
})
