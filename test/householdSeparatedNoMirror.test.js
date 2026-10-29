// Separating a household profile makes it a person of its own, but not a second
// household: its own household check used to list everyone on the shared
// configuration again, the person it came from included, and the Users page
// showed two households mirroring each other
// (server/utils/jellyfinProfiles.js echoRows / refreshHousehold).
const test = require('node:test')
const assert = require('node:assert/strict')

require('../server/utils/jellyfinConnect').rememberSignIn = async () => {}
const jfAuth = require('../server/providers/jellyfinAuth')
const profiles = require('../server/utils/jellyfinProfiles')

const decrypt = (t) => String(t).replace(/^enc:/, '')
const encrypt = (t) => `enc:${t}`

function matches(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k])
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not
    return row[k] === v
  })
}

// Main owns the household; Nephews was in it, was separated (ownUserId), and
// then (the bug) got a household of his own that lists Main as separated.
function fake({ withEchoes = true } = {}) {
  const rows = [
    { id: 'a', accountId: 'acc', ownerUserId: 'main-person', jellyfinUserId: 'neph', name: 'Nephews', token: 'enc:t1', ownUserId: 'neph-person', skip: false, createdAt: new Date('2026-10-01') },
    { id: 'k', accountId: 'acc', ownerUserId: 'main-person', jellyfinUserId: 'kid', name: 'Kid', token: 'enc:t2', ownUserId: null, skip: false, createdAt: new Date('2026-10-01') },
  ]
  if (withEchoes) {
    rows.push(
      { id: 'b', accountId: 'acc', ownerUserId: 'neph-person', jellyfinUserId: 'main', name: 'MainPerson', token: 'enc:t3', ownUserId: 'main-person', skip: false, createdAt: new Date('2026-10-05') },
      { id: 'c', accountId: 'acc', ownerUserId: 'neph-person', jellyfinUserId: 'kid', name: 'Kid', token: 'enc:t2', ownUserId: null, skip: false, createdAt: new Date('2026-10-05') },
    )
  }
  const prisma = {
    jellyfinProfile: {
      findMany: async ({ where } = {}) => rows.filter((r) => matches(r, where)),
      deleteMany: async ({ where }) => { const gone = rows.filter((r) => matches(r, where)); gone.forEach((g) => rows.splice(rows.indexOf(g), 1)); return { count: gone.length } },
    },
    user: { findMany: async ({ where }) => [{ id: 'neph-person', username: 'Nephews' }, { id: 'main-person', username: 'MainPerson' }].filter((u) => matches(u, where)) },
  }
  return { rows, prisma }
}

test('a separated person does not show a household that mirrors the one they came from', async () => {
  const { prisma } = fake()
  const nephews = await profiles.describeHousehold(prisma, 'neph-person')
  assert.deepEqual(nephews, [])
  const main = await profiles.describeHousehold(prisma, 'main-person')
  assert.deepEqual(main.map((p) => [p.name, p.status]).sort(), [['Kid', 'tracked'], ['Nephews', 'own']])
})

test('only the real household is read for viewing', async () => {
  const { prisma } = fake()
  assert.deepEqual(await profiles.trackedProfiles(prisma, decrypt, 'neph-person'), [])
  assert.deepEqual((await profiles.trackedProfiles(prisma, decrypt, 'main-person')).map((p) => p.name), ['Kid'])
})

test('the person who owns the household is not a separated member, the one separated out is', async () => {
  const { prisma } = fake()
  assert.equal(await profiles.isSeparatedMember(prisma, 'neph-person'), true)
  assert.equal(await profiles.isSeparatedMember(prisma, 'main-person'), false)
})

test('a separated person does not look for a household of their own', async () => {
  const { prisma, rows } = fake({ withEchoes: false })
  let listed = 0
  jfAuth.listServerUsers = async () => { listed++; return [] }
  const nephews = { id: 'neph-person', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio.example.invalid/jellyfin', jellyfinToken: 'enc:t1', jellyfinUserId: 'neph', aioConfigId: 'uuid-1', aioConfigPassword: 'enc:pw' }
  assert.equal(await profiles.refreshHousehold(prisma, decrypt, encrypt, nephews), 0)
  assert.equal(listed, 0)
  assert.equal(rows.length, 2)
})

test('tidying removes the repeated rows, once, and leaves the real household alone', async () => {
  const { prisma, rows } = fake()
  assert.equal(await profiles.repairEchoedHouseholds(prisma, 'acc'), 2)
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'k'])
  assert.equal(await profiles.repairEchoedHouseholds(prisma, 'acc'), 0)
})

test('an ordinary separate/merge-back history is not mistaken for an echo', async () => {
  const { prisma, rows } = fake({ withEchoes: false })
  assert.equal(await profiles.repairEchoedHouseholds(prisma, 'acc'), 0)
  assert.equal(rows.length, 2)
  assert.equal((await profiles.describeHousehold(prisma, 'main-person')).length, 2)
})
