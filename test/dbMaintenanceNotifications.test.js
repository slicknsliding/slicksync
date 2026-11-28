// Old read notifications are cleared on Postgres too. There the age is the
// instance's own (90 days unless NOTIFICATION_KEEP_DAYS says otherwise, 0 =
// off), unread rows are never touched, and it runs at most once a day.
const test = require('node:test')
const assert = require('node:assert/strict')

const DAY = 24 * 60 * 60 * 1000

function fakePrisma() {
  const calls = []
  return {
    calls,
    notification: { deleteMany: async (args) => { calls.push(args); return { count: 7 } } },
  }
}

// A fresh copy of the module each time: it keeps "last trimmed" in memory.
function load(env = {}) {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, NOTIFICATION_KEEP_DAYS: process.env.NOTIFICATION_KEEP_DAYS }
  process.env.DATABASE_URL = 'postgresql://slicksync:pw@db.example.com:5432/slicksync'
  delete process.env.NOTIFICATION_KEEP_DAYS
  Object.assign(process.env, env)
  delete require.cache[require.resolve('../server/utils/dbMaintenance')]
  const mod = require('../server/utils/dbMaintenance')
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { mod, restore }
}

test('on Postgres, read notifications older than 90 days are cleared and unread ones are left', async () => {
  const { mod, restore } = load()
  try {
    assert.equal(mod.getDbFilePath(), null)
    const prisma = fakePrisma()
    const before = Date.now()
    const result = await mod.pruneNotifications(prisma)
    assert.deepEqual(result, { notificationsDeleted: 7, days: 90 })
    assert.equal(prisma.calls.length, 1)
    const where = prisma.calls[0].where
    assert.equal(where.read, true)
    const age = before - where.createdAt.lt.getTime()
    assert.ok(Math.abs(age - 90 * DAY) < 5000, `cutoff is ${age / DAY} days back`)
    assert.deepEqual(Object.keys(where).sort(), ['createdAt', 'read'])
  } finally { restore() }
})

test('NOTIFICATION_KEEP_DAYS changes the age; 0 turns the trim off; nonsense falls back to 90', async () => {
  for (const [value, expected] of [['30', 30], ['365', 365], [' ', 90], ['abc', 90], ['-5', 90], ['45.9', 45]]) {
    const { mod, restore } = load({ NOTIFICATION_KEEP_DAYS: value })
    try { assert.equal(mod.publicNotificationKeepDays(), expected, `value ${JSON.stringify(value)}`) } finally { restore() }
  }
  const { mod, restore } = load({ NOTIFICATION_KEEP_DAYS: '0' })
  try {
    assert.equal(mod.publicNotificationKeepDays(), 0)
    const prisma = fakePrisma()
    assert.equal(await mod.pruneNotifications(prisma), null)
    assert.equal(prisma.calls.length, 0)
  } finally { restore() }
})

test('the scheduled pass trims once, and not again the same day', async () => {
  const { mod, restore } = load()
  try {
    const prisma = fakePrisma()
    await mod.checkAndRun(prisma)
    await mod.checkAndRun(prisma)
    assert.equal(prisma.calls.length, 1)
  } finally { restore() }
})

test('a failed trim is swallowed and does not stop the next pass', async () => {
  const { mod, restore } = load()
  try {
    const prisma = { notification: { deleteMany: async () => { throw new Error('connection reset') } } }
    assert.equal(await mod.checkAndRun(prisma), null)
  } finally { restore() }
})
