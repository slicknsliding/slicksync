// The sync run's "last ran" stamp must not undo settings saved while the run
// was going (server/utils/syncScheduler.js stampLastRun).
const test = require('node:test')
const assert = require('node:assert/strict')
const { stampLastRun } = require('../server/utils/syncScheduler')

function account(initial, { asString = true } = {}) {
  let stored = asString ? JSON.stringify(initial) : initial
  return {
    read: () => (typeof stored === 'string' ? JSON.parse(stored) : stored),
    set: (cfg) => { stored = asString ? JSON.stringify(cfg) : cfg },
    prisma: {
      appAccount: {
        findUnique: async () => ({ sync: stored }),
        update: async ({ data }) => { stored = data.sync },
      },
    },
  }
}

test('a setting saved during a sync run survives the run ending', async () => {
  const a = account({ enabled: true, frequency: '1h' })
  // The run starts and takes its copy; meanwhile a daily limit is saved.
  a.set({ ...a.read(), screenTime: { mia: { minutes: 90, days: [] } } })
  await stampLastRun(a.prisma, 'acc', '2026-10-05T12:00:00.000Z')
  assert.deepEqual(a.read().screenTime, { mia: { minutes: 90, days: [] } })
  assert.equal(a.read().lastRunAt, '2026-10-05T12:00:00.000Z')
  assert.equal(a.read().frequency, '1h')
})

test('keeps the column\'s own shape (Postgres JSON or SQLite text)', async () => {
  const a = account({ enabled: true }, { asString: false })
  await stampLastRun(a.prisma, 'acc', '2026-10-05T12:00:00.000Z')
  assert.equal(typeof (await a.prisma.appAccount.findUnique()).sync, 'object')
})
