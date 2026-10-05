// "Someone has been inactive for a while" (automation/inactivity.js) and the
// reversible "Deactivate a user" action (registry.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { runInactivityCheck } = require('../server/utils/automation/inactivity')
const { ACTIONS, TRIGGERS } = require('../server/utils/automation/registry')
const { validateRule } = (() => { try { return require('../server/utils/automation/engine') } catch { return {} } })()

const DAY = 86400000
const NOW = Date.parse('2026-10-05T12:00:00Z')

function world({ users, activity = [], rules }) {
  const runs = []
  const table = (rows, field) => ({
    groupBy: async ({ where }) => {
      const m = new Map()
      for (const r of rows) {
        if (r.accountId !== where.accountId || !where.userId.in.includes(r.userId)) continue
        if (!m.has(r.userId) || r[field] > m.get(r.userId)) m.set(r.userId, r[field])
      }
      return [...m].map(([userId, v]) => ({ userId, _max: { [field]: v } }))
    },
  })
  const prisma = {
    automationRule: { findMany: async () => rules },
    automationRun: {
      findFirst: async ({ where }) => runs.find((r) => r.ruleId === where.ruleId && where.AND.every((c) => r.payload.includes(c.payload.contains))) || null,
    },
    user: { findMany: async () => users },
    watchActivity: table(activity, 'createdAt'),
    movieWatchHistory: table([], 'watchedAt'),
    episodeWatchHistory: table([], 'watchedAt'),
    watchSession: table([], 'startTime'),
    proxyStreamSession: { groupBy: async () => [] },
  }
  const fired = []
  const emit = async (_p, accountId, type, payload, opts) => {
    fired.push({ type, payload, ruleId: opts.ruleId })
    runs.push({ ruleId: opts.ruleId, payload: JSON.stringify(payload) })
    return { fired: 1 }
  }
  return { prisma, fired, emit }
}

const rule = { id: 'r1', accountId: 'acc', triggerType: 'user.inactive', enabled: true, triggerConfig: JSON.stringify({ days: 30 }) }
const person = (id, extra = {}) => ({ id, username: id, email: `${id}@example.com`, providerType: 'jellyfin', expiresAt: null, createdAt: new Date(NOW - 400 * DAY), ...extra })

test('fires once per quiet stretch, and again only after they come back and go quiet', async () => {
  const activity = [{ accountId: 'acc', userId: 'ann', createdAt: new Date(NOW - 45 * DAY) }]
  const w = world({ users: [person('ann')], activity, rules: [rule] })
  assert.equal(await runInactivityCheck(w.prisma, { now: NOW, emit: w.emit }), 1)
  assert.equal(w.fired[0].payload.daysInactive, 45)
  assert.equal(w.fired[0].ruleId, 'r1', 'targets the rule whose days were checked')
  assert.equal(await runInactivityCheck(w.prisma, { now: NOW + 3600e3, emit: w.emit }), 0, 'the same stretch never fires twice')

  // Back for an evening, then quiet again for 31 days.
  activity.push({ accountId: 'acc', userId: 'ann', createdAt: new Date(NOW + 2 * DAY) })
  assert.equal(await runInactivityCheck(w.prisma, { now: NOW + 10 * DAY, emit: w.emit }), 0, 'active again')
  assert.equal(await runInactivityCheck(w.prisma, { now: NOW + 33 * DAY, emit: w.emit }), 1)
})

test('skips the recently active, a future end date, and counts never-watched from when they were added', async () => {
  const w = world({
    users: [
      person('recent'),
      person('ends', { expiresAt: new Date(NOW + 10 * DAY) }),
      person('new', { createdAt: new Date(NOW - 5 * DAY) }),
      person('quiet'),
    ],
    activity: [
      { accountId: 'acc', userId: 'recent', createdAt: new Date(NOW - 2 * DAY) },
      { accountId: 'acc', userId: 'ends', createdAt: new Date(NOW - 90 * DAY) },
    ],
    rules: [rule],
  })
  await runInactivityCheck(w.prisma, { now: NOW, emit: w.emit })
  assert.deepEqual(w.fired.map((f) => f.payload.userId), ['quiet'])
  assert.equal(w.fired[0].payload.neverSeen, true)
})

test('the trigger asks for its number of days', () => {
  assert.deepEqual(TRIGGERS['user.inactive'].triggerConfigFields.map((f) => f.name), ['days'])
})

test('deactivate switches off, never deletes, and leaves an end date alone', async () => {
  const rows = { u1: { id: 'u1', username: 'Ann', isActive: true, expiresAt: null }, u2: { id: 'u2', username: 'Bo', isActive: true, expiresAt: new Date(Date.now() + 5 * DAY) } }
  const calls = []
  const prisma = {
    user: {
      findFirst: async ({ where }) => rows[where.id] || null,
      update: async ({ where, data }) => { calls.push(['update', where.id, data]); Object.assign(rows[where.id], data) },
      delete: async () => { throw new Error('must never delete') },
      deleteMany: async () => { throw new Error('must never delete') },
    },
    appAccount: { findUnique: async () => ({ sync: '{}' }) },
  }
  const run = (userId) => ACTIONS['user.deactivate'].run({ prisma, accountId: 'acc', config: {}, payload: { userId } })
  assert.match(await run('u1'), /Deactivated Ann/)
  assert.equal(rows.u1.isActive, false)
  assert.deepEqual(calls, [['update', 'u1', { isActive: false }]])
  assert.match(await run('u1'), /already switched off/)
  assert.match(await run('u2'), /Left Bo on/)
  assert.equal(rows.u2.isActive, true)
})
