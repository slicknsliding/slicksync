// An upstream body is read with a size cap and a deadline, so one endless or
// huge reply cannot hold the shared process.
const test = require('node:test')
const assert = require('node:assert/strict')

const { readBounded } = require('../server/utils/boundedBody')

// A body that hands out `chunk` every `everyMs`, forever, and says when it was cancelled.
function endless(chunk, everyMs = 0) {
  const state = { cancelled: false }
  const body = new ReadableStream({
    async pull(controller) {
      if (everyMs) await new Promise((r) => setTimeout(r, everyMs))
      controller.enqueue(chunk)
    },
    cancel() { state.cancelled = true },
  })
  return { response: new Response(body), state }
}

test('a body under the cap is read whole', async () => {
  const buf = await readBounded(new Response('hello'), { maxBytes: 100, timeoutMs: 1000 })
  assert.equal(buf.toString(), 'hello')
})

test('an endless body stops at the cap and the stream is cancelled', async () => {
  const { response, state } = endless(new Uint8Array(64 * 1024))
  await assert.rejects(readBounded(response, { maxBytes: 1024 * 1024, timeoutMs: 5000 }), { code: 'BODY_TOO_LARGE' })
  assert.equal(state.cancelled, true)
})

test('a declared size over the cap is refused before reading', async () => {
  const response = new Response('x', { headers: { 'content-length': String(50 * 1024 * 1024) } })
  await assert.rejects(readBounded(response, { maxBytes: 1024 }), { code: 'BODY_TOO_LARGE' })
})

test('a slow body stops at the deadline', async () => {
  const { response, state } = endless(new Uint8Array(10), 50)
  await assert.rejects(readBounded(response, { maxBytes: 1024 * 1024, timeoutMs: 200 }), { code: 'BODY_TIMEOUT' })
  assert.equal(state.cancelled, true)
})
