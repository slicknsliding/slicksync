// Reads an upstream response's body with a size cap and a deadline. A body
// read with text() or arrayBuffer() is held whole in memory however big it is
// and however long it takes, so a server that streams without end could take
// the shared process down; this gives up at `maxBytes` or after `timeoutMs`
// and cancels the stream.

function tooBig() {
  return Object.assign(new Error('upstream body too large'), { code: 'BODY_TOO_LARGE' })
}

async function readBounded(response, { maxBytes, timeoutMs } = {}) {
  const reader = response?.body?.getReader?.()
  if (!reader) return Buffer.alloc(0)
  const declared = Number(response.headers?.get?.('content-length'))
  if (maxBytes && declared > maxBytes) {
    reader.cancel().catch(() => {})
    throw tooBig()
  }
  let timer
  const deadline = timeoutMs
    ? new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('upstream body timed out'), { code: 'BODY_TIMEOUT' })), timeoutMs)
    })
    : null
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read())
      if (done) break
      total += value.byteLength
      if (maxBytes && total > maxBytes) throw tooBig()
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch (e) {
    reader.cancel().catch(() => {})
    throw e
  } finally {
    clearTimeout(timer)
  }
  return Buffer.concat(chunks, total)
}

module.exports = { readBounded }
