// Live TV playlists (M3U): the check reads the start of the playlist, says
// whether it is one and lists channels, and brings the end date when the
// address is an Xtream one; a changed address reaches the AIOStreams setups
// carrying the old one exactly; a setup's Live TV sources are listed.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const config = require('../server/utils/config')
const { runCheck, m3uXtreamLogin } = require('../server/utils/vaultCheckers')
const { replaceIptvPlaylist, liveTvSources } = require('../server/utils/aioServiceKeys')

const configuredType = config.INSTANCE_TYPE

function server(t, answer) {
  const seen = []
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      seen.push(req.url)
      const { status = 200, body = '', type = 'audio/x-mpegurl' } = answer(new URL(req.url, 'http://x'))
      res.writeHead(status, { 'Content-Type': type })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    srv.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close())
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen })
    })
  })
}

function household(t) {
  config.INSTANCE_TYPE = 'private'
  t.after(() => { config.INSTANCE_TYPE = configuredType })
}

const LIST = '#EXTM3U\n#EXTINF:-1 tvg-id="one",Channel One\nhttp://example.com/1.ts\n#EXTINF:-1 tvg-id="two",Channel Two\nhttp://example.com/2.ts\n'

test('playlist check: a playlist with channels passes', async (t) => {
  household(t)
  const srv = await server(t, () => ({ body: LIST }))
  const r = await runCheck('m3u_playlist', `${srv.url}/list.m3u`)
  assert.equal(r.ok, true)
  assert.match(r.message, /^Playlist loads/)
  assert.equal(r.expiresAt, undefined)
})

test('playlist check: a web page, an empty playlist, a refusal and a missing file each fail plainly', async (t) => {
  household(t)
  const srv = await server(t, (u) => {
    if (u.pathname === '/page') return { body: '<html><body>Sign in</body></html>', type: 'text/html' }
    if (u.pathname === '/empty') return { body: '#EXTM3U\n' }
    if (u.pathname === '/denied') return { status: 403, body: 'no' }
    return { status: 404, body: 'gone' }
  })
  assert.match((await runCheck('m3u_playlist', `${srv.url}/page`)).message, /did not answer with a playlist/)
  assert.match((await runCheck('m3u_playlist', `${srv.url}/empty`)).message, /lists no channels/)
  assert.match((await runCheck('m3u_playlist', `${srv.url}/denied`)).message, /turned the playlist address down/)
  assert.match((await runCheck('m3u_playlist', `${srv.url}/gone`)).message, /returned 404/)
  for (const p of ['/page', '/empty', '/denied', '/gone']) assert.equal((await runCheck('m3u_playlist', `${srv.url}${p}`)).ok, false)
})

test('playlist check: only the start of a very large playlist is read', async (t) => {
  household(t)
  const big = '#EXTM3U\n' + '#EXTINF:-1,Channel\nhttp://example.com/x.ts\n'.repeat(120000) // about 5 MB
  const srv = await server(t, () => ({ body: big }))
  const started = Date.now()
  const r = await runCheck('m3u_playlist', `${srv.url}/big.m3u`)
  assert.equal(r.ok, true)
  assert.ok(Date.now() - started < 10000)
})

test('playlist check: an Xtream-shaped address also brings the end date, and an expired account fails', async (t) => {
  household(t)
  const srv = await server(t, (u) => {
    if (u.pathname === '/get.php') return { body: LIST }
    if (u.pathname === '/player_api.php') {
      const expired = u.searchParams.get('password') === 'old'
      return { type: 'application/json', body: { user_info: { auth: 1, status: expired ? 'Expired' : 'Active', exp_date: expired ? '1700000000' : '1893456000' } } }
    }
    return { status: 404 }
  })
  const ok = await runCheck('m3u_playlist', `${srv.url}/get.php?username=viewer&password=right&type=m3u_plus`)
  assert.equal(ok.ok, true)
  assert.equal(ok.expiresAt.toISOString(), new Date(1893456000 * 1000).toISOString())
  assert.match(ok.message, /Playlist loads, expires Jan 1, 2030/)
  const gone = await runCheck('m3u_playlist', `${srv.url}/get.php?username=viewer&password=old&type=m3u_plus`)
  assert.equal(gone.ok, false)
  assert.match(gone.message, /The playlist loads, but the account is expired/)
})

test('playlist check: an address that is not a web address is turned down without a request', async () => {
  for (const bad of ['', 'file:///etc/passwd', 'not a url']) assert.equal((await runCheck('m3u_playlist', bad)).ok, false)
})

test('m3uXtreamLogin reads the login out of a get.php address only', () => {
  assert.deepEqual(m3uXtreamLogin('http://tv.example.com:8080/get.php?username=a&password=b&type=m3u'), { server: 'http://tv.example.com:8080', username: 'a', password: 'b' })
  assert.equal(m3uXtreamLogin('http://tv.example.com/list.m3u'), null)
  assert.equal(m3uXtreamLogin('http://tv.example.com/get.php?username=a'), null)
})

test('a changed playlist address replaces only the presets holding exactly the old one', () => {
  const cfg = { presets: [
    { type: 'm3u', instanceId: 'a', options: { name: 'Home TV', playlist: 'http://tv.example.com/old.m3u' } },
    { type: 'm3u', instanceId: 'b', options: { playlist: 'http://other.example.com/list.m3u' } },
    { type: 'xtream', instanceId: 'c', options: { server: 'http://tv.example.com', username: 'u', password: 'p' } },
  ] }
  assert.deepEqual(replaceIptvPlaylist(cfg, 'http://tv.example.com/old.m3u', 'http://tv.example.com/new.m3u'), ['Home TV'])
  assert.equal(cfg.presets[0].options.playlist, 'http://tv.example.com/new.m3u')
  assert.equal(cfg.presets[1].options.playlist, 'http://other.example.com/list.m3u')
  assert.deepEqual(replaceIptvPlaylist(cfg, 'http://nowhere.example.com/x.m3u', 'http://tv.example.com/y.m3u'), [])
  assert.deepEqual(replaceIptvPlaylist(cfg, '', 'http://tv.example.com/y.m3u'), [])
})

test('a setup\'s Live TV sources: playlists and IPTV logins that are switched on', () => {
  const cfg = { presets: [
    { type: 'm3u', enabled: true, options: { name: 'Home TV', playlist: ' http://tv.example.com/list.m3u ' } },
    { type: 'm3u', enabled: false, options: { playlist: 'http://off.example.com/list.m3u' } },
    { type: 'm3u', options: { playlist: '' } },
    { type: 'xtream', options: { name: 'Sports', server: 'http://tv.example.com', username: 'u', password: 'p' } },
    { type: 'xtream', options: { server: 'http://tv.example.com', username: 'u' } },
    { type: 'torrentio', options: {} },
  ] }
  assert.deepEqual(liveTvSources(cfg), [
    { kind: 'm3u', name: 'Home TV', playlist: 'http://tv.example.com/list.m3u' },
    { kind: 'xtream', name: 'Sports', server: 'http://tv.example.com', username: 'u', password: 'p' },
  ])
  assert.deepEqual(liveTvSources(null), [])
})
