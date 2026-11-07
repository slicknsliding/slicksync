// "Their servers in Nuvio" (server/utils/nuvioMediaServers.js): SlickSync
// only ever changes its own entry in the profile's server list, gives Nuvio a
// sign-in of its own, and takes it away again when turned off.
const test = require('node:test')
const assert = require('node:assert/strict')

const AUTH = require.resolve('../server/providers/jellyfinAuth')
const MOD = require.resolve('../server/utils/nuvioMediaServers')

// A stand-in jellyfinAuth: records what was asked of the server.
function loadWith(calls, { quickConnectUserId = 'jfuser1' } = {}) {
  const real = require(AUTH)
  require.cache[AUTH].exports = {
    ...real,
    async jfRequest(url, path, opts = {}) {
      calls.push(['request', path, opts.token || null])
      if (path === '/System/Info/Public') return { Id: 'server-abc', ServerName: 'Home Jellyfin' }
      if (path.startsWith('/QuickConnect/Authorize')) return true
      if (path.startsWith('/Users/') && path.endsWith('/Views')) {
        return { Items: [{ Id: 'lib-m', Name: 'Movies', CollectionType: 'movies' }, { Id: 'lib-s', Name: 'Shows', CollectionType: 'tvshows' }, { Id: 'lib-tv', Name: 'Live TV', CollectionType: 'livetv' }, { Id: 'lib-p', Name: 'Playlists', CollectionType: 'playlists', Type: 'ManualPlaylistsFolder' }] }
      }
      if (path === '/Users/Me') {
        if (opts.token === 'dead-token') throw Object.assign(new Error('nope'), { status: 401 })
        return { Id: 'jfuser1' }
      }
      throw new Error('unexpected ' + path)
    },
    async quickConnectInitiate(url, opts = {}) { calls.push(['qc-start', opts.deviceName]); return { code: '123456', secret: 's', deviceId: 'd' } },
    async quickConnectAuthenticate(url, secret, opts = {}) { calls.push(['qc-finish', opts.deviceName]); return { token: 'nuvio-own-token', userId: quickConnectUserId } },
    async signOut(url, token) { calls.push(['signout', token]) },
  }
  delete require.cache[MOD]
  const mod = require(MOD)
  require.cache[AUTH].exports = real
  return mod
}

function fixture({ enabled = false, list = [] } = {}) {
  const state = { list: list.map((e) => ({ ...e })), pushes: [], flag: enabled }
  const user = {
    id: 'u1', accountId: 'default', providerType: 'nuvio', nuvioProfileId: 2,
    nuvioRefreshToken: 'enc', nuvioUserId: 'nu1', nuvioMediaServers: enabled,
  }
  const credential = {
    id: 'c1', userId: 'u1', providerType: 'jellyfin',
    jellyfinServerUrl: 'https://jf.example.com', jellyfinServerId: null, jellyfinServerKind: 'jellyfin',
    jellyfinUserId: 'JFUSER1', jellyfinUserName: 'viewer', jellyfinToken: 'enc-person-token',
  }
  const prisma = {
    user: {
      findUnique: async () => ({ ...user, nuvioMediaServers: state.flag }),
      update: async ({ data }) => { state.flag = data.nuvioMediaServers },
    },
    userProviderCredential: { findMany: async () => [credential] },
  }
  const provider = {
    async getMediaServers(profileId) { assert.equal(profileId, 2); return state.list.map((e) => ({ ...e })) },
    async setMediaServers(profileId, servers) { assert.equal(profileId, 2); state.pushes.push(servers); state.list = servers },
  }
  const deps = { createProvider: () => provider, decrypt: (v) => (v === 'enc-person-token' ? 'person-token' : v), req: {} }
  return { state, prisma, deps }
}

const theirs = {
  id: 'abc', provider_id: 'emby', name: "Friend's Emby", address: 'https://emby.example.net',
  remote_server_id: 'emby1', remote_user_id: 'me', user_name: 'me', token: 'their-token',
  enabled: true, use_catalog_metadata: true, libraries: [],
}

test('turning it on adds one entry of its own and keeps their servers as they were', async () => {
  const calls = []
  const mod = loadWith(calls)
  const { state, prisma, deps } = fixture({ list: [theirs] })
  await mod.setEnabled(prisma, deps, 'u1', true)
  assert.equal(state.pushes.length, 1)
  const [kept, ours] = state.pushes[0]
  assert.deepEqual(kept, theirs)
  assert.ok(mod.isOurs(ours))
  assert.equal(ours.provider_id, 'jellyfin')
  assert.equal(ours.remote_server_id, 'server-abc')
  assert.equal(ours.remote_user_id, 'jfuser1')
  assert.equal(ours.name, 'Home Jellyfin')
  assert.equal(ours.user_name, 'viewer')
  // Nuvio's own sign-in, never SlickSync's.
  assert.equal(ours.token, 'nuvio-own-token')
  assert.ok(calls.some((c) => c[0] === 'qc-start'))
  assert.ok(calls.some((c) => c[0] === 'request' && c[1].startsWith('/QuickConnect/Authorize') && c[2] === 'person-token'))
  // Named so the server's device list tells it apart from SlickSync's own.
  assert.ok(calls.some((c) => c[0] === 'qc-start' && c[1] === 'Nuvio (via SlickSync)'))
  assert.ok(calls.some((c) => c[0] === 'qc-finish' && c[1] === 'Nuvio (via SlickSync)'))
  assert.deepEqual(ours.libraries, [
    { id: 'lib-m', name: 'Movies', kind: 'movie', selected: true },
    { id: 'lib-s', name: 'Shows', kind: 'series', selected: true },
  ])
  assert.equal(state.flag, true)
})

test('turning it on again keeps a working Nuvio sign-in and the libraries they turned off', async () => {
  const calls = []
  const mod = loadWith(calls)
  const id = mod.entryId('server-abc', 'JFUSER1')
  const existing = {
    id, provider_id: 'jellyfin', name: 'Home Jellyfin', address: 'https://jf.example.com', remote_server_id: 'server-abc',
    remote_user_id: 'jfuser1', user_name: 'viewer', token: 'kept-token', enabled: false, use_catalog_metadata: true,
    libraries: [{ id: 'lib-m', name: 'Movies', kind: 'movie', selected: false }],
  }
  const { state, prisma, deps } = fixture({ enabled: true, list: [existing, theirs] })
  await mod.setEnabled(prisma, deps, 'u1', true)
  const ours = state.pushes[0].find(mod.isOurs)
  assert.equal(ours.token, 'kept-token')
  assert.equal(ours.enabled, false)
  assert.equal(ours.use_catalog_metadata, true)
  assert.deepEqual(ours.libraries.map((l) => [l.id, l.selected]), [['lib-m', false], ['lib-s', true]])
  assert.ok(!calls.some((c) => c[0] === 'qc-start'))
  assert.ok(!calls.some((c) => c[0] === 'signout'))
})

test('a Nuvio sign-in that stopped working is replaced', async () => {
  const calls = []
  const mod = loadWith(calls)
  const id = mod.entryId('server-abc', 'JFUSER1')
  const existing = { id, provider_id: 'jellyfin', name: 'x', address: 'https://jf.example.com', remote_server_id: 'server-abc', remote_user_id: 'jfuser1', user_name: 'viewer', token: 'dead-token', enabled: true, use_catalog_metadata: false, libraries: [] }
  const { state, prisma, deps } = fixture({ enabled: true, list: [existing] })
  await mod.setEnabled(prisma, deps, 'u1', true)
  assert.equal(state.pushes[0].find(mod.isOurs).token, 'nuvio-own-token')
})

test('the same server user added by hand in Nuvio is replaced, not duplicated', async () => {
  const mod = loadWith([])
  const handAdded = { ...theirs, id: 'mine', provider_id: 'jellyfin', remote_server_id: 'server-abc', remote_user_id: 'jfuser1' }
  const { state, prisma, deps } = fixture({ list: [handAdded, theirs] })
  await mod.setEnabled(prisma, deps, 'u1', true)
  assert.deepEqual(state.pushes[0].map((e) => e.id), ['abc', mod.entryId('server-abc', 'JFUSER1')])
})

test('turning it off takes only its own entry out and signs that sign-in out', async () => {
  const calls = []
  const mod = loadWith(calls)
  const ours = { id: mod.entryId('server-abc', 'JFUSER1'), provider_id: 'jellyfin', name: 'x', address: 'https://jf.example.com', remote_server_id: 'server-abc', remote_user_id: 'jfuser1', user_name: 'viewer', token: 'kept-token', enabled: true, use_catalog_metadata: false, libraries: [] }
  const { state, prisma, deps } = fixture({ enabled: true, list: [theirs, ours] })
  const r = await mod.setEnabled(prisma, deps, 'u1', false)
  assert.equal(r.removed, 1)
  assert.deepEqual(state.pushes[0], [theirs])
  assert.ok(calls.some((c) => c[0] === 'signout' && c[1] === 'kept-token'))
  assert.equal(state.flag, false)
})

test('a server that signs Nuvio in as someone else is refused and that sign-in dropped', async () => {
  const calls = []
  const mod = loadWith(calls, { quickConnectUserId: 'someone-else' })
  const { state, prisma, deps } = fixture({ list: [theirs] })
  await assert.rejects(mod.setEnabled(prisma, deps, 'u1', true), /someone else/)
  assert.equal(state.pushes.length, 0)
  assert.ok(calls.some((c) => c[0] === 'signout' && c[1] === 'nuvio-own-token'))
})

test('the tile lists their servers and marks which one is SlickSync\'s', async () => {
  const mod = loadWith([])
  const ours = { id: mod.entryId('server-abc', 'JFUSER1'), name: 'Home Jellyfin', user_name: 'viewer' }
  const { prisma, deps } = fixture({ enabled: true, list: [ours, theirs] })
  const d = await mod.describe(prisma, deps, 'u1')
  assert.equal(d.available, true)
  assert.equal(d.enabled, true)
  assert.deepEqual(d.servers.map((s) => [s.name, s.fromSlickSync]), [['Home Jellyfin', true], ["Friend's Emby", false]])
})

test('library kinds map to the ones Nuvio takes', () => {
  const mod = loadWith([])
  assert.equal(mod.libraryKind('movies'), 'movie')
  assert.equal(mod.libraryKind('tvshows'), 'series')
  assert.equal(mod.libraryKind('boxsets'), 'collection')
  assert.equal(mod.libraryKind('music'), 'mixed')
  assert.equal(mod.libraryKind(undefined), 'mixed')
})

test('Live TV and the Playlists folder stay out of Nuvio', () => {
  const mod = loadWith([])
  assert.equal(mod.skipsLibrary({ CollectionType: 'livetv' }), true)
  assert.equal(mod.skipsLibrary({ CollectionType: 'playlists' }), true)
  assert.equal(mod.skipsLibrary({ Type: 'ManualPlaylistsFolder' }), true)
  assert.equal(mod.skipsLibrary({ CollectionType: 'movies' }), false)
  assert.equal(mod.skipsLibrary({ CollectionType: 'homevideos' }), false)
})
