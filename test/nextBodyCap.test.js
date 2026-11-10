// A body declared over Next's proxy cap is answered with 413 at once, without
// reaching Next; everything at or under it passes through.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { CAP_BYTES } = require('../scripts/next-body-cap')

function serve() {
  let reached = 0
  const server = http.createServer((req, res) => { reached++; req.resume(); req.on('end', () => res.end('next')) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, reached: () => reached })))
}

function post(port, declared, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'Content-Length': declared } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: 'closed' }) : reject(e)))
    req.write(body)
    req.end()
  })
}

test('a body declared over the cap gets 413 without reaching Next', async () => {
  const s = await serve()
  try {
    const started = Date.now()
    const r = await post(s.port, CAP_BYTES + 1, 'x')
    assert.equal(r.status, 413)
    assert.match(r.data, /too large/)
    assert.ok(Date.now() - started < 2000, 'answered at once')
    assert.equal(s.reached(), 0)
  } finally { s.server.close() }
})

test('a body under the cap goes through to Next', async () => {
  const s = await serve()
  try {
    const r = await post(s.port, 2, 'ok')
    assert.equal(r.status, 200)
    assert.equal(r.data, 'next')
    assert.equal(s.reached(), 1)
  } finally { s.server.close() }
})
