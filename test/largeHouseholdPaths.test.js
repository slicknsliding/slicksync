// The slow paths a big household hit (two years of history, dozens of people),
// and that each faster version still answers exactly as before:
// - the Activity feed's deep read comes in steps, and its merges no longer
//   compare every entry with every session (server/utils/metricsBuilder.js)
// - Continue Watching reads where people left off in a few reads, not one
//   OR term per movie (server/utils/continueWatching.js)
// - the Users list sums watch time in the database (routes/users.js GET /)
// - the history export is written a page at a time (GET /history/export)
// - the migration preview counts in the database
// - Year in Review and taste overlap reuse work they repeated per row/pair
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

// A small in-memory stand-in for the Prisma calls these paths make.
function fakeDb(tables, calls = []) {
  const val = (v) => (v instanceof Date ? v.getTime() : v)
  const cmp = (a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0)
  const match = (row, where = {}) => Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return cond.every((w) => match(row, w))
    if (k === 'OR') return cond.some((w) => match(row, w))
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(row[k])) return false
      if ('gte' in cond && !(val(row[k]) >= val(cond.gte))) return false
      if ('lte' in cond && !(val(row[k]) <= val(cond.lte))) return false
      if ('lt' in cond && !(val(row[k]) < val(cond.lt))) return false
      if ('gt' in cond && !(val(row[k]) > val(cond.gt))) return false
      if ('not' in cond && row[k] === cond.not) return false
      if (Object.keys(cond).every((c) => ['in', 'gte', 'lte', 'lt', 'gt', 'not'].includes(c))) return true
      return match(row, cond) // a compound unique key
    }
    return val(row[k]) === val(cond)
  })
  const pick = (row, select) => {
    if (!select) return { ...row }
    const out = {}
    for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k]
    return out
  }
  const model = (name) => {
    const rows = () => tables[name] || []
    const findMany = async (args = {}) => {
      calls.push({ model: name, op: 'findMany', args })
      let list = rows().filter((r) => match(r, args.where))
      const orders = [].concat(args.orderBy || [])
      if (orders.length) {
        list = [...list].sort((a, b) => {
          for (const o of orders) {
            const [k, dir] = Object.entries(o)[0]
            const c = cmp(a[k], b[k])
            if (c) return dir === 'desc' ? -c : c
          }
          return 0
        })
      }
      if (args.cursor) {
        const at = list.findIndex((r) => r.id === args.cursor.id)
        list = list.slice(at + (args.skip || 0))
      }
      if (args.take != null) list = list.slice(0, args.take)
      return list.map((r) => pick(r, args.select))
    }
    return {
      findMany,
      findFirst: async (args = {}) => (await findMany({ ...args, take: 1 }))[0] || null,
      findUnique: async (args = {}) => (await findMany({ ...args, take: 1 }))[0] || null,
      count: async (args = {}) => rows().filter((r) => match(r, args.where)).length,
      groupBy: async (args = {}) => {
        calls.push({ model: name, op: 'groupBy', args })
        const groups = new Map()
        for (const r of rows().filter((x) => match(x, args.where))) {
          const key = JSON.stringify(args.by.map((b) => r[b]))
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(r)
        }
        return [...groups.values()].map((g) => {
          const out = {}
          for (const b of args.by) out[b] = g[0][b]
          if (args._count) out._count = { _all: g.length }
          if (args._sum) { out._sum = {}; for (const f of Object.keys(args._sum)) out._sum[f] = g.reduce((s, r) => s + (r[f] || 0), 0) }
          if (args._min) { out._min = {}; for (const f of Object.keys(args._min)) out._min[f] = g.map((r) => r[f]).sort(cmp)[0] }
          if (args._max) { out._max = {}; for (const f of Object.keys(args._max)) out._max[f] = g.map((r) => r[f]).sort(cmp).at(-1) }
          return out
        })
      },
      aggregate: async () => ({ _max: {}, _min: {}, _sum: {}, _count: {} }),
    }
  }
  const models = new Map()
  return new Proxy({}, {
    get: (_t, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined
      if (name.startsWith('$')) return async () => []
      if (!models.has(name)) models.set(name, model(name))
      return models.get(name)
    },
  })
}

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function person(id, extra = {}) {
  return { id, accountId: 'acc', username: id, email: `${id}@example.invalid`, isActive: true, createdAt: new Date(Date.UTC(2025, 0, 1)), providerType: 'stremio', colorIndex: 0, ...extra }
}

// --- Activity feed -----------------------------------------------------------

const { buildMetricsForAccount, deepActivityTake, findManyInPages } = require('../server/utils/metricsBuilder')

test('the deep Activity read comes in steps up to the old ceiling', () => {
  assert.equal(deepActivityTake(true), 25000)
  assert.equal(deepActivityTake(1), 25000)
  assert.equal(deepActivityTake(2), 45000)
  assert.equal(deepActivityTake(5), 100000)
  assert.equal(deepActivityTake(50), 100000)
  assert.equal(deepActivityTake(0), 5000)
  assert.equal(deepActivityTake('nonsense'), 5000)
})

test('a deep step asks each read for that many rows and says when it reached the end', async () => {
  const calls = []
  const prisma = fakeDb({ user: [person('p1')] }, calls)
  const step2 = await buildMetricsForAccount({ prisma, accountId: 'acc', period: 'all', decrypt: () => null, deepActivity: 2 })
  // Read a page at a time, never all 45,000 in one answer.
  const takes = calls.filter((c) => ['watchSession', 'episodeWatchHistory', 'movieWatchHistory'].includes(c.model) && c.args.take).map((c) => c.args.take)
  assert.ok(takes.length >= 3 && takes.every((n) => n === 10000), JSON.stringify(takes))
  assert.equal(step2.activityDeepLast, false)
  const last = await buildMetricsForAccount({ prisma, accountId: 'acc', period: 'all', decrypt: () => null, deepActivity: 9 })
  assert.equal(last.activityDeepLast, true)
  const ordinary = await buildMetricsForAccount({ prisma, accountId: 'acc', period: 'all', decrypt: () => null })
  assert.equal('activityDeepLast' in ordinary, false)
})

test('the big reads come in pages and still return every row once, in order, up to the cap', async () => {
  const rows = []
  // 23,000 rows over 3,000 distinct times, so page edges land inside ties.
  for (let i = 0; i < 23000; i++) rows.push({ id: `r${i}`, accountId: 'acc', at: new Date(Date.UTC(2026, 0, 1) + (i % 3000) * 60000) })
  const calls = []
  const prisma = fakeDb({ watchSession: rows }, calls)
  const all = await findManyInPages(prisma.watchSession, { where: { accountId: 'acc' }, field: 'at' })
  assert.equal(all.length, 23000)
  assert.equal(new Set(all.map((r) => r.id)).size, 23000)
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at)
  assert.ok(calls.every((c) => !c.args.take || c.args.take <= 10000))
  const asc = await findManyInPages(prisma.watchSession, { where: { accountId: 'acc' }, field: 'at', dir: 'asc', take: 15001 })
  assert.equal(asc.length, 15001)
  for (let i = 1; i < asc.length; i++) assert.ok(asc[i - 1].at <= asc[i].at)
  assert.equal(new Set(asc.map((r) => r.id)).size, 15001)
  const few = await findManyInPages(prisma.watchSession, { where: { accountId: 'acc' }, field: 'at', take: 5000 })
  assert.equal(few.length, 5000)
})

test('the feed still pairs History rows with their sessions and expands other days, as before', async () => {
  const now = Date.now()
  const watched = new Date(now - 10 * DAY)
  const sess = (id, userId, itemId, startMs, updatedMs, dur, extra = {}) => ({
    id, accountId: 'acc', userId, itemId, itemName: `Example ${itemId}`, itemType: 'movie', poster: null, season: null, episode: null, videoId: null,
    startTime: new Date(startMs), updatedAt: new Date(updatedMs), endTime: new Date(updatedMs), durationSeconds: dur, isActive: false, ...extra,
  })
  const tables = {
    user: [person('p1'), person('p2')],
    movieWatchHistory: [
      { id: 'm1', accountId: 'acc', userId: 'p1', itemId: 'tt0000001', itemName: 'Example One', poster: null, durationSeconds: 600, completed: true, watchedAt: watched },
    ],
    watchSession: [
      // Two of p1's sessions are in reach; the newer one (first in the list) is the match.
      sess('s-new', 'p1', 'tt0000001', watched.getTime() + 2 * HOUR, watched.getTime() + 2 * HOUR, 3000),
      sess('s-old', 'p1', 'tt0000001', watched.getTime() - 1 * HOUR, watched.getTime() - 1 * HOUR, 900),
      // The same title for someone else never pairs with p1's entry.
      sess('s-other', 'p2', 'tt0000001', watched.getTime(), watched.getTime(), 5000),
      // Two days away: out of reach.
      sess('s-far', 'p1', 'tt0000001', watched.getTime() - 3 * DAY, watched.getTime() - 3 * DAY, 4000),
    ],
    watchActivity: [
      // Another day for the same film becomes its own date-only card.
      { id: 'a1', accountId: 'acc', userId: 'p1', itemId: 'tt0000001', videoId: null, itemType: 'movie', date: new Date(Date.UTC(2025, 5, 1)), createdAt: new Date(Date.UTC(2025, 5, 1)), watchTimeSeconds: 1200, profileLabel: null },
      { id: 'a2', accountId: 'acc', userId: 'p1', itemId: 'tt0000001', videoId: null, itemType: 'movie', date: new Date(Date.UTC(2025, 5, 1)), createdAt: new Date(Date.UTC(2025, 5, 1)), watchTimeSeconds: 300, profileLabel: null },
    ],
  }
  const m = await buildMetricsForAccount({ prisma: fakeDb(tables), accountId: 'acc', period: 'all', decrypt: () => null })
  const own = m.recentActivity.find((a) => !a.dateOnly)
  assert.equal(own.durationSeconds, 3000) // max of the History row and the paired session
  const extra = m.recentActivity.filter((a) => a.dateOnly)
  assert.deepEqual(extra.map((a) => [a.watchedAt.slice(0, 10), a.durationSeconds]), [['2025-06-01', 1500]])
  const left = m.watchSessions.map((s) => s.id).sort()
  // s-new was consumed by the History row; s-old starts within three hours
  // of s-new... but s-new is gone by then, so s-old stays, as does everything else.
  assert.deepEqual(left, ['s-far', 's-old', 's-other'])
})

test('sessions of one person within three hours of each other still fold into one', async () => {
  const t0 = Date.now() - 5 * DAY
  const s = (id, startMs, dur, name = 'Example Film') => ({
    id, accountId: 'acc', userId: 'p1', itemId: `tt${id}`, itemName: name, itemType: 'movie', poster: null, season: null, episode: null, videoId: null,
    startTime: new Date(startMs), updatedAt: new Date(startMs), endTime: null, durationSeconds: dur, isActive: false,
  })
  const tables = {
    user: [person('p1')],
    watchSession: [s('1', t0, 100), s('2', t0 + 2 * HOUR, 700), s('3', t0 + 9 * HOUR, 50), s('4', t0 + 9.5 * HOUR, 10, 'Something Else')],
  }
  const m = await buildMetricsForAccount({ prisma: fakeDb(tables), accountId: 'acc', period: 'all', decrypt: () => null })
  const byId = Object.fromEntries(m.watchSessions.map((x) => [x.id, x.durationSeconds]))
  assert.deepEqual(byId, { 1: 700, 3: 50, 4: 10 })
})

// --- Continue Watching ---------------------------------------------------------

test('Continue Watching reads where people left off a few hundred titles at a time', async (t) => {
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  t.after(() => { global.fetch = originalFetch })
  const { getContinueWatching } = require('../server/utils/continueWatching')
  const now = Date.now()
  const movies = []
  const sessions = []
  for (let i = 0; i < 1200; i++) {
    const itemId = `tt${String(1000000 + i)}`
    movies.push({ id: `mv${i}`, accountId: 'acc-cw-test', userId: i % 2 ? 'p1' : 'p2', itemId, itemName: `Example ${i}`, poster: null, watchedAt: new Date(now - (i + 1) * HOUR) })
    // Every 100th film is half watched; the rest are finished.
    sessions.push({ id: `ws${i}`, accountId: 'acc-cw-test', userId: i % 2 ? 'p1' : 'p2', itemId, videoId: null, lastPosition: i % 100 === 0 ? 30 * 60000 : 100 * 60000, totalDuration: 100 * 60000 })
  }
  const calls = []
  const prisma = fakeDb({ user: [person('p1'), person('p2')], movieWatchHistory: movies, watchSession: sessions }, calls)
  const rows = await getContinueWatching(prisma, 'acc-cw-test', 8)
  const reads = calls.filter((c) => c.model === 'watchSession')
  assert.ok(reads.length <= 4, `expected a few reads, got ${reads.length}`)
  assert.ok(reads.every((c) => c.args.where.itemId.in.length <= 500))
  // The in-progress films, newest first.
  assert.deepEqual(rows.map((r) => r.showId), Array.from({ length: 12 }, (_, k) => `tt${1000000 + k * 100}`).slice(0, 8))
  assert.ok(rows.every((r) => r.resume === true && r.progressPercent === 30 && r.remainingMinutes === 70))
  // Where they stopped and how long it is, for the card's "Stopped at 30:00 of 1:40:00".
  assert.ok(rows.every((r) => r.positionMs === 30 * 60000 && r.durationMs === 100 * 60000))
})

// --- Users routes ------------------------------------------------------------

const makeUsersRouter = require('../server/routes/users')

async function serveUsers(t, tables, calls) {
  const prisma = fakeDb(tables, calls)
  const app = express()
  app.use(express.json())
  const passthrough = (v) => v
  app.use('/api/users', makeUsersRouter({
    prisma, getAccountId: () => 'acc', scopedWhere: (_req, w) => ({ ...w, accountId: 'acc' }), decrypt: passthrough, encrypt: passthrough,
    parseAddonIds: () => [], parseProtectedAddons: () => [], createProvider: () => null,
  }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }))
  return `http://127.0.0.1:${server.address().port}/api/users`
}

const activity = (id, userId, itemId, day, seconds, extra = {}) => ({
  id, accountId: 'acc', userId, itemId, itemType: 'movie', videoId: null, date: new Date(day), createdAt: new Date(day), watchTimeSeconds: seconds, profileLabel: null, ...extra,
})

test('the Users list sums watch time in the database and still drops a shared-email copy', async (t) => {
  const calls = []
  const tables = {
    user: [
      person('solo'),
      person('twinA', { email: 'same@example.invalid', position: 1 }),
      person('twinB', { email: 'same@example.invalid', position: 2 }),
    ],
    watchActivity: [
      activity('1', 'solo', 'tt1', '2026-01-01', 600),
      activity('2', 'solo', 'tt2', '2026-01-02', 1200),
      // One viewing replicated to both sign-ins of the same person: the larger is kept.
      activity('3', 'twinA', 'tt3', '2026-01-03', 1800),
      activity('4', 'twinB', 'tt3', '2026-01-03', 600),
      activity('5', 'twinB', 'tt4', '2026-01-04', 3000),
    ],
  }
  const base = await serveUsers(t, tables, calls)
  const res = await fetch(base)
  assert.equal(res.status, 200)
  const list = await res.json()
  const minutes = Object.fromEntries(list.map((u) => [u.id, u.watchTime]))
  assert.deepEqual(minutes, { solo: 30, twinA: 30, twinB: 50 })
  // Row by row only for the two who share an email.
  const rowReads = calls.filter((c) => c.model === 'watchActivity' && c.op === 'findMany')
  assert.equal(rowReads.length, 1)
  assert.deepEqual([...rowReads[0].args.where.userId.in].sort(), ['twinA', 'twinB'])
})

test('the history export is the same file as before, written in pages', async (t) => {
  const sessions = []
  const snapshots = []
  for (let i = 0; i < 21001; i++) {
    // Many share a start time, so page boundaries fall inside ties.
    sessions.push({ id: `s${String(i).padStart(5, '0')}`, accountId: 'acc', userId: 'p1', itemId: `tt${i}`, startTime: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 7) * 60000), durationSeconds: i })
  }
  for (let i = 0; i < 30; i++) snapshots.push({ id: `n${i}`, accountId: 'acc', userId: 'p1', itemId: `tt${i}`, date: new Date(Date.UTC(2026, 0, 1 + i)), overallTimeWatched: i % 2 ? String(i * 1000) : null, timeOffset: '5', timeWatched: null })
  const tables = {
    user: [person('p1')],
    watchSession: sessions,
    episodeWatchHistory: [],
    watchActivity: [activity('a1', 'p1', 'tt1', '2026-01-01', 60)],
    watchSnapshot: snapshots,
  }
  const base = await serveUsers(t, tables)
  const res = await fetch(`${base}/history/export?userId=p1`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/json/)
  const got = await res.text()
  const desc = (field) => (a, b) => b[field].getTime() - a[field].getTime() || (a.id < b.id ? 1 : -1)
  const strip = (x) => ({ ...x, accountId: undefined })
  const expected = JSON.stringify({
    exportedAt: JSON.parse(got).exportedAt,
    userId: 'p1',
    watchSessions: [...sessions].sort(desc('startTime')).map(strip),
    episodeWatchHistory: [],
    watchActivity: tables.watchActivity.map(strip),
    watchSnapshots: [...snapshots].sort(desc('date')).map((s) => ({
      ...s,
      accountId: undefined,
      overallTimeWatched: s.overallTimeWatched !== null && s.overallTimeWatched !== undefined ? String(s.overallTimeWatched) : undefined,
      timeOffset: s.timeOffset !== null && s.timeOffset !== undefined ? String(s.timeOffset) : undefined,
      timeWatched: s.timeWatched !== null && s.timeWatched !== undefined ? String(s.timeWatched) : undefined,
    })),
    counts: { watchSessions: 21001, episodeWatchHistory: 0, watchActivity: 1, watchSnapshots: 30 },
  })
  assert.equal(got, expected)
})

test('the migration preview counts in the database and reports the same figures', async (t) => {
  const calls = []
  const tables = {
    user: [person('p1'), person('p2')],
    watchSession: [],
    episodeWatchHistory: [],
    watchActivity: [
      activity('1', 'p1', 'tt1', '2026-03-05', 600),
      activity('2', 'p1', 'tt2', '2026-01-02', 1200, { itemType: 'series' }),
      activity('3', 'p1', 'tt2', '2026-02-02', 60, { itemType: 'series' }),
      activity('4', 'p2', 'tt9', '2025-12-31', 3600),
    ],
  }
  const base = await serveUsers(t, tables, calls)
  const body = await (await fetch(`${base}/metrics-migration-preview`)).json()
  const byUser = Object.fromEntries(body.users.map((u) => [u.userId, u]))
  assert.deepEqual(byUser.p1, { userId: 'p1', username: 'p1', movies: 1, shows: 2, watchTimeSeconds: 1860, watchTimeHours: 0.52, dateRange: { earliest: '2026-01-02', latest: '2026-03-05' } })
  assert.deepEqual(byUser.p2.dateRange, { earliest: '2025-12-31', latest: '2025-12-31' })
  assert.deepEqual(body.totals, { users: 2, movies: 2, shows: 2, watchTimeSeconds: 5460, watchTimeHours: 1.52, pendingMigration: true })
  assert.equal(calls.filter((c) => c.model === 'watchActivity' && c.op === 'findMany').length, 0)
})

// --- Year in Review and taste overlap -----------------------------------------

test('Year in Review still buckets each moment by the household month', async () => {
  const { buildYearInReview } = require('../server/utils/yearInReview')
  // Los Angeles (the default): 2026-02-01T07:59Z is still January 31 there,
  // and 08:00Z, a quarter-hour later in the same hour, is February 1.
  const tables = {
    appAccount: [{ id: 'acc-yir', sync: JSON.stringify({ accountTimezone: 'America/Los_Angeles' }) }],
    watchActivity: [
      activity('1', 'p1', 'tt1', '2026-02-01T07:59:00Z', 100),
      activity('2', 'p1', 'tt1', '2026-02-01T07:50:00Z', 10),
      activity('3', 'p1', 'tt1', '2026-02-01T08:00:00Z', 1000),
      activity('4', 'p1', 'tt1', '2026-02-01T08:14:00Z', 5000),
      activity('5', 'p1', 'tt1', '2026-01-01T07:59:00Z', 7), // December 31, 2025 locally: not this year
    ].map((r) => ({ ...r, accountId: 'acc-yir' })),
    movieWatchHistory: [],
    episodeWatchHistory: [],
    user: [],
  }
  const r = await buildYearInReview(fakeDb(tables), 'acc-yir', 2026, [])
  assert.equal(r.byMonth[0], 110)
  assert.equal(r.byMonth[1], 6000)
  assert.equal(r.totalWatchTimeSeconds, 6110)
})

test('taste overlap gives the same pairs, and reuses them for the same vectors', () => {
  const { computePairwiseOverlap } = require('../server/utils/recommendationEngine')
  const vectors = new Map([
    ['a', new Map([['movie:1', 100], ['movie:2', 50], ['series:3', 10]])],
    ['b', new Map([['movie:1', 30], ['series:3', 80]])],
    ['c', new Map([['movie:9', 5]])],
  ])
  const meta = new Map([['movie:1', { name: 'One' }], ['series:3', { name: 'Three' }]])
  const pairs = computePairwiseOverlap(vectors, meta)
  assert.equal(pairs.length, 1)
  const magA = 100 * 100 + 50 * 50 + 10 * 10
  const magB = 30 * 30 + 80 * 80
  assert.equal(pairs[0].similarity, (100 * 30 + 10 * 80) / (Math.sqrt(magA) * Math.sqrt(magB)))
  assert.deepEqual(pairs[0].shared.map((s) => [s.key, s.name]), [['movie:1', 'One'], ['series:3', 'Three']])
  assert.equal(computePairwiseOverlap(vectors, meta), pairs)
  assert.equal(computePairwiseOverlap(vectors, meta, { topN: 1 })[0].shared.length, 1)
})
