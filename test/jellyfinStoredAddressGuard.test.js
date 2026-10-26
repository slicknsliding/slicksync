// A Jellyfin server address is stored by (or typed in by) someone with an
// account. On an instance serving strangers, the calls that send to it must
// not reach this server's own network; a household install keeps its LAN.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const dns = require('node:dns').promises
const config = require('../server/utils/config')
const { pushPicture } = require('../server/utils/serverAvatars')
const { setCollectionPicture } = require('../server/utils/jellyfinServerCollections')
const images = require('../server/utils/jellyfinImages')

function listen(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }))
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

function instance(t, type) {
  const was = config.INSTANCE_TYPE
  config.INSTANCE_TYPE = type
  t.after(() => { config.INSTANCE_TYPE = was })
}

function publicName(t, name) {
  const original = dns.lookup
  dns.lookup = async (host) => {
    if (host !== name) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return [{ address: '93.184.216.34', family: 4 }]
  }
  t.after(() => { dns.lookup = original })
}

const personAt = (url) => ({
  id: 'p1', providerType: 'jellyfin', jellyfinToken: 'tok', jellyfinServerUrl: url, jellyfinUserId: 'u1', avatarUrl: null, username: 'p',
})
const prismaFor = (person) => ({
  user: { findFirst: async () => person },
  appAccount: { findUnique: async () => ({ sync: {} }), update: async () => ({}) },
})

test('picture push: a loopback server address is refused on a public instance, reached on a private one', async (t) => {
  let hits = 0
  const base = await listen(t, (req, res) => { hits++; res.writeHead(204); res.end() })
  instance(t, 'public')
  await assert.rejects(pushPicture(prismaFor(personAt(base)), (v) => v, 'acc', 'p1'), /private network/)
  assert.equal(hits, 0)
  config.INSTANCE_TYPE = 'private'
  await pushPicture(prismaFor(personAt(base)), (v) => v, 'acc', 'p1').catch(() => {})
  assert.ok(hits >= 1, 'a household install still reaches its own server')
})

test('picture push: a public address is still used on a public instance', async (t) => {
  instance(t, 'public')
  publicName(t, 'jf.example.com')
  const real = global.fetch
  const seen = []
  global.fetch = async (url, init) => { seen.push([String(url), init.method]); return { status: 204, headers: new Headers(), body: null } }
  t.after(() => { global.fetch = real })
  await pushPicture(prismaFor(personAt('https://jf.example.com')), (v) => v, 'acc', 'p1').catch(() => {})
  assert.equal(seen[0]?.[0], 'https://jf.example.com/UserImage?userId=u1')
  assert.equal(seen[0]?.[1], 'DELETE')
})

test('collection cover: refused for a loopback server on a public instance, sent on a private one', async (t) => {
  let hits = 0
  const base = await listen(t, (req, res) => { hits++; res.writeHead(204); res.end() })
  const s = { base, token: 't', deviceId: 'd' }
  const cover = { type: 'image/png', bytes: Buffer.from('x') }
  instance(t, 'public')
  await assert.rejects(setCollectionPicture(s, 'c1', cover), /private network/)
  assert.equal(hits, 0)
  config.INSTANCE_TYPE = 'private'
  await setCollectionPicture(s, 'c1', cover)
  assert.equal(hits, 1)
})

test('collection cover: a public address works on a public instance', async (t) => {
  instance(t, 'public')
  publicName(t, 'jf.example.com')
  const real = global.fetch
  let url = null
  global.fetch = async (u) => { url = String(u); return { ok: true, status: 204, headers: new Headers(), body: null } }
  t.after(() => { global.fetch = real })
  await setCollectionPicture({ base: 'https://jf.example.com', token: 't', deviceId: 'd' }, 'c1', { type: 'image/png', bytes: Buffer.from('x') })
  assert.equal(url, 'https://jf.example.com/Items/c1/Images/Primary')
})

test('image probe: a loopback server is not asked on a public instance, and is on a private one', async (t) => {
  let hits = 0
  const base = await listen(t, (req, res) => { hits++; res.writeHead(200); res.end() })
  images.forgetForTests()
  instance(t, 'public')
  await images.imagesOpen('loop-public', `${base}/Items/x/Images/Primary`)
  assert.equal(hits, 0)
  config.INSTANCE_TYPE = 'private'
  assert.equal(await images.imagesOpen('loop-private', `${base}/Items/x/Images/Primary`), true)
  assert.equal(hits, 1)
  images.forgetForTests()
})

test('image probe: a public address is asked on a public instance; a redirect there counts as an answer', async (t) => {
  instance(t, 'public')
  publicName(t, 'jf.example.com')
  images.forgetForTests()
  const real = global.fetch
  global.fetch = async () => ({ status: 302, headers: new Headers({ location: 'http://127.0.0.1/' }), body: null })
  t.after(() => { global.fetch = real; images.forgetForTests() })
  assert.equal(await images.imagesOpen('pub', 'https://jf.example.com/Items/x/Images/Primary'), true)
})
