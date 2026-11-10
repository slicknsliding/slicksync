const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const zlib = require('node:zlib')

process.env.MAX_UNPACKED_BYTES = String(1024 * 1024)
const { safeFetch } = require('../server/utils/safeUrl')

test('a small compressed reply that unpacks past the ceiling is cut off; a normal one reads fine', async (t) => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024))
  const fine = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true })))
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(req.url === '/bomb' ? bomb : fine)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.ok(bomb.length < 64 * 1024, 'the bomb itself is small')
  const ok = await safeFetch(`${base}/fine`, {}, { allowPrivate: true })
  assert.deepEqual(await ok.json(), { ok: true })
  const res = await safeFetch(`${base}/bomb`, {}, { allowPrivate: true })
  await assert.rejects(res.arrayBuffer())
})
