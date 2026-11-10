// Server-side fixes from the Vault / Automations / Lists / Watch Together review:
// each test pins one behaviour. Everything here uses made-up names and ids.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const { cleanDashboardUrl, sanitizeRestoredEntry } = require('../server/utils/vaultFields')
const { parseIntervalHours } = require('../server/utils/vaultBackup')
const { wholeDays } = require('../server/utils/debridUsage')
const { shouldApplyRefresh } = require('../server/utils/catalogAutoRefresh')
const engine = require('../server/utils/automation/engine')
const { raiseCheckFailed } = require('../server/utils/vaultMonitor')
const { runAutomationScheduler } = require('../server/utils/automation/scheduler')
const { checkWatchAhead, removeUserFromPacts } = require('../server/utils/watchTogether')

// ---- Vault -----------------------------------------------------------------

test('a dashboard link must be http(s); others are refused, blank means none', () => {
  assert.equal(cleanDashboardUrl('https://dash.example.com/a'), 'https://dash.example.com/a')
  assert.equal(cleanDashboardUrl('  http://dash.example.com  '), 'http://dash.example.com')
  assert.equal(cleanDashboardUrl(''), '')
  assert.equal(cleanDashboardUrl(null), '')
  assert.equal(cleanDashboardUrl('javascript:alert(1)'), null)
  assert.equal(cleanDashboardUrl('data:text/html,hi'), null)
  assert.equal(cleanDashboardUrl('not a url'), null)
  assert.equal(cleanDashboardUrl(42), null)
  assert.equal(sanitizeRestoredEntry({ name: 'x', dashboardUrl: 'javascript:alert(1)' }).dashboardUrl, null)
  assert.equal(sanitizeRestoredEntry({ name: 'x', dashboardUrl: 'https://dash.example.com' }).dashboardUrl, 'https://dash.example.com')
})

test('the vault backup interval falls back to a day for junk, zero and negatives', () => {
  assert.equal(parseIntervalHours('6'), 6)
  assert.equal(parseIntervalHours('0.5'), 0.5)
  for (const bad of [undefined, '', 'abc', '0', '-3', NaN]) assert.equal(parseIntervalHours(bad), 24)
})

test('debrid auto-remove never goes below one whole day', () => {
  assert.equal(wholeDays(0), 7)
  assert.equal(wholeDays(-2), 7)
  assert.equal(wholeDays('x'), 7)
  assert.equal(wholeDays(0.4), 7)
  assert.equal(wholeDays(1), 1)
  assert.equal(wholeDays(3.9), 3)
})

test('a failure found by a manual Test raises the check_failed and failover events', async () => {
  const seen = []
  const prisma = {
    automationRule: { findMany: async ({ where }) => { seen.push(where.triggerType); return [] } },
    vaultEntry: { findFirst: async () => ({ id: 'b1', name: 'Spare', lastCheckStatus: 'ok' }) },
    appAccount: { findFirst: async () => ({ sync: '{}' }) },
  }
  const entry = { id: 'e1', name: 'Main key', category: 'debrid', provider: 'example', backupEntryId: 'b1' }
  await raiseCheckFailed({ prisma, accountId: 'acc-v1', cfg: {}, entry, result: { ok: false, message: 'bad key' } })
  assert.deepEqual(seen, ['vault.check_failed', 'vault.failover_activated'])
})

// ---- Automations -----------------------------------------------------------

test('a rule is capped on actions and conditions', () => {
  const base = { name: 'r', triggerType: 'addon.offline', actions: [{ type: 'notify', config: { title: 't', message: 'm' } }] }
  assert.equal(engine.validateRule(base).ok, true)
  const manyActions = { ...base, actions: Array.from({ length: engine.MAX_ACTIONS_PER_RULE + 1 }, () => base.actions[0]) }
  assert.match(engine.validateRule(manyActions).error, /at most/)
  const field = require('../server/utils/automation/registry').TRIGGERS['addon.offline'].fields[0].name
  const manyConds = { ...base, conditions: Array.from({ length: engine.MAX_CONDITIONS_PER_RULE + 1 }, () => ({ field, op: 'exists' })) }
  assert.match(engine.validateRule(manyConds).error, /at most/)
})

test('the same event for a rule within 10s is a repeat; a different event is not; bursts are capped', () => {
  const t0 = 1_000_000
  assert.equal(engine.allowEventRun('rule-a', { id: 1 }, t0), true)
  assert.equal(engine.allowEventRun('rule-a', { id: 1 }, t0 + 5000), false)
  assert.equal(engine.allowEventRun('rule-a', { id: 2 }, t0 + 5000), true)
  assert.equal(engine.allowEventRun('rule-a', { id: 1 }, t0 + 11000), true)
  let allowed = 0
  for (let i = 0; i < 100; i++) if (engine.allowEventRun('rule-b', { i }, t0 + i)) allowed++
  assert.equal(allowed, 30)
})

test('time.daily fires late within the grace window, once, and claims before running', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-10T09:06:00Z') })
  const rule = { id: 'sched-1', accountId: 'acc-s1', name: 'Daily', triggerType: 'time.daily', enabled: true,
    triggerConfig: JSON.stringify({ hour: 9, minute: 0 }), conditions: '[]', actions: '[]', lastRunAt: null, runCount: 0 }
  const order = []
  const prisma = {
    appAccount: { findFirst: async () => ({ sync: JSON.stringify({ accountTimezone: 'UTC' }) }) },
    automationRule: {
      findMany: async ({ where }) => {
        if (where.triggerType === 'user.inactive') return []
        if (where.id) { order.push('emit'); return [rule] }
        return [rule]
      },
      updateMany: async ({ where, data }) => {
        order.push('claim')
        if ((where.lastRunAt ?? null) !== (rule.lastRunAt ?? null)) return { count: 0 }
        rule.lastRunAt = data.lastRunAt
        return { count: 1 }
      },
      update: async () => ({}),
    },
    automationRun: { create: async () => ({}) },
    $transaction: async (ops) => Promise.all(ops),
  }
  await runAutomationScheduler(prisma)
  assert.deepEqual(order.slice(0, 2), ['claim', 'emit'], 'the day is claimed before the actions run')
  const claimsBefore = order.filter((o) => o === 'claim').length
  await runAutomationScheduler(prisma)
  assert.equal(order.filter((o) => o === 'emit').length, 1, 'a second tick the same day does not run it again')
  assert.equal(order.filter((o) => o === 'claim').length, claimsBefore, 'and does not even try to claim')
})

test('time.daily does not fire before its time or after the grace window', async (t) => {
  const mk = () => ({ id: 'sched-2', accountId: 'acc-s2', name: 'Daily', triggerType: 'time.daily', enabled: true,
    triggerConfig: JSON.stringify({ hour: 9, minute: 0 }), conditions: '[]', actions: '[]', lastRunAt: null })
  for (const at of ['2026-03-10T08:59:00Z', '2026-03-10T09:11:00Z']) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) })
    const rule = mk()
    let claimed = false
    const prisma = {
      appAccount: { findFirst: async () => ({ sync: JSON.stringify({ accountTimezone: 'UTC' }) }) },
      automationRule: { findMany: async ({ where }) => (where.triggerType === 'user.inactive' ? [] : [rule]), updateMany: async () => { claimed = true; return { count: 1 } } },
    }
    await runAutomationScheduler(prisma)
    assert.equal(claimed, false, at)
    t.mock.timers.reset()
  }
})

// ---- Lists -----------------------------------------------------------------

test('auto-refresh does not apply an empty or much smaller result', () => {
  assert.equal(shouldApplyRefresh(10, 0), false)
  assert.equal(shouldApplyRefresh(10, 6), false)
  assert.equal(shouldApplyRefresh(10, 7), true)
  assert.equal(shouldApplyRefresh(10, 25), true)
  assert.equal(shouldApplyRefresh(0, 3), true)
})

async function withListsServer(t, lists, accountId = 'acc-l1') {
  const listsRouter = require('../server/routes/lists')
  const delay = () => new Promise((r) => setTimeout(r, 15))
  const prisma = {
    customList: {
      findMany: async ({ where }) => lists.filter((l) => (where.shared ? l.shared && l.accountId !== where.accountId.not : l.accountId === where.accountId)),
      findFirst: async ({ where }) => { await delay(); return lists.find((l) => l.id === where.id && l.accountId === where.accountId) || null },
      update: async ({ where, data }) => { await delay(); const l = lists.find((x) => x.id === where.id); Object.assign(l, data); return l },
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/lists', listsRouter({ prisma, getAccountId: () => accountId, decrypt: (x) => x }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}/api/lists`
}

test('two quick edits to one list both land', async (t) => {
  const list = { id: 'list-1', accountId: 'acc-l1', name: 'Mine', itemsJson: '[]' }
  const base = await withListsServer(t, [list])
  const add = (id) => fetch(`${base}/list-1/items`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, type: 'movie', name: `Title ${id}` }),
  })
  const rs = await Promise.all([add('tt1'), add('tt2'), add('tt3')])
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200])
  assert.deepEqual(JSON.parse(list.itemsJson).map((i) => i.id).sort(), ['tt1', 'tt2', 'tt3'])
})

test('item names and posters are bounded when added', async (t) => {
  const list = { id: 'list-2', accountId: 'acc-l1', name: 'Mine', itemsJson: '[]' }
  const base = await withListsServer(t, [list])
  await fetch(`${base}/list-2/items`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'tt9', type: 'movie', name: 'x'.repeat(1000), poster: 'https://img.example.com/' + 'p'.repeat(3000) }),
  })
  const [item] = JSON.parse(list.itemsJson)
  assert.equal(item.name.length, 300)
  assert.equal(item.poster, null)
})

test('the import source address is for the owner only, without its key', async (t) => {
  const mine = { id: 'm1', accountId: 'acc-l1', name: 'Mine', itemsJson: '[]', importSourceUrl: 'https://lists.example.com/l/1?key=SECRET123&page=2', shared: false }
  const theirs = { id: 't1', accountId: 'acc-l2', name: 'Theirs', itemsJson: '[]', importSourceUrl: 'https://lists.example.com/l/2?key=OTHER456', shared: true }
  const base = await withListsServer(t, [mine, theirs])
  const body = await (await fetch(base)).json()
  const m = body.find((l) => l.id === 'm1')
  const o = body.find((l) => l.id === 't1')
  assert.equal(m.importSourceUrl, 'https://lists.example.com/l/1?page=2')
  assert.equal(o.importSourceUrl, null)
  assert.ok(!JSON.stringify(body).includes('SECRET123'))
  assert.ok(!JSON.stringify(body).includes('OTHER456'))
})

// ---- Watch Together --------------------------------------------------------

function pactWorld({ users, notifications = [] }) {
  const sent = { emit: 0, bell: 0 }
  const pact = { accountId: 'acc-w1', showId: 'tt100', showName: 'Example Show', userIds: JSON.stringify(['u1', 'u2', 'u3']) }
  const prisma = {
    watchTogetherShow: { findUnique: async () => pact },
    appAccount: { findUnique: async () => ({ sync: '{}' }) },
    user: {
      findMany: async ({ where }) => users.filter((u) => where.id.in.includes(u.id) && (!where.accountId || u.accountId === where.accountId) && (where.isActive === undefined || u.isActive === where.isActive)),
    },
    episodeWatchHistory: { findMany: async () => [] },
    notification: {
      findUnique: async ({ where }) => notifications.find((n) => n.dedupeKey === where.accountId_dedupeKey.dedupeKey) || null,
      upsert: async ({ create }) => { sent.bell++; notifications.push(create); return create },
      create: async ({ data }) => { sent.bell++; notifications.push(data); return data },
    },
    automationRule: { findMany: async () => { sent.emit++; return [] } },
  }
  return { prisma, sent }
}

test('watch-ahead ignores a deleted or switched-off pact member', async () => {
  const users = [
    { id: 'u1', username: 'Ann', accountId: 'acc-w1', isActive: true },
    { id: 'u2', username: 'Bo', accountId: 'acc-w1', isActive: false },
    // u3 no longer exists
  ]
  const w = pactWorld({ users })
  const res = await checkWatchAhead(w.prisma, 'acc-w1', { userId: 'u1', showId: 'tt100', showName: 'Example Show', season: 1, episode: 3, videoId: 'tt100:1:3' })
  assert.equal(res, null, 'nobody live is behind')
  assert.equal(w.sent.bell, 0)
})

test('watch-ahead alerts once: a repeat of the same episode sends no push or automation event', async () => {
  const users = [
    { id: 'u1', username: 'Ann', accountId: 'acc-w1', isActive: true },
    { id: 'u2', username: 'Bo', accountId: 'acc-w1', isActive: true },
  ]
  const w = pactWorld({ users })
  const args = { userId: 'u1', showId: 'tt100', showName: 'Example Show', season: 1, episode: 3, videoId: 'tt100:1:3' }
  const first = await checkWatchAhead(w.prisma, 'acc-w1', args)
  assert.deepEqual(first.behind, ['Bo'])
  assert.equal(w.sent.emit, 1)
  const second = await checkWatchAhead(w.prisma, 'acc-w1', args)
  assert.equal(second, null)
  assert.equal(w.sent.emit, 1)
  assert.equal(w.sent.bell, 1)
})

test('a deleted person leaves their pacts; a pact down to one person goes', async () => {
  const pacts = [
    { accountId: 'acc-w2', showId: 's1', userIds: JSON.stringify(['a', 'b', 'c']) },
    { accountId: 'acc-w2', showId: 's2', userIds: JSON.stringify(['a', 'b']) },
    { accountId: 'acc-w2', showId: 's3', userIds: JSON.stringify(['b', 'c']) },
  ]
  const prisma = {
    watchTogetherShow: {
      findMany: async () => pacts.slice(),
      update: async ({ where, data }) => { pacts.find((p) => p.showId === where.accountId_showId.showId).userIds = data.userIds },
      deleteMany: async ({ where }) => { const i = pacts.findIndex((p) => p.showId === where.showId); if (i >= 0) pacts.splice(i, 1) },
    },
  }
  await removeUserFromPacts(prisma, 'acc-w2', 'a')
  assert.deepEqual(pacts.map((p) => [p.showId, JSON.parse(p.userIds)]), [['s1', ['b', 'c']], ['s3', ['b', 'c']]])
})
