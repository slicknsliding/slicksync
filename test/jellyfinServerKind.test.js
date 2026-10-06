// Before anyone signs in, a Jellyfin-compatible server's kind is guessed from
// its public answer: AIOMetadata is the one that calls itself "AIOMetadata".
// AIOStreams already names each configuration after its owner, and if
// AIOMetadata does the same its servers would be added as AIOStreams - so once
// signed in, /System/Info's PackageName (which no configuration renames)
// settles it.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { signInFromBody } = require('../server/utils/jellyfinConnect')
const { serverKindOf } = require('../server/providers/jellyfinAuth')

// A stand-in server: `name` is what it calls itself before sign-in, `pkg`
// what its signed-in /System/Info says it is (null: the page is refused, as
// a real Jellyfin does for someone who isn't an administrator).
function server({ name, aio, pkg }) {
  return http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const signedIn = /Token="good"/.test(req.headers.authorization || '')
    if (req.url === '/System/Info/Public') return send(200, { Id: 'srv1', ServerName: name, ProductName: 'Jellyfin Server', Version: '12.1.0', ...(aio ? { aiostreams: { features: { users: 1 } } } : {}) })
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

test('an AIOMetadata that named itself after its owner is still AIOMetadata once signed in', async () => {
  assert.equal(serverKindOf({ ServerName: 'Family setup', aiostreams: {} }), 'aiostreams', 'the public answer alone would get it wrong')
  const { probe } = await signInTo({ name: 'Family setup', aio: true, pkg: 'aiometadata' })
  assert.equal(probe.kind, 'aiometadata')
  assert.equal(probe.kindLabel, 'AIOMetadata')
  assert.equal(probe.serverName, 'Family setup')
})

test('AIOStreams and today\'s AIOMetadata come out as they always did', async () => {
  assert.equal((await signInTo({ name: 'Family setup', aio: true, pkg: 'aiostreams' })).probe.kind, 'aiostreams')
  assert.equal((await signInTo({ name: 'AIOMetadata', aio: true, pkg: 'aiometadata' })).probe.kind, 'aiometadata')
})

test('a real Jellyfin is left as the public answer says, whether or not it shows the page', async () => {
  assert.equal((await signInTo({ name: 'Living room', aio: false, pkg: null })).probe.kind, 'jellyfin')
  assert.equal((await signInTo({ name: 'Living room', aio: false, pkg: 'synology' })).probe.kind, 'jellyfin')
})
