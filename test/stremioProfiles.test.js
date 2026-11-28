// Stremio profiles: each one a sign-in of its own, read for the person it
// counts for. server/utils/stremioProfiles.js, with the shared rules in
// server/utils/nuvioProfiles.js.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-long'
const sp = require('../server/utils/stremioProfiles')
const np = require('../server/utils/nuvioProfiles')
const { encrypt, decrypt } = require('../server/utils/encryption')

const ACC = 'acc'
const req = { appAccountId: ACC }
const MAIN_ID = 'stremio-main-id'

/** Stremio's API, answered rather than called. */
function fakeStremio({ profiles = {}, pins = {}, parentOf = {} } = {}) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    const method = String(url).split('/api/')[1]
    const body = JSON.parse(opts.body)
    calls.push({ method, body })
    const json = (result, error) => ({ ok: true, status: 200, json: async () => (error ? { error } : { result }) })
    if (method === 'getUser') {
      if (body.authKey === 'dead') return json(null, { message: 'Session does not exist', code: 1 })
      if (parentOf[body.authKey]) return json({ _id: parentOf[body.authKey].id, parent_id: MAIN_ID })
      return json({ _id: MAIN_ID, premiumPrefs: { userProfiles: profiles }, features: { profiles: 3 } })
    }
    if (method === 'premiumPrefs/authenticateProfile') {
      const want = pins[body.profileId]
      if (want && body.pin !== want) return json(null, { message: 'Invalid profile PIN', code: 2 })
      return json({ authKey: `key-${body.profileId}`, user: { _id: body.profileId, parent_id: MAIN_ID } })
    }
    return json(null, { message: `unexpected ${method}`, code: 0 })
  }
  return { calls, restore: () => { global.fetch = original } }
}

function fakePrisma({ users = [], rows = [], routes = [] } = {}) {
  let n = 0
  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gt' in v) return row[k] > v.gt
      if ('not' in v) return row[k] !== v.not
      if ('in' in v) return v.in.includes(row[k])
    }
    return (row[k] ?? null) === (v ?? null)
  })
  return {
    _users: users, _rows: rows,
    user: {
      findMany: async ({ where }) => users.filter((u) => matches(u, where)),
      update: async ({ where, data }) => Object.assign(users.find((u) => u.id === where.id), data),
    },
    stremioProfile: {
      findMany: async ({ where }) => rows.filter((r) => matches(r, where)),
      findFirst: async ({ where }) => rows.find((r) => matches(r, where)) || null,
      create: async ({ data }) => { const row = { id: `row${++n}`, authKey: null, pin: null, ...data }; rows.push(row); return row },
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
      delete: async ({ where }) => { rows.splice(rows.findIndex((r) => r.id === where.id), 1) },
    },
    nuvioProfileRoute: {
      findMany: async ({ where }) => routes.filter((r) => matches(r, where)),
    },
  }
}

const mainUser = (extra = {}) => ({
  id: 'u-main', username: 'Sam', email: 'sam@example.com', accountId: ACC, providerType: 'stremio',
  stremioAuthKey: encrypt('main-key', req), stremioAccountId: null, stremioProfileId: null, nuvioProfileId: 1,
  isActive: true, createdAt: new Date(0), ...extra,
})

test('readAccount: the main profile comes first, and an account with no list still has its main one', async () => {
  const api = fakeStremio({ profiles: { kid: { name: 'Kids', hasPin: false }, [MAIN_ID]: { name: 'Sam', hasPin: false } } })
  try {
    const account = await sp.readAccount('main-key')
    assert.equal(account.id, MAIN_ID)
    assert.deepEqual(account.profiles.map((p) => [p.profileId, p.isMain]), [[MAIN_ID, true], ['kid', false]])
    assert.equal(account.limit, 3)
  } finally { api.restore() }

  const bare = fakeStremio({ profiles: {} })
  try {
    const account = await sp.readAccount('main-key')
    assert.deepEqual(account.profiles.map((p) => p.profileId), [MAIN_ID])
  } finally { bare.restore() }
})

test('readAccount: a profile\'s own key says it is a profile, and a dead key throws Stremio\'s words', async () => {
  const api = fakeStremio({ parentOf: { 'key-kid': { id: 'kid' } } })
  try {
    const account = await sp.readAccount('key-kid')
    assert.equal(account.isProfileKey, true)
    assert.equal(account.id, MAIN_ID)
    await assert.rejects(() => sp.readAccount('dead'), /Session does not exist/)
  } finally { api.restore() }
})

test('syncProfiles: gives every profile a slot, opens the ones without a PIN, leaves a PIN profile closed', async () => {
  const api = fakeStremio({
    profiles: { [MAIN_ID]: { name: 'Sam' }, kid: { name: 'Kids', hasPin: false }, guest: { name: 'Guest', hasPin: true } },
    pins: { guest: '4321' },
  })
  const user = mainUser()
  const prisma = fakePrisma({ users: [user] })
  try {
    const { rows } = await sp.syncProfiles(prisma, { accountId: ACC, mainUser: user, authKey: 'main-key' })
    assert.equal(user.stremioAccountId, MAIN_ID)
    assert.deepEqual(rows.map((r) => [r.name, r.slot]), [['Sam', 1], ['Kids', 2], ['Guest', 3]])
    assert.equal(rows[0].authKey, null, 'the main profile is the account\'s own sign-in')
    assert.equal(decrypt(rows[1].authKey, req), 'key-kid')
    assert.equal(rows[2].authKey, null, 'a PIN nobody gave stays closed')
    assert.equal(api.calls.filter((c) => c.method === 'premiumPrefs/authenticateProfile').length, 1, 'never guesses at a PIN')

    // A second look asks for nothing it already has, and keeps the slots.
    const again = await sp.syncProfiles(prisma, { accountId: ACC, mainUser: user, authKey: 'main-key' })
    assert.deepEqual(again.rows.map((r) => r.slot), [1, 2, 3])
    assert.equal(api.calls.filter((c) => c.method === 'premiumPrefs/authenticateProfile').length, 1)
  } finally { api.restore() }
})

test('syncProfiles: a profile deleted in Stremio is forgotten, unless a person here was made for it', async () => {
  const user = mainUser({ stremioAccountId: MAIN_ID })
  const maya = mainUser({ id: 'u-maya', username: 'Maya', stremioAccountId: MAIN_ID, stremioProfileId: 'maya', nuvioProfileId: 3 })
  const prisma = fakePrisma({
    users: [user, maya],
    rows: [
      { id: 'r1', accountId: ACC, stremioAccountId: MAIN_ID, profileId: MAIN_ID, slot: 1, name: 'Sam', hasPin: false, canManageAddons: true, authKey: null, pin: null },
      { id: 'r2', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'gone', slot: 2, name: 'Old', hasPin: false, canManageAddons: true, authKey: 'x', pin: null },
      { id: 'r3', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'maya', slot: 3, name: 'Maya', hasPin: false, canManageAddons: true, authKey: 'x', pin: null },
    ],
  })
  const api = fakeStremio({ profiles: { [MAIN_ID]: { name: 'Sam' }, fresh: { name: 'New' } } })
  try {
    const { rows } = await sp.syncProfiles(prisma, { accountId: ACC, mainUser: user, authKey: 'main-key' })
    assert.deepEqual(prisma._rows.map((r) => r.profileId).sort(), [MAIN_ID, 'fresh', 'maya'].sort())
    // Slot 3 belongs to Maya's person, so the new profile takes the free one.
    assert.equal(rows.find((r) => r.profileId === 'fresh').slot, 2)
  } finally { api.restore() }
})

test('unlockProfile: the right PIN keeps the key and the PIN, a wrong one says so plainly', async () => {
  const row = { id: 'r9', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'guest', slot: 3, name: 'Guest', hasPin: true, authKey: null, pin: null }
  const prisma = fakePrisma({ rows: [row] })
  const api = fakeStremio({ pins: { guest: '4321' } })
  try {
    await assert.rejects(() => sp.unlockProfile(prisma, { accountId: ACC, authKey: 'main-key', row, pin: '0000' }), (e) => e.status === 400 && /PIN/.test(e.message))
    assert.equal(row.authKey, null)
    await sp.unlockProfile(prisma, { accountId: ACC, authKey: 'main-key', row, pin: '4321' })
    assert.equal(decrypt(row.authKey, req), 'key-guest')
    assert.equal(decrypt(row.pin, req), '4321')
  } finally { api.restore() }
})

test('trackedLogins: a merged profile is read for the main person, under its own id and name', async () => {
  const user = mainUser({ stremioAccountId: MAIN_ID })
  const prisma = fakePrisma({
    users: [user],
    rows: [
      { id: 'r1', accountId: ACC, stremioAccountId: MAIN_ID, profileId: MAIN_ID, slot: 1, name: 'Sam', authKey: null },
      { id: 'r2', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'kid', slot: 2, name: 'Kids', authKey: 'enc-kid' },
      { id: 'r3', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'guest', slot: 3, name: 'Guest', authKey: null },
    ],
  })
  const logins = await sp.trackedLogins(prisma, ACC, [user])
  assert.equal(logins.length, 1, 'the main profile is the person; the locked one cannot be read')
  assert.equal(logins[0].id, 'sp-r2')
  assert.equal(logins[0].stremioAuthKey, 'enc-kid')
  assert.equal(logins[0].__recordAs, 'u-main')
  assert.equal(logins[0].__profileLabel, 'Kids')
})

test('trackedLogins: a separated profile is its own person, and a profile that is not tracked is left alone', async () => {
  const user = mainUser({ stremioAccountId: MAIN_ID })
  const maya = mainUser({ id: 'u-maya', username: 'Maya', stremioAccountId: MAIN_ID, stremioProfileId: 'maya', nuvioProfileId: 2, createdAt: new Date(5) })
  const rows = [
    { id: 'r2', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'maya', slot: 2, name: 'Maya', authKey: 'enc-maya' },
    { id: 'r3', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'kid', slot: 3, name: 'Kids', authKey: 'enc-kid' },
    { id: 'r4', accountId: ACC, stremioAccountId: MAIN_ID, profileId: 'tv', slot: 4, name: 'TV', authKey: 'enc-tv' },
  ]
  const key = sp.groupKey(MAIN_ID)
  const prisma = fakePrisma({
    users: [user, maya],
    rows,
    routes: [
      { accountId: ACC, nuvioUserId: key, profileIndex: 3, skip: true, targetUserId: null },
      { accountId: ACC, nuvioUserId: key, profileIndex: 4, skip: false, targetUserId: 'u-maya' },
    ],
  })
  const logins = await sp.trackedLogins(prisma, ACC, [user, maya])
  assert.deepEqual(logins.map((l) => [l.__profileLabel, l.__recordAs]), [['TV', 'u-maya']])
})

test('the shared rules: people on one Stremio account are found by its group key', async () => {
  const user = mainUser({ stremioAccountId: MAIN_ID })
  const maya = mainUser({ id: 'u-maya', stremioAccountId: MAIN_ID, stremioProfileId: 'maya', nuvioProfileId: 2 })
  const other = mainUser({ id: 'u-other', stremioAccountId: 'someone-else' })
  const nuvio = { id: 'u-nuvio', accountId: ACC, providerType: 'nuvio', nuvioUserId: 'n1', nuvioProfileId: 1, createdAt: new Date(0) }
  const prisma = fakePrisma({ users: [maya, user, other, nuvio] })
  assert.equal(np.groupKeyOf(user), sp.groupKey(MAIN_ID))
  assert.equal(np.groupKeyOf(nuvio), 'n1')
  assert.equal(np.groupKeyOf(mainUser()), null, 'an account never read has no group yet')
  const siblings = await np.loadSiblings(prisma, ACC, sp.groupKey(MAIN_ID))
  assert.deepEqual(siblings.map((s) => s.id), ['u-main', 'u-maya'])
  assert.deepEqual((await np.loadSiblings(prisma, ACC, 'n1')).map((s) => s.id), ['u-nuvio'])
})

test('labelLibrary: every title carries the profile\'s name and nothing else changes', () => {
  const library = [{ _id: 'tt1', state: { timeWatched: 5 } }, { _id: 'tt2' }]
  const labelled = sp.labelLibrary(library, 'Kids')
  assert.deepEqual(labelled, [{ _id: 'tt1', state: { timeWatched: 5, profileLabel: 'Kids' } }, { _id: 'tt2', state: { profileLabel: 'Kids' } }])
  assert.equal(library[0].state.profileLabel, undefined, 'the library read is not changed in place')
  assert.equal(sp.labelLibrary(library, null), library)
})

test('freeSlot and colors: the lowest free slot from 2, and a color for every slot', () => {
  assert.equal(sp.freeSlot(new Set([1])), 2)
  assert.equal(sp.freeSlot(new Set([1, 2, 3, 5])), 4)
  for (const slot of [1, 2, 7, 40]) assert.match(sp.colorForSlot(slot), /^#[0-9a-f]{6}$/)
})
