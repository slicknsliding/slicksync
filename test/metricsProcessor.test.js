const test = require('node:test')
const assert = require('node:assert/strict')
const { processLibraryItem } = require('../server/utils/metricsProcessor')

// Builds a fake prisma client that records what gets bundled into
// $transaction() vs called directly, without needing a real DB.
function makeMockPrisma({ latestSnapshotForToday = null, previousSnapshot = null, mostRecentActivity = null } = {}) {
  const calls = { transactions: [], accountFindFirst: 0 }
  return {
    calls,
    appAccount: {
      findFirst: async () => { calls.accountFindFirst++; return { sync: { accountTimezone: 'America/Los_Angeles' } } },
    },
    watchSnapshot: {
      findFirst: async (args) => {
        // getPreviousSnapshot() queries with date: { lte: ... }; the
        // "latest snapshot for today" lookup in processLibraryItem uses a
        // plain date value - distinguish by shape.
        if (args.where.date && typeof args.where.date === 'object' && 'lte' in args.where.date) {
          return previousSnapshot
        }
        return latestSnapshotForToday
      },
      upsert: (args) => ({ __op: 'watchSnapshot.upsert', args }),
    },
    watchActivity: {
      findFirst: async () => mostRecentActivity,
      create: (args) => ({ __op: 'watchActivity.create', args }),
    },
    $transaction: async (ops) => {
      calls.transactions.push(ops)
      return ops
    },
  }
}

function makeItem({ overallTimeWatchedMs, type = 'movie' } = {}) {
  return {
    _id: 'tt1234567',
    type,
    name: 'Test Item',
    state: {
      overallTimeWatched: overallTimeWatchedMs != null ? String(overallTimeWatchedMs) : undefined,
      timeOffset: undefined,
      lastWatched: new Date().toISOString(),
    },
  }
}

test('processLibraryItem: records the activity delta and advances the snapshot baseline in a single transaction', async () => {
  // Regression test for the duplicate-delta bug: these two writes used to
  // be two separate, independently-awaited prisma calls - if the process
  // was interrupted between them (a container restart mid-cycle), the
  // delta got recorded without the baseline advancing, so the next boot's
  // immediate poll recorded the exact same delta again. Confirmed with
  // real production data: the same item's delta appearing 2-3 times
  // identically. Both writes must now be bundled into one
  // prisma.$transaction() call so they can't land independently.
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: null } // 1,000,000ms baseline
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: priorSnapshot, mostRecentActivity: null })

  // Baseline was 1,000,000ms; current is 1,000,000ms + 120s (well over the
  // 60s recording threshold).
  const item = makeItem({ overallTimeWatchedMs: 1000000 + 120 * 1000 })

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(prisma.calls.transactions.length, 1, 'both writes should go through exactly one $transaction call')
  const ops = prisma.calls.transactions[0]
  const opTypes = ops.map((o) => o.__op).sort()
  assert.deepEqual(opTypes, ['watchActivity.create', 'watchSnapshot.upsert'], 'transaction should bundle both the activity delta and the snapshot baseline update')
  assert.equal(result.activityCreated, true)
  assert.equal(result.snapshotCreated, true)
})

test('processLibraryItem: a first-ever snapshot establishes the baseline with zero delta (no activity recorded)', async () => {
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: null, mostRecentActivity: null })
  const item = makeItem({ overallTimeWatchedMs: 5 * 60 * 60 * 1000 }) // 5 hours - would be a huge false delta if treated as incremental

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false, 'first-time items must not record their whole cumulative watch time as a single delta')
  assert.equal(result.snapshotCreated, true, 'the baseline should still be established')
  assert.equal(prisma.calls.transactions.length, 1)
  const ops = prisma.calls.transactions[0]
  assert.equal(ops.length, 1)
  assert.equal(ops[0].__op, 'watchSnapshot.upsert')
})

test('processLibraryItem: no delta when overallTimeWatched matches the existing baseline for today', async () => {
  // This is the exact "next poll cycle" scenario that must NOT re-record
  // anything once the baseline has already been advanced.
  const todaySnapshot = { overallTimeWatched: '1500000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: todaySnapshot, previousSnapshot: null, mostRecentActivity: null })
  const item = makeItem({ overallTimeWatchedMs: 1500000 }) // unchanged from the stored baseline

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false)
  assert.equal(result.snapshotCreated, false)
  assert.equal(prisma.calls.transactions.length, 0, 'nothing changed, so no writes at all should happen')
})

test('processLibraryItem: a delta under the 60-second threshold updates the baseline but does not record activity', async () => {
  const priorSnapshot = { overallTimeWatched: '1000000', timeOffset: null }
  const prisma = makeMockPrisma({ latestSnapshotForToday: null, previousSnapshot: priorSnapshot, mostRecentActivity: null })
  const item = makeItem({ overallTimeWatchedMs: 1000000 + 30 * 1000 }) // only 30s of new progress

  const result = await processLibraryItem(prisma, 'acct-1', 'user-1', item, new Date())

  assert.equal(result.activityCreated, false)
  assert.equal(result.snapshotCreated, true, 'baseline still advances even when the delta is too small to log')
  const ops = prisma.calls.transactions[0]
  assert.equal(ops.length, 1)
  assert.equal(ops[0].__op, 'watchSnapshot.upsert')
})
