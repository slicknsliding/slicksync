// Household users added on AIOStreams' own page show up by themselves
// (server/utils/jellyfinProfiles.js refreshHousehold).
const test = require('node:test')
const assert = require('node:assert/strict')

require('../server/utils/jellyfinConnect').rememberSignIn = async () => {}
const jfAuth = require('../server/providers/jellyfinAuth')
const profiles = require('../server/utils/jellyfinProfiles')

const decrypt = (t) => String(t).replace(/^enc:/, '')
const encrypt = (t) => `enc:${t}`

function fake() {
  const rows = [{ id: 'jp1', ownerUserId: 'owner', jellyfinUserId: 'kid', name: 'Kid', token: 'enc:old', ownUserId: null }]
  const signIns = []
  jfAuth.listServerUsers = async () => [
    { id: 'main', name: 'MAIN', isMain: true, needsPin: false },
    { id: 'kid', name: 'Kid', isMain: false, needsPin: false },
    { id: 'neph', name: 'Nephews', isMain: false, needsPin: false },
  ]
  jfAuth.authenticateByName = async (url, name) => {
    signIns.push(name)
    const id = name.endsWith('/Nephews') ? 'neph' : name.endsWith('/Kid') ? 'kid' : 'main'
    return { serverUrl: url, token: `tok-${id}`, userId: id, userName: name }
  }
  const prisma = {
    jellyfinProfile: {
      findMany: async ({ where }) => rows.filter((r) => r.ownerUserId === where.ownerUserId),
      findUnique: async ({ where }) => rows.find((r) => r.ownerUserId === where.ownerUserId_jellyfinUserId.ownerUserId && r.jellyfinUserId === where.ownerUserId_jellyfinUserId.jellyfinUserId) || null,
      create: async ({ data }) => { rows.push({ id: `jp${rows.length + 1}`, ...data }); return rows.at(-1) },
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
    user: { findFirst: async () => null, updateMany: async () => ({}) },
  }
  return { rows, signIns, prisma }
}

const owner = { id: 'owner', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio.example.invalid/jellyfin', jellyfinToken: 'enc:main-token', jellyfinUserId: 'main', aioConfigId: 'uuid-1', aioConfigPassword: 'enc:pw' }

test('someone added on AIOStreams since is found and signed in; known ones are left alone', async () => {
  const { rows, signIns, prisma } = fake()
  const n = await profiles.refreshHousehold(prisma, decrypt, encrypt, owner)
  assert.equal(n, 1)
  const neph = rows.find((r) => r.jellyfinUserId === 'neph')
  assert.equal(neph.name, 'Nephews')
  assert.equal(neph.token, 'enc:tok-neph')
  assert.deepEqual(signIns, ['uuid-1/Nephews'])
  assert.equal(rows.find((r) => r.jellyfinUserId === 'kid').token, 'enc:old')
})

test('a second look soon after does nothing when asked to wait', async () => {
  const { signIns, prisma } = fake()
  const someone = { ...owner, id: 'owner-2' }
  await profiles.refreshHousehold(prisma, decrypt, encrypt, someone, { minIntervalMs: 60000 })
  const before = signIns.length
  assert.equal(await profiles.refreshHousehold(prisma, decrypt, encrypt, someone, { minIntervalMs: 60000 }), 0)
  assert.equal(signIns.length, before)
})

test('only AIOStreams and AIOMetadata sign-ins have households', async () => {
  const { prisma } = fake()
  assert.equal(await profiles.refreshHousehold(prisma, decrypt, encrypt, { ...owner, jellyfinServerKind: 'jellyfin' }), 0)
  assert.equal(await profiles.refreshHousehold(prisma, decrypt, encrypt, { ...owner, providerType: 'stremio' }), 0)
})

test('the main user is described with the name the server has for them, never the configuration UUID', async () => {
  jfAuth.currentUser = async () => ({ userId: 'main', userName: 'slicknslidin' })
  const main = await profiles.describeMain(decrypt, { ...owner, id: 'owner-main', username: 'Living Room', jellyfinUserName: 'uuid-1', avatarUrl: null })
  assert.deepEqual(main, { name: 'slicknslidin', avatarUrl: null, limitId: 'owner-main' })
  jfAuth.currentUser = async () => { throw new Error('offline') }
  const fallback = await profiles.describeMain(decrypt, { ...owner, id: 'owner-main-2', username: 'Living Room', jellyfinUserName: '3e5f4edd-d292-401f-a481-92d627d81fbe' })
  assert.equal(fallback.name, 'Living Room')
  assert.equal(await profiles.describeMain(decrypt, { ...owner, jellyfinServerKind: 'jellyfin' }), null)
})
