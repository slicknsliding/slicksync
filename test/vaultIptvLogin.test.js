// IPTV (Xtream) logins in the Vault: the check signs in to the server's own
// player_api and reads when the login runs out; a changed login reaches the
// AIOStreams setups that carry the old one exactly, and nothing else.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const config = require('../server/utils/config')
const { runCheck, xtreamBase } = require('../server/utils/vaultCheckers')
const { replaceIptvLogin, rotateIptvInAioConfigs } = require('../server/utils/aioServiceKeys')

const configuredType = config.INSTANCE_TYPE

// A stand-in IPTV server on this machine (a household install may reach it).
function iptvServer(t, answer) {
  const seen = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push(req.url)
      const { status = 200, body } = answer(new URL(req.url, 'http://x'))
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve({ url: `http://127.0.0.1:${server.address().port}`, seen })
    })
  })
}

function household(t) {
  config.INSTANCE_TYPE = 'private'
  t.after(() => { config.INSTANCE_TYPE = configuredType })
}

const accounts = (u) => {
  const user = u.searchParams.get('username')
  const pass = u.searchParams.get('password')
  if (u.pathname !== '/player_api.php') return { status: 404, body: 'no' }
  if (user === 'viewer' && pass === 'right-password') return { body: { user_info: { auth: 1, status: 'Active', exp_date: '1893456000' } } }
  if (user === 'viewer' && pass === 'expired-one') return { body: { user_info: { auth: 1, status: 'Expired', exp_date: '1700000000' } } }
  return { body: { user_info: { auth: 0 } } }
}

test('IPTV check: a working login passes and brings its end date', async (t) => {
  household(t)
  const srv = await iptvServer(t, accounts)
  const r = await runCheck('xtream_auth', 'right-password', { url: `${srv.url}/`, identifier: 'viewer' })
  assert.equal(r.ok, true)
  assert.equal(r.expiresAt.toISOString(), new Date(1893456000 * 1000).toISOString())
  assert.match(r.message, /Login works, runs out 2030-01-01/)
  assert.equal(srv.seen.length, 1)
})

test('IPTV check: a wrong password, an expired account and a non-IPTV address each fail plainly', async (t) => {
  household(t)
  const srv = await iptvServer(t, accounts)
  const wrong = await runCheck('xtream_auth', 'nope', { url: srv.url, identifier: 'viewer' })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /turned the login down/)
  const expired = await runCheck('xtream_auth', 'expired-one', { url: srv.url, identifier: 'viewer' })
  assert.equal(expired.ok, false)
  assert.match(expired.message, /account is expired/)
  assert.ok(expired.expiresAt instanceof Date)
  const notIptv = await iptvServer(t, () => ({ body: '<html>hello</html>' }))
  const r = await runCheck('xtream_auth', 'right-password', { url: notIptv.url, identifier: 'viewer' })
  assert.equal(r.ok, false)
  assert.match(r.message, /did not answer like an IPTV server/)
})

test('IPTV check: missing parts are named, and an instance serving strangers never reaches its own network', async (t) => {
  assert.match((await runCheck('xtream_auth', 'p', { identifier: 'viewer' })).message, /No IPTV server address/)
  assert.match((await runCheck('xtream_auth', 'p', { url: 'http://tv.example.com' })).message, /No IPTV username/)
  assert.match((await runCheck('xtream_auth', '', { url: 'http://tv.example.com', identifier: 'viewer' })).message, /No IPTV password/)
  config.INSTANCE_TYPE = 'public'
  t.after(() => { config.INSTANCE_TYPE = configuredType })
  const srv = await iptvServer(t, accounts)
  const r = await runCheck('xtream_auth', 'right-password', { url: srv.url, identifier: 'viewer' })
  assert.equal(r.ok, false)
  assert.equal(srv.seen.length, 0)
})

test('server addresses compare the way AIOStreams reads them', () => {
  assert.equal(xtreamBase('tv.example.com:8080'), 'http://tv.example.com:8080')
  assert.equal(xtreamBase('http://tv.example.com:8080/player_api.php'), 'http://tv.example.com:8080')
  assert.equal(xtreamBase('https://tv.example.com/iptv/'), 'https://tv.example.com/iptv')
  assert.equal(xtreamBase('ftp://tv.example.com'), null)
  assert.equal(xtreamBase(''), null)
})

test('a changed login replaces only the IPTV option that carries the old one exactly', () => {
  const config = {
    services: [{ id: 'realdebrid', credentials: { apiKey: 'old-password' } }],
    presets: [
      { type: 'xtream', instanceId: 'a', enabled: true, options: { name: 'Home TV', server: 'http://tv.example.com:8080/', username: 'viewer', password: 'old-password' } },
      { type: 'xtream', instanceId: 'b', enabled: true, options: { server: 'http://other.example.com', username: 'viewer', password: 'old-password' } },
      { type: 'xtream', instanceId: 'c', enabled: true, options: { server: 'tv.example.com:8080', username: 'someone-else', password: 'old-password' } },
      { type: 'torrentio', instanceId: 'd', enabled: true, options: { server: 'tv.example.com:8080', username: 'viewer', password: 'old-password' } },
    ],
  }
  const before = { server: 'tv.example.com:8080', username: 'viewer', password: 'old-password' }
  const changed = replaceIptvLogin(config, before, { ...before, password: 'new-password' })
  assert.deepEqual(changed, ['Home TV'])
  assert.equal(config.presets[0].options.password, 'new-password')
  // The address is kept as they typed it when it did not change.
  assert.equal(config.presets[0].options.server, 'http://tv.example.com:8080/')
  assert.equal(config.presets[1].options.password, 'old-password')
  assert.equal(config.presets[2].options.password, 'old-password')
  assert.equal(config.presets[3].options.password, 'old-password')
  assert.equal(config.services[0].credentials.apiKey, 'old-password')
})

test('a new server address and username go in too', () => {
  const config = { presets: [{ type: 'xtream', instanceId: 'a', options: { server: 'tv.example.com', username: 'viewer', password: 'pw' } }] }
  replaceIptvLogin(config, { server: 'tv.example.com', username: 'viewer', password: 'pw' }, { server: 'http://new.example.com', username: 'viewer2', password: 'pw' })
  assert.deepEqual(config.presets[0].options, { server: 'http://new.example.com', username: 'viewer2', password: 'pw' })
})

test('nothing changed, or a part missing, reads no setup at all', async () => {
  const prisma = { appAccount: { findUnique: async () => { throw new Error('should not be read') } } }
  const same = { server: 's', username: 'u', password: 'p' }
  assert.deepEqual(await rotateIptvInAioConfigs(prisma, null, { accountId: 'a', before: same, after: { ...same } }), { updated: [], failed: [] })
  assert.deepEqual(await rotateIptvInAioConfigs(prisma, null, { accountId: 'a', before: { ...same, password: '' }, after: same }), { updated: [], failed: [] })
})
