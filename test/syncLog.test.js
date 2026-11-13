// Sync history (server/utils/syncLog.js): what a sync changed, what is kept,
// and that a failure that keeps happening stays one line.
const test = require('node:test')
const assert = require('node:assert/strict')
const { describeSyncChange, recordSyncOutcome, listSyncHistory } = require('../server/utils/syncLog')

const addon = (url, name) => ({ transportUrl: url, manifest: { name } })
const fp = (a) => a.transportUrl

test('added, removed and updated addons are named', () => {
  const current = [addon('a', 'Cinemeta'), addon('b', 'Torrentio'), addon('c', 'AIOStreams')]
  const desired = [addon('b', 'Torrentio'), addon('c', 'AIOStreams'), addon('d', 'Comet')]
  const c = describeSyncChange(current, desired, fp, ['c'])
  assert.deepEqual(c.added, ['Comet'])
  assert.deepEqual(c.removed, ['Cinemeta'])
  assert.deepEqual(c.updated, ['AIOStreams'])
  assert.equal(c.reordered, false)
})

test('a new order counts only among the addons kept', () => {
  const current = [addon('a', 'A'), addon('b', 'B'), addon('c', 'C')]
  assert.equal(describeSyncChange(current, [addon('b', 'B'), addon('a', 'A'), addon('c', 'C')], fp).reordered, true)
  // Dropping one and adding one keeps the rest in the same order.
  assert.equal(describeSyncChange(current, [addon('a', 'A'), addon('c', 'C'), addon('x', 'X')], fp).reordered, false)
  // Nothing different at all.
  const same = describeSyncChange(current, current, fp)
  assert.deepEqual([same.added, same.removed, same.updated, same.reordered], [[], [], [], false])
})

function fakePrisma() {
  const rows = []
  let n = 0
  const match = (r, where) => Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && 'lt' in v) return r[k] < v.lt
    return r[k] === v
  })
  return {
    rows,
    syncLog: {
      create: async ({ data }) => { const r = { id: `r${++n}`, repeats: 1, reordered: false, at: new Date(), lastAt: new Date(), groupName: null, added: null, removed: null, updated: null, total: null, error: null, ...data }; rows.push(r); return r },
      findFirst: async ({ where }) => rows.filter((r) => match(r, where)).sort((a, b) => b.lastAt - a.lastAt)[0] || null,
      update: async ({ where, data }) => {
        const r = rows.find((x) => x.id === where.id)
        if (data.repeats?.increment) r.repeats += data.repeats.increment
        if (data.lastAt) r.lastAt = data.lastAt
        return r
      },
      deleteMany: async ({ where }) => { let count = 0; for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) { rows.splice(i, 1); count++ } return { count } },
      findMany: async ({ where }) => rows.filter((r) => match(r, where)).sort((a, b) => b.lastAt - a.lastAt),
    },
  }
}

const ctx = { accountId: 'acc', userId: 'u1', provider: 'stremio', source: 'schedule' }

test('a sync that changed nothing is not kept; one that did is', async () => {
  const prisma = fakePrisma()
  await recordSyncOutcome(prisma, { ...ctx, result: { success: true, alreadySynced: true, total: 4 } })
  await recordSyncOutcome(prisma, { ...ctx, result: { success: true, total: 4, change: { added: [], removed: [], updated: [], reordered: false } } })
  await recordSyncOutcome(prisma, { ...ctx, result: { success: true, noGroup: true } })
  assert.equal(prisma.rows.length, 0)
  await recordSyncOutcome(prisma, { ...ctx, source: 'manual', result: { success: true, total: 5, change: { added: ['Comet'], removed: [], updated: [], reordered: false } } })
  const [entry] = await listSyncHistory(prisma, { accountId: 'acc', userId: 'u1' })
  assert.equal(entry.ok, true)
  assert.equal(entry.source, 'manual')
  assert.deepEqual(entry.added, ['Comet'])
  assert.equal(entry.total, 5)
})

test('the same failure again is counted on its line, a different one is a new line', async () => {
  const prisma = fakePrisma()
  const fail = (error) => recordSyncOutcome(prisma, { ...ctx, result: { success: false, error } })
  await fail('Stremio did not answer')
  await fail('Stremio did not answer')
  await fail('Stremio did not answer')
  assert.equal(prisma.rows.length, 1)
  assert.equal(prisma.rows[0].repeats, 3)
  await fail('Sign-in expired')
  assert.equal(prisma.rows.length, 2)
  // A success in between starts the count again.
  await recordSyncOutcome(prisma, { ...ctx, result: { success: true, total: 1, change: { added: ['A'], removed: [], updated: [], reordered: false } } })
  await fail('Sign-in expired')
  assert.equal(prisma.rows.length, 4)
})

test('an unknown source is kept as other, and recording never throws', async () => {
  const prisma = fakePrisma()
  await recordSyncOutcome(prisma, { ...ctx, source: 'nonsense', result: { success: false, error: 'x' } })
  assert.equal(prisma.rows[0].source, 'other')
  await recordSyncOutcome({ syncLog: { findFirst: async () => { throw new Error('db down') } } }, { ...ctx, result: { success: false, error: 'x' } })
})
