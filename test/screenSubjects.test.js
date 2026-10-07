const test = require('node:test')
const assert = require('node:assert/strict')
const st = require('../server/utils/screenTime')
const { getAccountDateString } = require('../server/utils/dateUtils')

const TZ = 'America/Los_Angeles'
const NOW = new Date('2026-10-05T19:00:00Z') // Monday noon in Los Angeles
const KID = 'np-nuv1-3'
const quiet = async () => {}

// One Nuvio login: Dad is its main profile's person; profile 3, "Kid", is
// merged into him (its viewing is recorded on Dad, labelled "Kid").
function family({ limits, activity, profiles = { [KID]: { name: 'Kid', sharesPrimary: false, at: NOW.toISOString() } } }) {
  const notes = []
  let sync = { accountTimezone: TZ, screenTime: limits, screenTimeProfiles: profiles }
  const dad = { id: 'dad', username: 'Dad', email: 'dad@example.invalid', providerType: 'nuvio', nuvioUserId: 'nuv1', nuvioProfileId: 1, isActive: true, jellyfinServerKind: null, accountId: 'acc', createdAt: new Date(0) }
  const day = new Date(getAccountDateString(NOW, TZ))
  const prisma = {
    appAccount: {
      findMany: async () => [{ id: 'acc', sync: JSON.stringify(sync) }],
      findUnique: async () => ({ sync: JSON.stringify(sync) }),
      findFirst: async () => ({ sync: JSON.stringify(sync) }),
      update: async ({ data }) => { sync = JSON.parse(data.sync) },
    },
    user: {
      findMany: async ({ where }) => {
        if (where.id?.in) return where.id.in.includes('dad') ? [dad] : []
        return where.nuvioUserId === 'nuv1' ? [dad] : []
      },
      findFirst: async ({ where }) => (where.id === 'dad' ? dad : null),
      findUnique: async ({ where }) => (where.id === 'dad' ? dad : null),
    },
    nuvioProfileRoute: { findMany: async () => [] },
    group: { count: async () => 1 },
    watchActivity: {
      groupBy: async ({ by, where }) => {
        const rows = activity.filter((a) => where.userId.in.includes(a.userId) && day <= day && (!where.profileLabel || a.label))
        const key = (a) => (by.includes('profileLabel') ? `${a.userId}|${a.label}` : a.userId)
        const sums = new Map()
        for (const a of rows) sums.set(key(a), { userId: a.userId, profileLabel: a.label || null, s: (sums.get(key(a))?.s || 0) + a.minutes * 60 })
        return [...sums.values()].map((r) => ({ userId: r.userId, profileLabel: r.profileLabel, _sum: { watchTimeSeconds: r.s } }))
      },
    },
    notification: {
      findUnique: async ({ where }) => notes.find((n) => n.dedupeKey === where.accountId_dedupeKey.dedupeKey) || null,
      upsert: async ({ create }) => (notes.push(create), create),
      create: async ({ data }) => (notes.push(data), data),
    },
  }
  return { prisma, notes, get sync() { return sync } }
}

test('a merged profile\'s own daily limit counts its own minutes, pauses only it, and alerts under its name', async () => {
  const w = family({
    limits: { [KID]: { minutes: 60, days: [], onReach: 'pause' } },
    activity: [{ userId: 'dad', label: 'Kid', minutes: 65 }, { userId: 'dad', label: 'Main', minutes: 20 }],
  })
  const wrapped = []
  const synced = []
  const deps = {
    gateUsable: async () => ({ ok: true }),
    wrapProfile: async (_p, _a, person, want) => { wrapped.push([person.id, want]) },
    syncPerson: async (_p, _a, id) => { synced.push(id) },
  }
  await st.checkScreenTime(w.prisma, { now: NOW, emit: quiet, deps })
  assert.ok(w.sync.screenTimePauses[KID]?.until, 'Kid is paused')
  assert.equal(w.sync.screenTimePauses.dad, undefined, 'Dad is not')
  assert.deepEqual(wrapped, [[KID, true]], 'Kid\'s stream addons went behind the gate, once')
  assert.deepEqual(synced, [], 'nobody\'s addon list was synced - the gate does the pausing')
  assert.ok(w.notes.some((n) => /^Kid reached today's 60-minute limit/.test(n.title) && n.url === '/users/dad'))

  await st.checkScreenTime(w.prisma, { now: new Date(NOW.getTime() + 60000), emit: quiet, deps })
  assert.deepEqual(wrapped, [[KID, true]], 'not again')
})

test('the person a profile is merged into stops counting its minutes once it has a limit of its own', async () => {
  const activity = [{ userId: 'dad', label: 'Kid', minutes: 65 }, { userId: 'dad', label: 'Main', minutes: 20 }]
  const w = family({ limits: { dad: { minutes: 600, days: [] }, [KID]: { minutes: 60, days: [] } }, activity })
  const dad = await st.getLimit(w.prisma, 'acc', 'dad', { gateUsable: async () => ({ ok: true }) })
  const kid = await st.getLimit(w.prisma, 'acc', KID, { gateUsable: async () => ({ ok: true }) })
  assert.equal(kid.todayMinutes, 65)
  assert.equal(dad.todayMinutes, 20, '85 minutes recorded on Dad, 65 of them Kid\'s')
  assert.deepEqual(kid.profileOf, { name: 'Dad', kind: 'nuvio-profile' })
})

test('a profile on the main profile\'s addons can only alert', async () => {
  const w = family({
    limits: { [KID]: { minutes: 60, days: [], onReach: 'pause' } },
    activity: [{ userId: 'dad', label: 'Kid', minutes: 65 }],
    profiles: { [KID]: { name: 'Kid', sharesPrimary: true, at: NOW.toISOString() } },
  })
  const view = await st.getLimit(w.prisma, 'acc', KID, { gateUsable: async () => ({ ok: true }) })
  assert.equal(view.canPause.ok, false)
  assert.equal(view.canPause.code, 'shares-addons')
  const wrapped = []
  await st.checkScreenTime(w.prisma, { now: NOW, emit: quiet, deps: { gateUsable: async () => ({ ok: true }), wrapProfile: async (...a) => { wrapped.push(a) } } })
  assert.equal(w.sync.screenTimePauses?.[KID], undefined, 'not paused')
  assert.ok(w.notes.some((n) => /^Kid reached/.test(n.title)), 'but you are told')
})

test('without a gate devices can reach, a profile can\'t be paused - and says why', async () => {
  const w = family({ limits: { [KID]: { bedtime: { from: '09:00', to: '23:00', days: [] } } }, activity: [] })
  const view = await st.getLimit(w.prisma, 'acc', KID, { gateUsable: async () => ({ ok: false }) })
  assert.equal(view.canPause.code, 'needs-address')
})
