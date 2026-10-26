const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const dns = require('node:dns').promises
const { isPrivateIp, isLinkLocalIp, assertSafeUrl, safeFetch } = require('../server/utils/safeUrl')

// Names in these tests resolve to whatever the test says, never the network.
function resolveTo(t, table) {
  const original = dns.lookup
  dns.lookup = async (host) => {
    if (!(host in table)) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e }
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  t.after(() => { dns.lookup = original })
}

function listen(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }))
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

test('isPrivateIp: private, loopback, link-local and their IPv6 forms', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('isPrivateIp: a hostname is not an address', () => {
  // These used to be refused for starting like a private IPv6 range.
  for (const host of ['fc2.com', 'fdroid.org', 'fe80s.example', 'localhost']) assert.equal(isPrivateIp(host), false, host)
})

test('isLinkLocalIp: only the link-local ranges', () => {
  for (const ip of ['169.254.169.254', 'fe80::1', '::ffff:169.254.1.1']) assert.equal(isLinkLocalIp(ip), true, ip)
  for (const ip of ['127.0.0.1', '192.168.1.10', '10.0.0.5', '::1', 'fd00::1', '8.8.8.8']) assert.equal(isLinkLocalIp(ip), false, ip)
})

test('assertSafeUrl: an instance serving strangers refuses everything internal', async (t) => {
  resolveTo(t, { 'intranet.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'], 'fc2.com': ['93.184.216.34'], 'localhost': ['127.0.0.1'] })
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:8096', 'http://192.168.1.10:7000/manifest.json',
    'http://localhost:3000', 'http://db.internal/', 'http://nas.local/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://intranet.example/']) {
    await assert.rejects(assertSafeUrl(url), /blocked host/, url)
  }
  // One public record does not vouch for the internal one beside it.
  await assert.rejects(assertSafeUrl('https://mixed.example/'), /blocked host/)
  await assert.rejects(assertSafeUrl('https://nowhere.example/'), /unresolvable host/)
  assert.equal((await assertSafeUrl('https://fc2.com/x')).hostname, 'fc2.com')
  assert.equal((await assertSafeUrl('https://8.8.8.8/')).hostname, '8.8.8.8')
})

test('assertSafeUrl: only http and https, on any install', async () => {
  for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/x', 'blob:abc', 'javascript:alert(1)']) {
    await assert.rejects(assertSafeUrl(url), /unsupported protocol/, url)
    await assert.rejects(assertSafeUrl(url, { allowPrivate: true }), /unsupported protocol/, url)
  }
  await assert.rejects(assertSafeUrl('not a url', { allowPrivate: true }), /invalid url/)
})

test('assertSafeUrl: a household install may reach its own network, but never link-local', async (t) => {
  resolveTo(t, { 'jellyfin.lan': ['192.168.1.20'], 'localhost': ['127.0.0.1'], 'sneaky.example': ['169.254.169.254'] })
  for (const url of ['http://192.168.1.10:7000/manifest.json', 'http://127.0.0.1:11470/manifest.json', 'http://10.0.0.5:8096', 'http://localhost:3000',
    'http://jellyfin.lan:8096', 'http://[fd12::5]:8096/', 'http://100.100.1.2:8096']) {
    await assert.doesNotReject(assertSafeUrl(url, { allowPrivate: true }), url)
  }
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://sneaky.example/']) {
    await assert.rejects(assertSafeUrl(url, { allowPrivate: true }), /blocked host/, url)
  }
})

test('safeFetch: follows an ordinary redirect chain', async (t) => {
  const base = await listen(t, (req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); return res.end() }
    if (req.url === '/b') { res.writeHead(301, { location: '/c' }); return res.end() }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`done ${req.url}`)
  })
  const res = await safeFetch(`${base}/a`, {}, { allowPrivate: true })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'done /c')
})

test('safeFetch: a redirect to a refused address is not followed', async (t) => {
  const base = await listen(t, (req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end() })
  await assert.rejects(safeFetch(`${base}/x`, {}, { allowPrivate: true }), /blocked host/)
  await assert.rejects(safeFetch(`${base}/x`, {}, { allowPrivate: true, maxRedirects: 0 }), /too many redirects|blocked host/)
})

test('safeFetch: the first address is checked too', async (t) => {
  let hits = 0
  const base = await listen(t, (req, res) => { hits++; res.end('internal') })
  await assert.rejects(safeFetch(`${base}/`), /blocked host/)
  assert.equal(hits, 0, 'nothing may be sent to a refused address')
})

test('safeFetch: gives up on a redirect loop', async (t) => {
  const base = await listen(t, (req, res) => { res.writeHead(302, { location: req.url }); res.end() })
  await assert.rejects(safeFetch(`${base}/loop`, {}, { allowPrivate: true }), /too many redirects/)
})

test('safeFetch: credentials for the first host are not sent on to another', async (t) => {
  let seen = null
  const other = await listen(t, (req, res) => { seen = req.headers; res.end('other') })
  const first = await listen(t, (req, res) => { res.writeHead(307, { location: `${other}/landing` }); res.end() })
  const res = await safeFetch(`${first}/start`, { headers: { Authorization: 'Bearer secret', Cookie: 'a=b', 'X-Keep': 'yes' } }, { allowPrivate: true })
  assert.equal(await res.text(), 'other')
  assert.equal(seen.authorization, undefined)
  assert.equal(seen.cookie, undefined)
  assert.equal(seen['x-keep'], 'yes')
})

test('safeFetch: a redirected POST arrives as a GET without its body', async (t) => {
  let landed = null
  const base = await listen(t, (req, res) => {
    if (req.url === '/submit') { res.writeHead(303, { location: '/result' }); return res.end() }
    landed = req.method
    res.end('ok')
  })
  const res = await safeFetch(`${base}/submit`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'text/plain' } }, { allowPrivate: true })
  assert.equal(res.status, 200)
  assert.equal(landed, 'GET')
})

// A lookup that takes `ms` before it answers, for a resolver that is stalled.
function slowLookup(t, ms, address = '93.184.216.34') {
  const original = dns.lookup
  dns.lookup = () => new Promise((resolve) => setTimeout(() => resolve([{ address, family: 4 }]), ms))
  t.after(() => { dns.lookup = original })
}

test('safeFetch: a caller\'s timeout is honoured while the address is still being looked up', async (t) => {
  slowLookup(t, 1500)
  const started = Date.now()
  await assert.rejects(safeFetch('http://slow.example/', { signal: AbortSignal.timeout(100) }), (e) => e.name === 'TimeoutError')
  assert.ok(Date.now() - started < 1000, 'gave up at the timeout, not when the lookup came back')
})

test('safeFetch: a signal that is already aborted never starts the lookup, and nothing is left unhandled', async (t) => {
  slowLookup(t, 50)
  const unhandled = []
  const note = (e) => unhandled.push(e)
  process.on('unhandledRejection', note)
  t.after(() => process.off('unhandledRejection', note))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(safeFetch('http://slow.example/', { signal: controller.signal }), (e) => e.name === 'AbortError')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(unhandled, [])
})

test('safeFetch: a lookup that fails after the caller gave up raises no unhandled rejection', async (t) => {
  const original = dns.lookup
  dns.lookup = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 150))
  t.after(() => { dns.lookup = original })
  const unhandled = []
  const note = (e) => unhandled.push(e)
  process.on('unhandledRejection', note)
  t.after(() => process.off('unhandledRejection', note))
  await assert.rejects(safeFetch('http://slow.example/', { signal: AbortSignal.timeout(50) }), (e) => e.name === 'TimeoutError')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(unhandled, [])
})

test('safeFetch: without a signal the lookup is waited for and the fetch goes ahead as before', async (t) => {
  const base = await listen(t, (req, res) => res.end('fine'))
  const res = await safeFetch(`${base}/`, {}, { allowPrivate: true })
  assert.equal(await res.text(), 'fine')
})

test('safeFetch: a vet function replaces the default check for the first address and every redirect', async (t) => {
  const target = await listen(t, (req, res) => res.end('lan-secret'))
  const first = await listen(t, (req, res) => { res.writeHead(302, { location: `${target}/secret` }); res.end() })
  const seen = []
  const vet = async (url) => { seen.push(url); if (url.startsWith(target)) throw new Error('blocked host') }
  await assert.rejects(safeFetch(`${first}/start`, {}, { allowPrivate: true, vet }), /blocked host/)
  assert.deepEqual(seen, [`${first}/start`, `${target}/secret`])
})

test('safeFetch: a name that is public when checked and internal when connected to is refused', async (t) => {
  let hits = 0
  const base = await listen(t, (req, res) => { hits++; res.end('internal') })
  const port = new URL(base).port
  // DNS rebinding: the first answer (the address check) is public, every
  // later one (the connection's own lookup) is the loopback address.
  const original = dns.lookup
  let asked = 0
  dns.lookup = async () => [{ address: asked++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
  t.after(() => { dns.lookup = original })
  await assert.rejects(safeFetch(`http://rebind.example:${port}/`), /blocked host/)
  assert.ok(asked >= 2, 'the connection looked the name up itself')
  assert.equal(hits, 0, 'nothing may be sent to the address it rebound to')
})

test('safeFetch: a redirect to a name that resolves to an internal address is refused', async (t) => {
  let hits = 0
  const internal = await listen(t, (req, res) => { hits++; res.end('internal') })
  const first = await listen(t, (req, res) => { res.writeHead(302, { location: `http://intranet.example:${new URL(internal).port}/` }); res.end() })
  // A household install still refuses link-local, so a hop to a name that
  // resolves there is the refusal to see.
  resolveTo(t, { 'intranet.example': ['169.254.169.254'] })
  await assert.rejects(safeFetch(`${first}/x`, {}, { allowPrivate: true }), /blocked host/)
  assert.equal(hits, 0)
})

test('safeFetch: connects by name to the vetted address (Host header, household install)', async (t) => {
  let seen = null
  const base = await listen(t, (req, res) => { seen = req.headers.host; res.end('hello') })
  const port = new URL(base).port
  resolveTo(t, { 'nas.lan': ['127.0.0.1'] })
  const res = await safeFetch(`http://nas.lan:${port}/x`, {}, { allowPrivate: true })
  assert.equal(await res.text(), 'hello')
  assert.equal(seen, `nas.lan:${port}`)
  assert.equal(res.url, `http://nas.lan:${port}/x`)
})

test('safeFetch: a compressed answer and a JSON body come through like fetch', async (t) => {
  const zlib = require('node:zlib')
  const base = await listen(t, (req, res) => {
    if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => res.end(b)); return }
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' })
    res.end(zlib.gzipSync('{"a":1}'))
  })
  assert.deepEqual(await (await safeFetch(`${base}/`, {}, { allowPrivate: true })).json(), { a: 1 })
  const echoed = await safeFetch(`${base}/`, { method: 'POST', body: '{"b":2}' }, { allowPrivate: true })
  assert.equal(echoed.status, 200)
  assert.equal(await echoed.text(), '{"b":2}')
})

test('safeFetch: an aborted request rejects with the abort reason', async (t) => {
  const base = await listen(t, () => {})
  await assert.rejects(safeFetch(`${base}/slow`, { signal: AbortSignal.timeout(100) }, { allowPrivate: true }), (e) => e.name === 'TimeoutError' || e.name === 'AbortError')
})
