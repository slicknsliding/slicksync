// AIOStreams' newer household shape (server/utils/aioProfiles.js): from the
// November 2026 nightlies a configuration keeps everyone in config.profiles,
// the owner first with id '', instead of config.jellyfin.primary and
// config.jellyfin.personas. The fake below converts and discards the way
// AIOStreams' own migrateProfiles does, on every read and every save, so a
// write in the old shape is lost here exactly as it would be there.
const test = require('node:test')
const assert = require('node:assert/strict')

const dns = require('node:dns').promises
const realLookup = dns.lookup
dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }]
test.after(() => { dns.lookup = realLookup })

const layout = require('../server/utils/aioProfiles')
const hh = require('../server/utils/aioHousehold')
const { setAioPaused, PAUSE_VARIANT } = require('../server/utils/aioPause')
const { summarize } = require('../server/utils/aiostreamsConfig')
const { merge } = require('../server/utils/aioConfigHistory')
const trax = require('../server/utils/aioSlickTrax')

const UUID = '0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b'
const HASH = '$2b$10$' + 'a'.repeat(53)
const clone = (v) => JSON.parse(JSON.stringify(v))

// AIOStreams' migrateProfiles (packages/core/src/utils/profiles.ts), as of nightly 2026.11.18.2327.
function migrateProfiles(config) {
  const jellyfin = config?.jellyfin
  if (!jellyfin || (!jellyfin.primary && !jellyfin.personas)) return config
  const { primary, personas, ...rest } = jellyfin
  config.jellyfin = rest
  if (config.profiles) return config
  config.profiles = [{ ...primary, id: '' }, ...(Array.isArray(personas) ? personas : [])]
  return config
}

function fakeNightly(config, { max = 20 } = {}) {
  config = migrateProfiles(clone(config))
  const saved = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (u.pathname === '/api/v1/status') return json(200, { success: true, data: { settings: { jellyfin: { maxProfiles: max } } } })
    if (u.pathname === '/api/v1/user' && opts.method === 'PUT') {
      config = migrateProfiles(JSON.parse(opts.body).config)
      saved.push(clone(config))
      return json(200, { success: true })
    }
    if (u.pathname === '/api/v1/user') return json(200, { success: true, data: { userData: migrateProfiles(clone(config)) } })
    if (u.pathname.endsWith('/Users/AuthenticateByName')) {
      const body = JSON.parse(opts.body)
      const p = (config.profiles || []).find((x) => x.id && body.Username.endsWith(x.name))
      return json(200, { AccessToken: 'tok', User: { Id: hh.personaUserId(UUID, p?.id), Name: body.Username } })
    }
    return json(404, {})
  }
  return { saved, now: () => config, restore: () => { global.fetch = original } }
}

const owner = (extra = {}) => ({
  id: 'o1', username: 'Sam', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams',
  jellyfinServerUrl: 'https://aio.example.com/jellyfin', aioConfigId: UUID, aioConfigPassword: 'enc', ...extra,
})

function db(ownerRow = owner()) {
  const profiles = []
  return {
    profiles,
    user: { update: async () => ({}), findUnique: async () => ({ aioConfigStateJson: '{}' }), findMany: async () => [], findFirst: async () => ownerRow, updateMany: async () => ({}) },
    jellyfinProfile: {
      findUnique: async ({ where }) => profiles.find((p) => p.jellyfinUserId === where.ownerUserId_jellyfinUserId.jellyfinUserId) || null,
      create: async ({ data }) => { profiles.push({ id: `p${profiles.length + 1}`, ...data }); return data },
      update: async ({ where, data }) => Object.assign(profiles.find((p) => p.id === where.id) || {}, data),
      findMany: async () => [],
    },
    aioConfigSnapshot: { findFirst: async () => null, create: async () => ({}), findMany: async () => [], deleteMany: async () => ({}) },
  }
}
const decrypt = () => 'secret'
const encrypt = (v) => `enc:${v}`

const household = () => ({
  uuid: UUID,
  jellyfin: { primary: { name: 'Sam' }, personas: [{ id: 'leo', name: 'Leo', history: 'own', lock: HASH, trackers: ['st1'] }] },
})

test('layout: both shapes read the same people', () => {
  const old = household()
  const now = migrateProfiles(clone(old))
  for (const c of [old, now]) {
    assert.deepEqual(layout.othersOf(c).map((p) => p.id), ['leo'])
    assert.equal(layout.ownerOf(c).name, 'Sam')
  }
  assert.equal(layout.usesProfiles(old), false)
  assert.equal(layout.usesProfiles(now), true)
  assert.equal(layout.ownerOf({}), null)
  assert.deepEqual(layout.othersOf({}), [])
})

test('layout: the limit is read under either name', () => {
  assert.equal(layout.maxFromStatus({ jellyfin: { maxProfiles: 7 } }), 7)
  assert.equal(layout.maxFromStatus({ jellyfin: { maxPersonas: 5 } }), 5)
  assert.equal(layout.maxFromStatus({}), 0)
})

test('layout: AIOStreams switching shapes is not a change', () => {
  const old = household()
  const now = migrateProfiles(clone(old))
  assert.equal(summarize(now).hash, summarize(old).hash)
  assert.deepEqual(summarize(now).users, ['Leo'])
  // A real change still shows.
  now.profiles[1].name = 'Leon'
  assert.notEqual(summarize(now).hash, summarize(old).hash)
})

test('add: a new household user reaches a newer AIOStreams', async () => {
  const s = fakeNightly(household())
  const prisma = db()
  try {
    const out = await hh.addPersona(prisma, decrypt, encrypt, owner(), { name: 'Mia', pin: '1234', history: 'own' })
    assert.equal(out.tracked, true)
    const saved = s.saved[0]
    assert.deepEqual(saved.profiles.map((p) => p.id), ['', 'leo', 'mia'], 'Mia kept, after the owner and Leo')
    assert.deepEqual(saved.profiles[1], { id: 'leo', name: 'Leo', history: 'own', lock: HASH, trackers: ['st1'] }, 'Leo untouched')
    assert.deepEqual(saved.profiles[2], { id: 'mia', name: 'Mia', history: 'own', lock: '1234' })
    assert.equal(prisma.profiles[0].jellyfinUserId, hh.personaUserId(UUID, 'mia'))
  } finally { s.restore() }
})

test('add: names already taken, the owner\'s included, are refused on a newer AIOStreams', async () => {
  const s = fakeNightly(household())
  try {
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'sam' }), /already a household user called sam/)
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Leo' }), /already a household user called Leo/)
    assert.equal(s.saved.length, 0)
  } finally { s.restore() }
})

test('add: the limit under its newer name', async () => {
  const s = fakeNightly(household(), { max: 1 })
  try {
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Mia' }), /allows 1 household users, and there are 1 already/)
  } finally { s.restore() }
})

test('PIN and separate address on a newer AIOStreams', async () => {
  const s = fakeNightly(household())
  const prisma = db()
  const profile = { id: 'p9', name: 'Leo', jellyfinUserId: hh.personaUserId(UUID, 'leo') }
  prisma.profiles.push(profile)
  try {
    await hh.setPersonaPin(prisma, decrypt, encrypt, owner(), profile, '5678')
    assert.equal(s.now().profiles[1].lock, '5678')
    const info = await hh.setPersonaSeparation(prisma, decrypt, owner(), profile, 'on')
    assert.equal(info.separate, true)
    assert.match(info.address, /^[a-z0-9]{10}$/)
    assert.equal(s.now().profiles[1].address, info.address)
    const settings = await hh.personalSettings(decrypt, owner(), [profile])
    assert.equal(settings.p9.address, info.address)
  } finally { s.restore() }
})

test('pause and unpause on a newer AIOStreams: the owner and a household user', async () => {
  const s = fakeNightly({ ...household(), presets: [{ type: 'torrentio', instanceId: 'a1', options: {} }] })
  const prisma = db()
  const asOwner = { id: 'x1', username: 'Sam', subject: { kind: 'household', ownerId: 'o1', jellyfinUserId: UUID.replace(/-/g, '') } }
  const asLeo = { id: 'x2', username: 'Leo', subject: { kind: 'household', ownerId: 'o1', jellyfinUserId: hh.personaUserId(UUID, 'leo') } }
  try {
    await setAioPaused(prisma, 'acc', asOwner, true, { decrypt })
    await setAioPaused(prisma, 'acc', asLeo, true, { decrypt })
    let c = s.now()
    assert.deepEqual(c.profiles[0].variants, [PAUSE_VARIANT], 'the owner is paused')
    assert.deepEqual(c.profiles[1].variants, [PAUSE_VARIANT], 'Leo is paused')
    assert.ok(c.variants.some((v) => v.id === PAUSE_VARIANT))
    assert.equal(c.jellyfin?.primary, undefined)
    assert.equal(c.jellyfin?.personas, undefined)

    await setAioPaused(prisma, 'acc', asOwner, false, { decrypt, users: [] })
    c = s.now()
    assert.equal(c.profiles[0].variants, undefined)
    assert.ok(c.variants.some((v) => v.id === PAUSE_VARIANT), 'kept while Leo is still paused')
    await setAioPaused(prisma, 'acc', asLeo, false, { decrypt, users: [] })
    c = s.now()
    assert.equal(c.variants, undefined, 'gone once nobody is paused')
    assert.equal(c.profiles[1].variants, undefined)
  } finally { s.restore() }
})

test('pause: an owner entry made only for the pause is taken away again', async () => {
  const s = fakeNightly({ uuid: UUID, jellyfin: { personas: [{ id: 'leo', name: 'Leo', history: 'own' }] }, presets: [] })
  const prisma = db()
  const asOwner = { id: 'x1', username: 'Sam', subject: { kind: 'household', ownerId: 'o1', jellyfinUserId: UUID.replace(/-/g, '') } }
  try {
    // AIOStreams' conversion makes an owner entry with nothing but its id.
    assert.deepEqual(s.now().profiles[0], { id: '' })
    await setAioPaused(prisma, 'acc', asOwner, true, { decrypt })
    assert.deepEqual(s.now().profiles[0].variants, [PAUSE_VARIANT])
    await setAioPaused(prisma, 'acc', asOwner, false, { decrypt, users: [] })
    assert.deepEqual(s.now().profiles.map((p) => p.id), ['leo'])
  } finally { s.restore() }
})

test('putting back an old-shape version keeps the household as it is now, and SlickSync\'s own variants', () => {
  const old = {
    variants: [{ id: 'stremio', script: 'x' }],
    jellyfin: { primary: { name: 'Old' }, personas: [{ id: 'gone', name: 'Gone' }] },
  }
  const current = {
    variants: [{ id: 'slicksync-pause', script: 'pause' }],
    jellyfin: {},
    profiles: [{ id: '', name: 'Sam', variants: ['slicksync-pause'] }, { id: 'leo', name: 'Leo' }],
  }
  const next = merge(old, current)
  assert.deepEqual(next.profiles.map((p) => p.id), ['', 'leo'])
  assert.equal(next.jellyfin.primary, undefined, 'no old fields for AIOStreams to throw away')
  assert.equal(next.jellyfin.personas, undefined)
  assert.deepEqual(next.profiles[0].variants, ['slicksync-pause'])
  assert.deepEqual(next.variants.map((v) => v.id), ['stremio', 'slicksync-pause'])
})

test('SlickTrax: a household user whose trackers leave it out is noticed on a newer AIOStreams', async () => {
  const config = migrateProfiles({
    presets: [{ type: 'custom', instanceId: 'st1', options: { manifestUrl: 'https://slicksync.example.com/trax/tok/aio/manifest.json' } }],
    jellyfin: { primary: { name: 'Sam', trackers: ['other'] }, personas: [{ id: 'leo', name: 'Leo', history: 'own', trackers: ['other'] }, { id: 'mia', name: 'Mia', history: 'shared' }] },
  })
  const problems = await trax.findProblems({}, { username: 'Sam', traxToken: 'tok' }, config)
  const p = problems.find((x) => x.kind === 'trackers')
  assert.ok(p, 'noticed')
  assert.match(p.body, /^Sam, Leo:/)
})
