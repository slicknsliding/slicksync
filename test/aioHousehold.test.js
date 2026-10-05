// Adding AIOStreams household users and changing their PINs
// (server/utils/aioHousehold.js). Shapes follow AIOStreams 2.35.
const test = require('node:test')
const assert = require('node:assert/strict')
const hh = require('../server/utils/aioHousehold')

// Read from a throwaway AIOStreams 2.35.9 test instance: its configuration
// UUID, a persona id, and the Jellyfin user id it listed for that persona.
test('a household user\'s Jellyfin id is AIOStreams\' own, from the persona id', () => {
  assert.equal(hh.personaUserId('d087810f-5f04-4f2e-9a72-825ed5a42da6', 'mia'), '1dbb56e19a478002ccda8bd044e6751a')
})

const UUID = '0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b'
const HASH = '$2b$10$' + 'a'.repeat(53)
const owner = (extra = {}) => ({
  id: 'o1', username: 'Sam', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams',
  jellyfinServerUrl: 'https://aio.example.com/jellyfin', aioConfigId: UUID, aioConfigPassword: 'enc', ...extra,
})

function fakeAio(config, { maxPersonas = 20, signIn = true } = {}) {
  const saved = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (u.pathname === '/api/v1/status') return json(200, { success: true, data: { settings: { jellyfin: { maxPersonas } } } })
    if (u.pathname === '/api/v1/user' && opts.method === 'PUT') {
      config = JSON.parse(opts.body).config
      saved.push(JSON.parse(JSON.stringify(config)))
      return json(200, { success: true })
    }
    if (u.pathname === '/api/v1/user') return json(200, { success: true, data: { userData: JSON.parse(JSON.stringify(config)) } })
    if (u.pathname.endsWith('/Users/AuthenticateByName')) {
      if (!signIn) return json(401, { Message: 'Invalid PIN' })
      const body = JSON.parse(opts.body)
      const personaId = (config.jellyfin.personas || []).find((p) => body.Username.endsWith(p.name))?.id
      return json(200, { AccessToken: 'tok', User: { Id: hh.personaUserId(UUID, personaId), Name: body.Username } })
    }
    return json(404, {})
  }
  return { saved, restore: () => { global.fetch = original } }
}

function db() {
  const profiles = []
  return {
    profiles,
    user: { update: async () => ({}), findUnique: async () => ({ aioConfigStateJson: '{}' }), findMany: async () => [], findFirst: async () => null, updateMany: async () => ({}) },
    jellyfinProfile: {
      findUnique: async ({ where }) => profiles.find((p) => p.jellyfinUserId === where.ownerUserId_jellyfinUserId.jellyfinUserId) || null,
      create: async ({ data }) => { profiles.push({ id: `p${profiles.length + 1}`, ...data }); return data },
      update: async ({ where, data }) => Object.assign(profiles.find((p) => p.id === where.id), data),
    },
  }
}
const decrypt = () => 'secret'
const encrypt = (v) => `enc:${v}`

test('add: a new household user, everything else sent back as it was read', async () => {
  const s = fakeAio({ uuid: UUID, jellyfin: { primary: { name: 'Sam' }, personas: [{ id: 'leo', name: 'Leo', history: 'own', lock: HASH, trackers: ['st1'] }] } })
  const prisma = db()
  try {
    assert.deepEqual(await hh.addPersona(prisma, decrypt, encrypt, owner(), { name: 'Mia', pin: '1234', history: 'own' }), { tracked: true })
    const personas = s.saved[0].jellyfin.personas
    assert.deepEqual(personas[0], { id: 'leo', name: 'Leo', history: 'own', lock: HASH, trackers: ['st1'] }, 'Leo\'s PIN hash and trackers untouched')
    assert.deepEqual(personas[1], { id: 'mia', name: 'Mia', history: 'own', lock: '1234' }, 'a plain PIN - AIOStreams hashes it')
    assert.equal(prisma.profiles[0].jellyfinUserId, hh.personaUserId(UUID, 'mia'))
    assert.equal(prisma.profiles[0].token, 'enc:tok', 'tracked straight away')
  } finally { s.restore() }
})

test('add: a shared one never gets trackers; refusals before anything is written', async () => {
  const s = fakeAio({ uuid: UUID, jellyfin: { primary: { name: 'Sam' }, personas: [] } }, { maxPersonas: 1 })
  try {
    await hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Guest', history: 'shared' })
    assert.deepEqual(s.saved[0].jellyfin.personas[0], { id: 'guest', name: 'Guest', history: 'shared' })
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Ada' }), /allows 1 household users/)
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'guest' }), /already a household user called guest/)
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Sam' }), /already a household user/)
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner(), { name: 'Bo', pin: '12' }), /4 to 12 digits/)
    await assert.rejects(hh.addPersona(db(), decrypt, encrypt, owner({ aioConfigPassword: null }), { name: 'Bo' }), /configuration password/)
    assert.equal(s.saved.length, 1)
  } finally { s.restore() }
})

test('PIN: found by id even after a rename; removed; a failed sign-in asks for the PIN', async () => {
  const s = fakeAio({ uuid: UUID, jellyfin: { personas: [{ id: 'mia', name: 'Mia Renamed', history: 'own', lock: HASH }] } })
  const prisma = db()
  prisma.profiles.push({ id: 'p1', jellyfinUserId: hh.personaUserId(UUID, 'mia'), name: 'Mia', token: 'old' })
  try {
    assert.deepEqual(await hh.setPersonaPin(prisma, decrypt, encrypt, owner(), prisma.profiles[0], '98765'), { tracked: true })
    assert.equal(s.saved[0].jellyfin.personas[0].lock, '98765')
    await hh.setPersonaPin(prisma, decrypt, encrypt, owner(), prisma.profiles[0], null)
    assert.equal('lock' in s.saved[1].jellyfin.personas[0], false)
  } finally { s.restore() }

  const refused = fakeAio({ uuid: UUID, jellyfin: { personas: [{ id: 'mia', name: 'Mia', history: 'own' }] } }, { signIn: false })
  const p2 = db()
  p2.profiles.push({ id: 'p1', jellyfinUserId: hh.personaUserId(UUID, 'mia'), name: 'Mia', token: 'old' })
  try {
    assert.deepEqual(await hh.setPersonaPin(p2, decrypt, encrypt, owner(), p2.profiles[0], '4321'), { tracked: false })
    assert.equal(p2.profiles[0].token, null)
    assert.equal(p2.profiles[0].needsPin, true)
  } finally { refused.restore() }
})
