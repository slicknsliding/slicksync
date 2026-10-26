// Whether an address someone typed in is safe for this server to fetch.
//
// Two levels, chosen by the caller:
//   - the default, for an instance that serves strangers: loopback, RFC1918,
//     carrier-grade NAT, link-local (cloud metadata included) and their IPv6
//     equivalents are refused, by literal IP and by what the name resolves to;
//   - allowPrivate, for a household's own install: a server on the LAN or on
//     the same machine is exactly what people point it at, so only link-local
//     is refused - nothing a person legitimately adds lives there, and it is
//     where a cloud host keeps its credentials.
// Either way the address must be http or https.

const dns = require('dns').promises
const net = require('net')
const http = require('http')
const https = require('https')
const zlib = require('zlib')
const { Readable, PassThrough, pipeline } = require('stream')

// Taken now so a test that swaps global.fetch for a stand-in is still
// answered by it; nothing in production ever replaces it.
const nativeFetch = globalThis.fetch

function v4Parts(ip) {
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null
}

// An IPv4 address carried inside an IPv6 one: ::ffff:1.2.3.4, the form URL
// parsing turns that into (::ffff:102:304), and the NAT64 prefix.
function embeddedV4(lower) {
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const hi = parseInt(hex[1], 16)
  const lo = parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Link-local: 169.254.0.0/16 (cloud metadata lives here) and fe80::/10. */
function isLinkLocalIp(ip) {
  const lower = String(ip || '').toLowerCase()
  const kind = net.isIP(lower)
  if (kind === 4) {
    const p = v4Parts(lower)
    return !!p && p[0] === 169 && p[1] === 254
  }
  if (kind === 6) {
    const inner = embeddedV4(lower)
    if (inner) return isLinkLocalIp(inner)
    return /^fe[89ab]/.test(lower)
  }
  return false
}

/**
 * An address that is not on the public internet. Only ever true for an IP -
 * a hostname is not an address, and treating it as one refused real sites
 * whose name happens to start like a private IPv6 range ("fc2.com").
 */
function isPrivateIp(ip) {
  const lower = String(ip || '').toLowerCase()
  const kind = net.isIP(lower)
  if (kind === 4) {
    const p = v4Parts(lower)
    if (!p) return true
    const [a, b] = p
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    return a >= 224 // multicast and reserved
  }
  if (kind === 6) {
    const inner = embeddedV4(lower)
    if (inner) return isPrivateIp(inner)
    if (lower === '::' || lower === '::1') return true
    return /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower) || lower.startsWith('ff')
  }
  return false
}

const stripBrackets = (host) => host.replace(/^\[|\]$/g, '')

/**
 * Throws unless `raw` is an http(s) address this server may fetch; returns
 * the parsed URL. Every address the name resolves to is checked, not just
 * the first - a name with one public and one internal record must not pass.
 */
async function assertSafeUrl(raw, { allowPrivate = false } = {}) {
  let url
  try { url = new URL(raw) } catch { throw new Error('invalid url') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  const host = stripBrackets(url.hostname.toLowerCase())
  const refused = allowPrivate ? isLinkLocalIp : isPrivateIp
  if (net.isIP(host)) {
    if (refused(host)) throw new Error('blocked host')
    return url
  }
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    throw new Error('blocked host')
  }
  let addresses
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new Error('unresolvable host')
  }
  if (!addresses.length) throw new Error('unresolvable host')
  if (addresses.some((a) => refused(a.address))) throw new Error('blocked host')
  return url
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

function abortError() {
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Waits for `work`, but gives up as soon as `signal` aborts, with the same
 * reason fetch would have thrown. The address lookup cannot be cancelled, so
 * without this a caller's timeout would wait out a stalled resolver first.
 */
function untilAborted(work, signal) {
  if (!signal) return work
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.reject(signal.reason ?? abortError())
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * The name a request connects to is looked up again by the socket, after
 * assertSafeUrl already looked it up once. A name that answers with a public
 * address to the check and an internal one to the connection (DNS rebinding)
 * would pass the first and reach the second. So the connection does its own
 * lookup through here, and every address it could use is vetted: what is
 * checked is what is connected to. Honoured by both Node and Bun.
 */
function vettedLookup(allowPrivate) {
  const refused = allowPrivate ? isLinkLocalIp : isPrivateIp
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    dns.lookup(host, { all: true }).then((addresses) => {
      if (!addresses.length) throw new Error('unresolvable host')
      if (addresses.some((a) => refused(a.address))) throw new Error('blocked host')
      if (opts && opts.all) cb(null, addresses)
      else cb(null, addresses[0].address, addresses[0].family)
    }).catch((err) => cb(err))
  }
}

const NO_BODY = new Set([101, 204, 205, 304])

function toRequestBody(body) {
  if (body == null) return null
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return body.toString()
  throw new TypeError('unsupported request body')
}

/**
 * One request over node:http(s), answered as a fetch Response. Unlike fetch
 * this lets the connection's own address lookup be vetted (vettedLookup), and
 * it behaves the same under Node and Bun, where an undici dispatcher would not.
 * TLS still checks the certificate against the real hostname. Redirects are
 * not followed: safeFetch does that, hop by hop.
 */
function pinnedRequest(urlString, options, allowPrivate) {
  const url = new URL(urlString)
  const secure = url.protocol === 'https:'
  const headers = new Headers(options.headers || {})
  // fetch would decompress for the caller; asking for nothing keeps that out
  // of the way, and a server that compresses anyway is unpacked below.
  const method = String(options.method || 'GET').toUpperCase()
  const body = toRequestBody(options.body)
  if (body != null && !headers.has('content-length')) headers.set('content-length', String(Buffer.byteLength(body)))
  const signal = options.signal
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError())
    const host = stripBrackets(url.hostname)
    const req = (secure ? https : http).request({
      protocol: url.protocol,
      host,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers),
      lookup: net.isIP(host) ? undefined : vettedLookup(allowPrivate),
    })
    // Rejected here as well as destroyed: Bun closes the socket without raising.
    const onAbort = () => { const reason = signal.reason ?? abortError(); req.destroy(reason); reject(reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)
    req.once('error', (err) => { done(); reject(err) })
    req.once('response', (incoming) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v)
      }
      let stream = incoming
      const encoding = String(incoming.headers['content-encoding'] || '').toLowerCase()
      const unpack = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding]
      if (unpack) {
        stream = pipeline(incoming, unpack(), new PassThrough(), () => {})
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }
      incoming.once('close', done)
      const res = new Response(NO_BODY.has(incoming.statusCode) || method === 'HEAD' ? null : Readable.toWeb(stream), {
        status: incoming.statusCode,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      })
      if (NO_BODY.has(incoming.statusCode) || method === 'HEAD') incoming.resume()
      Object.defineProperty(res, 'url', { value: urlString })
      resolve(res)
    })
    req.end(body)
  })
}

/**
 * fetch, with the same check applied to every redirect on the way. A plain
 * fetch after assertSafeUrl only vouches for the first address: a public
 * host can answer with a redirect to an internal one, and it was followed.
 * The address each request connects to is vetted as the connection is made
 * (see vettedLookup), so a name that changes its answer in between does not
 * get through either.
 *
 * `vet`, when given, is asked about every address (the first and each hop)
 * instead of the default check, for a caller that holds redirects to a rule of
 * its own. It returns or throws like assertSafeUrl.
 */
async function safeFetch(raw, init = {}, { allowPrivate = false, maxRedirects = 5, vet } = {}) {
  let current = String(raw)
  let options = { ...init, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    await untilAborted(vet ? vet(current) : assertSafeUrl(current, { allowPrivate }), options.signal)
    const res = globalThis.fetch !== nativeFetch
      ? await globalThis.fetch(current, options)
      : await pinnedRequest(current, options, allowPrivate)
    const location = REDIRECTS.has(res.status) ? res.headers.get('location') : null
    if (!location) return res
    if (hop >= maxRedirects) throw new Error('too many redirects')
    try { await res.body?.cancel() } catch {}
    const next = new URL(location, current)
    const method = String(options.method || 'GET').toUpperCase()
    // A redirected POST becomes a GET, as browsers do it (always for 303).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const { body: _body, ...rest } = options
      options = { ...rest, method: 'GET' }
    }
    // Credentials meant for the first host do not travel to another one.
    if (next.origin !== new URL(current).origin && options.headers) {
      const headers = new Headers(options.headers)
      for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name)
      options = { ...options, headers }
    }
    current = next.toString()
  }
}

/** What this install allows: a private one may reach its own network. */
function instancePolicy() {
  return { allowPrivate: require('./config').INSTANCE_TYPE !== 'public' }
}

module.exports = { isPrivateIp, isLinkLocalIp, assertSafeUrl, safeFetch, instancePolicy }
