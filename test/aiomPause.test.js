// A pause on AIOMetadata points the person's users at SlickSync's "paused"
// stream addon. The main user's address is the configuration's own, which
// household users without one of their own also use - so pausing the main
// user must leave the rest of the household playing, and ending any pause
// must put back exactly what was there, never what the household changed
// meanwhile.
const test = require('node:test')
const assert = require('node:assert/strict')

// Stand-ins, in place before aiomPause picks them up.
const household = require('../server/utils/aiometadataHousehold')
let stored
household.readConfig = async () => JSON.parse(JSON.stringify(stored))
household.writeConfig = async (_access, config) => { stored = JSON.parse(JSON.stringify(config)) }
require('../server/utils/serverAvatars').publicBase = async () => 'https://sync.example.com'
const { setAiomPaused } = require('../server/utils/aiomPause')

const UUID = '11111111-2222-3333-4444-555555555555'
const MAIN = UUID.replace(/-/g, '')
const PAUSED = 'https://sync.example.com/trax/paused/manifest.json'
const STREAMS = 'https://aio.example.com/stremio/abc/manifest.json'
const OWN = 'https://other.example.com/manifest.json'

const owner = { id: 'owner', username: 'Owner', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiometadata', jellyfinServerUrl: `https://meta.example.com/jellyfin/${UUID}`, jellyfinUserId: MAIN, aioConfigId: UUID, aioConfigPassword: 'enc' }
const kidId = household.userIdFor(UUID, 'kid')
const kid = { id: 'kid-person', username: 'Kid', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiometadata', jellyfinServerUrl: owner.jellyfinServerUrl, jellyfinUserId: kidId }

const prisma = {
  user: { findFirst: async ({ where }) => [owner, kid].find((u) => u.id === where.id) || null },
  jellyfinProfile: {
    // Nobody merged into the owner; the kid is a household user separated into a person.
    findMany: async () => [],
    findFirst: async ({ where }) => (where.ownUserId === 'kid-person' ? { ownerUserId: 'owner', jellyfinUserId: kidId } : null),
  },
}
const decrypt = () => 'config-password'

function household3() {
  return {
    jellyfinStreamUrl: STREAMS,
    jellyfinUsers: [
      { id: 'kid', name: 'Kid' },
      { id: 'teen', name: 'Teen' },
      { id: 'gran', name: 'Gran', streamUrl: OWN },
    ],
  }
}
const user = (id) => stored.jellyfinUsers.find((u) => u.id === id)

test('a household user is pointed at the paused addon, and back again', async () => {
  stored = household3()
  const state = await setAiomPaused(prisma, 'acc', kid, true, { decrypt })
  assert.equal(user('kid').streamUrl, PAUSED)
  assert.equal(stored.jellyfinStreamUrl, STREAMS, 'the main address is left alone')
  assert.equal(user('teen').streamUrl, undefined)
  await setAiomPaused(prisma, 'acc', kid, false, { decrypt, state })
  assert.deepEqual(stored, household3())
})

test('pausing the main user leaves the rest of the household playing', async () => {
  stored = household3()
  const state = await setAiomPaused(prisma, 'acc', owner, true, { decrypt })
  assert.equal(stored.jellyfinStreamUrl, PAUSED)
  assert.equal(user('kid').streamUrl, STREAMS, 'kept on the address they were using')
  assert.equal(user('teen').streamUrl, STREAMS)
  assert.equal(user('gran').streamUrl, OWN, 'their own address is untouched')
  await setAiomPaused(prisma, 'acc', owner, false, { decrypt, state })
  assert.deepEqual(stored, household3())
})

test('ending a pause leaves alone whatever the household changed meanwhile', async () => {
  stored = household3()
  const state = await setAiomPaused(prisma, 'acc', owner, true, { decrypt })
  user('teen').streamUrl = OWN // the household gave Teen an address of their own
  await setAiomPaused(prisma, 'acc', owner, false, { decrypt, state })
  assert.equal(stored.jellyfinStreamUrl, STREAMS)
  assert.equal(user('teen').streamUrl, OWN)
  assert.equal(user('kid').streamUrl, undefined)
})

test('a configuration with no stream address of its own pins nobody', async () => {
  stored = { jellyfinUsers: [{ id: 'kid', name: 'Kid' }] }
  const state = await setAiomPaused(prisma, 'acc', owner, true, { decrypt })
  assert.equal(stored.jellyfinStreamUrl, PAUSED)
  assert.equal(user('kid').streamUrl, undefined)
  await setAiomPaused(prisma, 'acc', owner, false, { decrypt, state })
  assert.deepEqual(stored, { jellyfinUsers: [{ id: 'kid', name: 'Kid' }] })
})

// Screen time's "Stop what's playing" on AIOMetadata 4.0+: through the
// configuration's main sign-in (which may command every profile's devices),
// only this person's screens that are playing, Stop then a message - and
// nothing at all on an older AIOMetadata.
test('stopping what is playing reaches only their playing screens, through the main sign-in', async () => {
  const jfAuth = require('../server/providers/jellyfinAuth')
  const provider = require('../server/providers/jellyfin')
  const { messageAiomScreens, canStopAiom } = require('../server/utils/aiomPause')
  const realRequest = jfAuth.jfRequest
  const realTakes = provider.takesRemoteControl
  const dashed = (id) => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  const sessions = [
    { Id: `${MAIN}-tv`, UserId: dashed(MAIN), NowPlayingItem: { Name: 'A film' }, SupportsRemoteControl: true },
    { Id: `${kidId}-tablet`, UserId: dashed(kidId), NowPlayingItem: { Name: 'A cartoon' }, SupportsRemoteControl: true },
    { Id: `${kidId}-phone`, UserId: dashed(kidId), SupportsRemoteControl: true },
    { Id: `${kidId}-web`, UserId: dashed(kidId), NowPlayingItem: { Name: 'A cartoon' }, SupportsRemoteControl: false },
  ]
  let calls = []
  let version4 = true
  jfAuth.jfRequest = async (base, path, opts = {}) => {
    calls.push([base, opts.method || 'GET', path, opts.token, opts.body?.Name, opts.body?.Arguments?.Text])
    return path.startsWith('/Sessions?') ? sessions : null
  }
  provider.takesRemoteControl = async (address, kind) => kind === 'aiometadata' && address === owner.jellyfinServerUrl && version4
  owner.jellyfinToken = 'enc-token'
  try {
    // The kid, a household user separated into a person: their tablet only.
    assert.equal(await messageAiomScreens(prisma, 'acc', kid, { text: 'Streaming is paused until midnight.', stop: true, decrypt }), 1)
    assert.ok(calls[0][2].startsWith(`/Sessions?ControllableByUserId=${MAIN}`), 'listed through the main sign-in')
    assert.ok(calls.every((c) => c[0] === owner.jellyfinServerUrl && c[3] === 'config-password'), "the owner's server and sign-in")
    assert.deepEqual(calls.slice(1).map((c) => [c[1], c[2], c[4] || null, c[5] || null]), [
      ['POST', `/Sessions/${kidId}-tablet/Playing/Stop`, null, null],
      ['POST', `/Sessions/${kidId}-tablet/Command`, 'DisplayMessage', 'Streaming is paused until midnight.'],
    ])
    // The owner, warned and not stopped: their TV only.
    calls = []
    assert.equal(await messageAiomScreens(prisma, 'acc', owner, { text: '8 minutes of watching left today.', decrypt }), 1)
    assert.deepEqual(calls.slice(1).map((c) => c[2]), [`/Sessions/${MAIN}-tv/Command`])
    assert.equal(await canStopAiom(prisma, 'acc', kid), true)
    // Older than 4.0: nothing is listed or sent, and the switch is not offered.
    version4 = false
    calls = []
    assert.equal(await messageAiomScreens(prisma, 'acc', kid, { text: 'x', stop: true, decrypt }), 0)
    assert.deepEqual(calls, [])
    assert.equal(await canStopAiom(prisma, 'acc', kid), false)
  } finally {
    jfAuth.jfRequest = realRequest
    provider.takesRemoteControl = realTakes
    delete owner.jellyfinToken
  }
})
