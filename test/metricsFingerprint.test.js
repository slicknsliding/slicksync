const test = require('node:test')
const assert = require('node:assert/strict')
const { processUserLibrary } = require('../server/utils/metricsProcessor')

// Counts how many items actually reach processLibraryItem (each one does a
// snapshot lookup) so the unchanged-item memo can be observed.
function makePrisma() {
  const calls = { snapshotLookups: 0 }
  return {
    calls,
    appAccount: { findFirst: async () => ({ sync: { accountTimezone: 'America/Los_Angeles' } }) },
    watchSnapshot: { findMany: async () => [], findFirst: async () => { calls.snapshotLookups++; return null }, upsert: (a) => a },
    watchActivity: { findFirst: async () => null, create: (a) => a },
    $transaction: async (ops) => ops,
  }
}

const item = (ms) => ({
  _id: 'tt7654321', type: 'movie', name: 'Memo Item',
  state: { overallTimeWatched: String(ms), lastWatched: new Date().toISOString() },
})

test('processUserLibrary memo: unchanged item is skipped, changed item is re-processed', async () => {
  const prisma = makePrisma()
  const lib = [item(1000)]
  await processUserLibrary(prisma, 'acct-fp', 'user-fp', lib)
  const first = prisma.calls.snapshotLookups
  assert.ok(first > 0)

  await processUserLibrary(prisma, 'acct-fp', 'user-fp', [item(1000)].map((i) => ({ ...i, state: { ...lib[0].state } })))
  assert.equal(prisma.calls.snapshotLookups, first, 'identical item should be skipped')

  await processUserLibrary(prisma, 'acct-fp', 'user-fp', [item(2000)])
  assert.ok(prisma.calls.snapshotLookups > first, 'changed item should be processed again')
})
