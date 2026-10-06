// Before anyone signs in, a Jellyfin-compatible server's kind is guessed from
// its public answer: AIOMetadata is the one that calls itself "AIOMetadata",
// or - named after its owner, the way AIOStreams already names each
// configuration - the one whose settings page sits at the root rather than
// inside a Stremio addon. Once signed in, /System/Info's PackageName (which
// no configuration renames) settles it.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { signInFromBody } = require('../server/utils/jellyfinConnect')
const { serverKindOf } = require('../server/providers/jellyfinAuth')

// A stand-in server: `name` is what it calls itself before sign-in, `aio` its
// `aiostreams` block (none on a real Jellyfin), `pkg` what its signed-in
// /System/Info says it is (null: the page is refused, as a real Jellyfin may
// do for someone who isn't an administrator).
const AIOSTREAMS_BLOCK = { configureUrl: 'https://aio.example.com/stremio/configure', features: { configSignIn: 1, users: 1 } }
const AIOMETADATA_BLOCK = { configureUrl: 'https://meta.example.com/configure', features: { users: 1 } }
function server({ name, aio, pkg }) {
  return http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const signedIn = /Token="good"/.test(req.headers.authorization || '')
    if (req.url === '/System/Info/Public') return send(200, { Id: 'srv1', ServerName: name, ProductName: 'Jellyfin Server', Version: '12.1.0', ...(aio ? { aiostreams: aio } : {}) })
    if (req.url === '/Users/Public') return send(200, [])
    if (req.url === '/QuickConnect/Enabled') return send(200, false)
    if (req.url === '/Users/AuthenticateByName') return send(200, { AccessToken: 'good', ServerId: 'srv1', User: { Id: 'u1', Name: 'Sam', ServerId: 'srv1' } })
    if (req.url === '/System/Info') {
      if (!signedIn) return send(401, { message: 'Unauthorized' })
      if (pkg === null) return send(403, { message: 'Forbidden' })
      return send(200, { Id: 'srv1', ServerName: name, PackageName: pkg })
    }
    send(404, {})
  })
}

async function signInTo(options) {
  const s = server(options)
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  try {
    return await signInFromBody({ serverUrl: `http://127.0.0.1:${s.address().port}`, jellyfinUsername: 'Sam', password: 'pw' })
  } finally {
    s.close()
  }
}

test('before sign-in: a renamed AIOMetadata is told from AIOStreams by where its settings page lives', () => {
  assert.equal(serverKindOf({ ServerName: 'Family setup', aiostreams: AIOMETADATA_BLOCK }), 'aiometadata')
  assert.equal(serverKindOf({ ServerName: 'Family setup', aiostreams: AIOSTREAMS_BLOCK }), 'aiostreams')
  assert.equal(serverKindOf({ ServerName: 'Family setup', aiostreams: { ...AIOSTREAMS_BLOCK, configureUrl: 'https://aio.example.com/stremio/abc/def/configure' } }), 'aiostreams')
  assert.equal(serverKindOf({ ServerName: 'AIOMetadata', aiostreams: AIOMETADATA_BLOCK }), 'aiometadata')
  assert.equal(serverKindOf({ ServerName: 'AIOStreams', aiostreams: {} }), 'aiostreams', 'an older AIOStreams with no settings address')
  assert.equal(serverKindOf({ ServerName: 'Living room' }), 'jellyfin')
})

test('once signed in, what the server says it is wins over any public guess', async () => {
  // No settings address to go by, so only signing in can tell.
  const { probe } = await signInTo({ name: 'Family setup', aio: { features: { users: 1 } }, pkg: 'aiometadata' })
  assert.equal(probe.kind, 'aiometadata')
  assert.equal(probe.kindLabel, 'AIOMetadata')
  assert.equal(probe.serverName, 'Family setup')
})

test('AIOStreams and AIOMetadata come out as they are, named or renamed', async () => {
  assert.equal((await signInTo({ name: 'Family setup', aio: AIOSTREAMS_BLOCK, pkg: 'aiostreams' })).probe.kind, 'aiostreams')
  assert.equal((await signInTo({ name: 'Family setup', aio: AIOMETADATA_BLOCK, pkg: 'aiometadata' })).probe.kind, 'aiometadata')
  assert.equal((await signInTo({ name: 'AIOMetadata', aio: AIOMETADATA_BLOCK, pkg: 'aiometadata' })).probe.kind, 'aiometadata')
})

test('a real Jellyfin is left as the public answer says, whether or not it shows the page', async () => {
  assert.equal((await signInTo({ name: 'Living room', aio: null, pkg: null })).probe.kind, 'jellyfin')
  assert.equal((await signInTo({ name: 'Living room', aio: null, pkg: 'synology' })).probe.kind, 'jellyfin')
})
