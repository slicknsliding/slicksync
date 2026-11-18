// The Superadmin panel's account list: each account's coarse counts of its
// setup, worked out with one grouped count per table rather than five counts
// per account, so the page stays quick however many accounts sign up. Watch
// history is never counted, and "last used" is a day, never a time.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const makeSuperadminRouter = require('../server/routes/superadmin')

const SECRET = 'test-secret-superadmin'

// Rows by table, each tagged with the account it belongs to. A row with no
// account (left from before accounts existed) belongs to nobody.
const ROWS = {
  user: ['a', 'a', 'b', null],
  group: ['a'],
  addon: ['a', 'a', 'a'],
  customList: ['a'],
  vaultEntry: ['a', 'a'],
}

function fakePrisma() {
  const queries = []
  const table = (name) => ({
    groupBy: async ({ by, _count }) => {
      queries.push(`${name}.groupBy`)
      assert.deepEqual(by, ['accountId'])
      assert.deepEqual(_count, { _all: true })
      const counts = new Map()
      for (const accountId of ROWS[name]) counts.set(accountId, (counts.get(accountId) || 0) + 1)
      return [...counts].map(([accountId, n]) => ({ accountId, _count: { _all: n } }))
    },
    count: async () => { queries.push(`${name}.count`); throw new Error('counted one account at a time') },
  })
  const prisma = Object.fromEntries(Object.keys(ROWS).map((name) => [name, table(name)]))
  prisma.watchSession = {
    groupBy: async () => { queries.push('watchSession.groupBy'); throw new Error('watch history was counted') },
    count: async () => { queries.push('watchSession.count'); throw new Error('watch history was counted') },
  }
  prisma.appAccount = {
    findMany: async ({ select }) => {
      assert.equal(select.lastLoginAt, undefined, 'the sign-in time is not sent to the panel')
      assert.equal(select.lastActiveDay, true)
      return [
        { id: 'c', uuid: 'uuid-c', createdAt: new Date('2026-11-03'), lastActiveDay: null, disabled: false, displayName: null },
        { id: 'b', uuid: 'uuid-b', createdAt: new Date('2026-11-02'), lastActiveDay: '2026-11-10', disabled: false, displayName: 'Bee' },
        { id: 'a', uuid: 'uuid-a', createdAt: new Date('2026-11-01'), lastActiveDay: '2026-11-12', disabled: false, displayName: null },
      ]
    },
  }
  return { prisma, queries }
}

async function listAccounts(t, prisma) {
  const app = express()
  const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((c) => c.trim().split('=')))
  app.use('/api/superadmin', makeSuperadminRouter({ prisma, JWT_SECRET: SECRET, isProdEnv: false, parseCookies }))
  const server = app.listen(0)
  t.after(() => server.close())
  const token = jwt.sign({ typ: 'superadmin' }, SECRET, { expiresIn: '1h' })
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/accounts`, { headers: { cookie: `sfm_superadmin=${token}` } })
  return { status: res.status, body: await res.json() }
}

test('every account gets its own counts, an empty one zeros', async (t) => {
  const { prisma } = fakePrisma()
  const { status, body } = await listAccounts(t, prisma)
  assert.equal(status, 200)
  assert.equal(body.total, 3)
  assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/)
  const byId = Object.fromEntries(body.accounts.map((a) => [a.id, a]))
  const counts = (a) => ({ users: a.userCount, groups: a.groupCount, addons: a.addonCount, catalogs: a.catalogCount, vault: a.vaultCount, rows: a.resourceRowCount })
  assert.deepEqual(counts(byId.a), { users: 2, groups: 1, addons: 3, catalogs: 1, vault: 2, rows: 2 + 1 + 3 + 1 + 2 })
  assert.deepEqual(counts(byId.b), { users: 1, groups: 0, addons: 0, catalogs: 0, vault: 0, rows: 1 })
  assert.deepEqual(counts(byId.c), { users: 0, groups: 0, addons: 0, catalogs: 0, vault: 0, rows: 0 })
  // The list keeps the order it was read in (newest first) and its fields.
  assert.deepEqual(body.accounts.map((a) => a.id), ['c', 'b', 'a'])
  assert.equal(byId.b.displayName, 'Bee')
  assert.equal(byId.b.lastActiveDay, '2026-11-10')
  assert.equal(byId.c.lastActiveDay, null)
  assert.equal('lastLoginAt' in byId.a, false)
})

test('five queries however many accounts there are, none of them watch history', async (t) => {
  const { prisma, queries } = fakePrisma()
  await listAccounts(t, prisma)
  assert.deepEqual(queries.sort(), Object.keys(ROWS).map((name) => `${name}.groupBy`).sort())
})

test('the list needs the Superadmin sign-in', async (t) => {
  const { prisma } = fakePrisma()
  const app = express()
  app.use('/api/superadmin', makeSuperadminRouter({ prisma, JWT_SECRET: SECRET, isProdEnv: false, parseCookies: () => ({}) }))
  const server = app.listen(0)
  t.after(() => server.close())
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/accounts`)
  assert.equal(res.status, 401)
})
