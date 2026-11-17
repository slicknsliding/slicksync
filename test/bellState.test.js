// The bell's state is the same on every device, and Clear doesn't bring back
// what a timed check raised (server/utils/bellState.js). Real case Nov 2026:
// "streamed but not recorded" alerts came back a minute after Clear, on the
// phone and the PC, because Clear deleted the rows the minute check looks for.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getBellState, updateBellState, dismissStored, MAX_DISMISSED } = require('../server/utils/bellState')

const SCHEMAS = ['schema.sqlite.prisma', 'schema.postgres.prisma']
  .map((file) => fs.readFileSync(path.join(__dirname, '..', 'prisma', file), 'utf8'))
function fieldsOf(model) {
  return SCHEMAS.map((schema) => {
    const start = schema.indexOf(`\nmodel ${model} {`)
    const body = start < 0 ? null : [null, schema.slice(start, schema.indexOf('\n}', start))]
    assert.ok(body, `model ${model} is in every schema`)
    return new Set(body[1].split('\n').map((l) => /^\s+([A-Za-z]\w*)\s/.exec(l)?.[1]).filter(Boolean))
  })
}

function fakePrisma(rows = []) {
  const notifications = rows.map((r) => ({ ...r }))
  const bell = new Map()
  const matches = (n, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(n[k])
    if (v && typeof v === 'object' && 'not' in v) return n[k] !== v.not && n[k] !== undefined
    return (n[k] ?? null) === v
  })
  return {
    notifications,
    bellState: {
      findUnique: async ({ where }) => bell.get(where.accountId) || null,
      upsert: async ({ where, create, update }) => {
        const row = bell.has(where.accountId) ? { ...bell.get(where.accountId), ...update } : { ...create }
        bell.set(where.accountId, row)
        return row
      },
    },
    notification: {
      updateMany: async ({ where, data }) => { for (const n of notifications) if (matches(n, where)) Object.assign(n, data) },
      deleteMany: async ({ where }) => {
        for (let i = notifications.length - 1; i >= 0; i--) if (matches(notifications[i], where)) notifications.splice(i, 1)
      },
    },
  }
}

test('the schema has what the bell state reads and writes', () => {
  for (const fields of fieldsOf('BellState')) for (const f of ['accountId', 'clearedBefore', 'dismissed', 'readIds']) assert.ok(fields.has(f), f)
  for (const fields of fieldsOf('Notification')) assert.ok(fields.has('dismissedAt'))
})

test('Clear hides rows a timed check owns and deletes one-off events', async () => {
  const db = fakePrisma([
    { id: 'a', accountId: 'acc', dedupeKey: 'untracked-carrie', dismissedAt: null, read: false },
    { id: 'b', accountId: 'acc', dedupeKey: null, dismissedAt: null, read: false },
    { id: 'c', accountId: 'other', dedupeKey: 'untracked-x', dismissedAt: null, read: false },
  ])
  await dismissStored(db, 'acc')
  assert.deepEqual(db.notifications.map((n) => n.id), ['a', 'c'], 'the one-off is gone, the keyed row is kept')
  assert.ok(db.notifications[0].dismissedAt instanceof Date, 'kept hidden')
  assert.equal(db.notifications[0].read, true)
  assert.equal(db.notifications[1].dismissedAt, null, "another account's row is untouched")
})

test('dismissing one row by id leaves the rest', async () => {
  const db = fakePrisma([
    { id: 'a', accountId: 'acc', dedupeKey: 'k1', dismissedAt: null },
    { id: 'b', accountId: 'acc', dedupeKey: 'k2', dismissedAt: null },
  ])
  await dismissStored(db, 'acc', ['b'])
  assert.equal(db.notifications.find((n) => n.id === 'a').dismissedAt, null)
  assert.ok(db.notifications.find((n) => n.id === 'b').dismissedAt)
})

test('what one device clears, dismisses or reads, every device sees', async () => {
  const db = fakePrisma()
  assert.deepEqual(await getBellState(db, 'acc'), { clearedBefore: null, dismissed: [], read: [] })
  await updateBellState(db, 'acc', { dismiss: ['episode-1'], read: ['addon-2'] })
  await updateBellState(db, 'acc', { dismiss: ['episode-3'] }) // another device, a moment later
  const s = await getBellState(db, 'acc')
  assert.deepEqual(s.dismissed, ['episode-1', 'episode-3'], 'both devices count')
  assert.deepEqual(s.read, ['addon-2'])
  const cleared = await updateBellState(db, 'acc', { clearAll: true })
  assert.ok(cleared.clearedBefore && Math.abs(new Date(cleared.clearedBefore).getTime() - Date.now()) < 5000)
  assert.deepEqual([cleared.dismissed, cleared.read], [[], []], 'Clear starts the lists over')
  assert.deepEqual(await getBellState(db, 'acc'), cleared)
})

test('the lists stay bounded and ignore junk', async () => {
  const db = fakePrisma()
  const many = Array.from({ length: MAX_DISMISSED + 50 }, (_, i) => `episode-${i}`)
  const s = await updateBellState(db, 'acc', { dismiss: [...many, 42, null, 'x'.repeat(500)] })
  assert.equal(s.dismissed.length, MAX_DISMISSED)
  assert.equal(s.dismissed[s.dismissed.length - 1], `episode-${MAX_DISMISSED + 49}`, 'the newest are kept')
})
