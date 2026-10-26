const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyctype-test-'))

const express = require('express')
const proxyFactory = require('../server/routes/proxy')
const streamProxyFactory = require('../server/routes/streamProxy')

const CSP = "default-src 'none'; sandbox"

function listen(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }))
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    }).on('error', reject)
  })
}

function quiet(t) {
  const saved = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  t.after(() => Object.assign(console, saved))
}

// What the upstream answers for each path: [content-type, body].
const UPSTREAM = {
  '/html': ['text/html; charset=utf-8', '<script src="/x.js"></script>'],
  '/js': ['application/javascript', 'alert(1)'],
  '/svg': ['image/svg+xml', '<svg onload="alert(1)"/>'],
  '/xml': ['text/xml', '<a/>'],
  '/css': ['text/css', 'body{}'],
  '/json': ['application/json; charset=utf-8', '{"metas":[{"id":"tt1"}]}'],
  '/jpeg': ['image/jpeg', 'JPEGBYTES'],
  '/mp4': ['video/mp4', 'MP4BYTES'],
  '/vtt': ['text/vtt', 'WEBVTT'],
  '/srt': ['application/x-subrip', '1\n00:00:01,000 --> 00:00:02,000\nHi'],
}

async function upstream(t) {
  return listen(t, (req, res) => {
    const hit = UPSTREAM[req.url]
    if (!hit) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': hit[0] })
    res.end(hit[1])
  })
}

async function mountAddonProxy(t, base) {
  quiet(t)
  const addon = { id: 'a', name: 'A', accountId: 'acct', proxyUuid: 'uuid-1', manifestUrl: `${base}/manifest.json` }
  const prisma = { addon: { findFirst: async () => addon } }
  const app = express()
  app.use('/proxy', proxyFactory({ prisma, decrypt: (v) => v, getAccountId: () => 'acct', getServerKey: () => Buffer.alloc(32) }))
  proxyFactory._test.clearCache()
  return `${await listen(t, app)}/proxy/uuid-1`
}

async function mountStreams(t, base) {
  quiet(t)
  const key = crypto.randomBytes(32)
  const proxy = streamProxyFactory({ getServerKey: () => key })
  const app = express()
  app.use('/stream', proxy.router)
  const root = await listen(t, app)
  return (p) => `${root}/stream/${proxy.encryptStreamUrl(`${base}${p}`, key)}`
}

const routes = [
  ['addon proxy', async (t, base) => { const p = await mountAddonProxy(t, base); return (x) => `${p}${x}` }],
  ['stream proxy', mountStreams],
]

for (const [name, mount] of routes) {
  test(`${name}: HTML, JavaScript, SVG, XML and CSS go out as a download, not as a page`, async (t) => {
    const link = await mount(t, await upstream(t))
    for (const p of ['/html', '/js', '/svg', '/xml', '/css']) {
      // Twice: the second answer of the addon proxy may come from its cache.
      for (let i = 0; i < 2; i++) {
        const r = await get(link(p))
        assert.equal(r.status, 200, p)
        assert.equal(r.headers['content-type'], 'application/octet-stream', p)
        assert.equal(r.headers['content-disposition'], 'attachment', p)
        assert.equal(r.headers['content-security-policy'], CSP, p)
        assert.equal(r.headers['x-content-type-options'], 'nosniff', p)
      }
    }
  })

  test(`${name}: JSON, images, video and subtitles pass through unchanged, still locked down`, async (t) => {
    const link = await mount(t, await upstream(t))
    for (const p of ['/json', '/jpeg', '/mp4', '/vtt', '/srt']) {
      for (let i = 0; i < 2; i++) {
        const r = await get(link(p))
        assert.equal(r.status, 200, p)
        // Express adds a charset to text types when it sets the header.
        assert.ok(r.headers['content-type'].startsWith(UPSTREAM[p][0].split(';')[0]), p)
        assert.equal(r.body, UPSTREAM[p][1], p)
        assert.notEqual(r.headers['content-disposition'], 'attachment', p)
        assert.equal(r.headers['content-security-policy'], CSP, p)
        assert.equal(r.headers['x-content-type-options'], 'nosniff', p)
      }
    }
  })
}

test('addon proxy: an unsafe answer is not cached as a page for the next caller', async (t) => {
  const link = await mountAddonProxy(t, await upstream(t))
  await get(`${link}/html`)
  assert.equal(proxyFactory._test.cacheStats().entries, 0)
})

test('isSafeContentType: the kinds clients ask for are safe, page-like ones are not', () => {
  const { isSafeContentType } = streamProxyFactory
  for (const ok of ['application/json', 'application/vnd.api+json', 'image/png', 'video/x-matroska', 'audio/mpeg', 'text/vtt', 'text/plain; charset=utf-8', 'application/octet-stream', 'application/vnd.apple.mpegurl', '']) {
    assert.equal(isSafeContentType(ok), true, ok)
  }
  for (const bad of ['text/html', 'TEXT/HTML; charset=x', 'application/xhtml+xml', 'application/javascript', 'text/javascript', 'image/svg+xml', 'text/xml', 'application/xml', 'text/css']) {
    assert.equal(isSafeContentType(bad), false, bad)
  }
})
