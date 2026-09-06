/**
 * The poster resize/cache pipeline, behind both the /api/img route
 * (routes/imageCache.js) and the background pre-warmer (utils/posterWarm.js).
 *
 * Poster sources (metahub, TMDb, addon artwork) serve one fixed size -
 * typically a 300x450 JPEG - while the app's cards display at 40-180 CSS
 * pixels. Each unique source+width is produced ONCE and served from disk
 * forever after; the cache key hashes the source URL, so new art means a
 * new URL means a new key.
 *
 * What "produced" means depends on what arrived:
 *
 * - Already narrow enough, already JPEG or WebP: the bytes are kept as they
 *   are. Measured on a real poster, decoding and re-encoding a 300-wide
 *   JPEG for a 342 request cost ~180ms of CPU and gave back a file that was
 *   LARGER than the source. A client that asked for WebP gets the JPEG now
 *   and the WebP is encoded behind the response for next time.
 * - Wider than requested, or PNG/GIF: decoded, downscaled, encoded - in a
 *   worker thread (utils/imageEncodePool.js), so a cold grid fills in
 *   parallel instead of one poster at a time on the request thread.
 *
 * Anything that can't or shouldn't be processed (remote animated GIFs and
 * SVGs, oversized files, fetch errors, decode errors) is reported as an
 * error and the route falls back to a redirect to the original URL, so a
 * broken cache path can never mean a broken image in the UI. A LOCAL GIF
 * (an uploaded avatar) is the one exception: freezing it to a single frame
 * is the entire point of routing avatars through here.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dns = require('dns').promises
const { getEncoder, sniffFormat, sourceDimensions } = require('./imageEncoder')
const pool = require('./imageEncodePool')

// Only these output widths exist. A fixed menu keeps one origin image from
// being cached at unbounded arbitrary sizes and matches what the UI renders:
// 64 for avatars in lists, 154/185 for phone-sized cards, 342 for cards up
// to ~170 CSS px at 2x, 780 for the detail modal's backdrop.
const ALLOWED_WIDTHS = [64, 154, 185, 342, 500, 780]

const CACHE_DIR = path.join(process.cwd(), 'data', 'poster-cache')
// Profile pictures live here (see the express.static mount in index.js);
// they are read straight off the disk rather than fetched over HTTP.
const AVATAR_DIR = path.join(process.cwd(), 'data', 'avatars')
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10000
// Prune target: ~20-40k cached images before the oldest rotate out.
const MAX_CACHE_BYTES = 500 * 1024 * 1024
const PRUNE_CHECK_EVERY_WRITES = 200
// Only what can plausibly succeed on a second attempt is retried:
// network/timeouts, 429, 5xx. A 404 is a real answer.
const RETRY_DELAYS_MS = [250, 750]

fs.mkdirSync(CACHE_DIR, { recursive: true })

// Dedupe concurrent misses for the same output - a freshly rendered grid
// requests dozens of posters at once, and two requests racing on the same
// cold entry must not both fetch and both encode.
const inFlight = new Map()
let writesSincePrune = 0

// Workers start (and load their codecs) at boot, while nothing is waiting.
pool.start()

function isPrivateIp(ip) {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) return isPrivateIp(v4[1])
  return false
}

// The proxy only ever needs to reach public image CDNs: loopback, RFC1918,
// link-local (cloud metadata included) and their IPv6 equivalents are
// refused, by literal IP and by what the name resolves to.
async function assertSafeUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('invalid url') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('blocked host')
  }
  if (isPrivateIp(host)) throw new Error('blocked host')
  try {
    const { address } = await dns.lookup(host)
    if (isPrivateIp(address)) throw new Error('blocked host')
  } catch (e) {
    if (e.message === 'blocked host') throw e
    throw new Error('unresolvable host')
  }
  return url
}

function snapWidth(requested) {
  const n = parseInt(String(requested || ''), 10)
  if (!Number.isFinite(n)) return 342
  return ALLOWED_WIDTHS.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best))
}

/**
 * A src of the form /uploads/avatars/<file> is one of this instance's own
 * profile pictures. Returns { localFile } when it exists, { status } for a
 * request that must be refused, or null when src is not an avatar path.
 */
async function resolveLocalAvatar(src) {
  const m = /^\/uploads\/avatars\/([^/\\]+)$/.exec(String(src || ''))
  if (!m) return null
  const candidate = path.join(AVATAR_DIR, path.basename(m[1]))
  if (!candidate.startsWith(AVATAR_DIR + path.sep)) return { status: 400 }
  try { await fs.promises.access(candidate) } catch { return { status: 404 } }
  return { localFile: candidate }
}

function isPassthroughUrl(src) {
  return /\.(gif|svg)(\?|$)/i.test(String(src || ''))
}

function pathsFor(src, w) {
  const hash = crypto.createHash('sha1').update(String(src)).digest('hex')
  return {
    jpg: path.join(CACHE_DIR, `${hash}-w${w}.jpg`),
    webp: path.join(CACHE_DIR, `${hash}-w${w}.webp`),
  }
}

async function exists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}

// Atomic write (tmp + rename) so a crash mid-write can't leave a truncated
// file that would then be served as a hit forever.
async function writeAtomic(p, buf) {
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fs.promises.writeFile(tmp, buf)
  await fs.promises.rename(tmp, p)
  pruneIfNeeded()
}

function pruneIfNeeded() {
  writesSincePrune += 1
  if (writesSincePrune < PRUNE_CHECK_EVERY_WRITES) return
  writesSincePrune = 0
  // Fire-and-forget: bookkeeping, never worth delaying a response for.
  ;(async () => {
    try {
      const entries = await fs.promises.readdir(CACHE_DIR)
      const stats = await Promise.all(entries.map(async (name) => {
        const p = path.join(CACHE_DIR, name)
        try { const s = await fs.promises.stat(p); return { p, size: s.size, mtime: s.mtimeMs } } catch { return null }
      }))
      const files = stats.filter(Boolean)
      let total = files.reduce((sum, f) => sum + f.size, 0)
      if (total <= MAX_CACHE_BYTES) return
      files.sort((a, b) => a.mtime - b.mtime)
      for (const f of files) {
        if (total <= MAX_CACHE_BYTES * 0.8) break
        try { await fs.promises.unlink(f.p); total -= f.size } catch {}
      }
    } catch {}
  })()
}

async function fetchOriginWithRetry(src) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const upstream = await fetch(src, { signal: controller.signal, redirect: 'follow' })
      if (!upstream.ok) {
        const retryable = upstream.status === 429 || upstream.status >= 500
        const err = new Error(`upstream ${upstream.status}`)
        if (!retryable) throw err
        lastErr = err
      } else {
        return upstream
      }
    } catch (e) {
      if (/^upstream (4\d\d)/.test(e?.message || '') && !/429/.test(e.message)) throw e
      lastErr = e
    } finally {
      clearTimeout(timer)
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastErr || new Error('upstream fetch failed')
}

// The source bytes, wherever they live.
async function readSource(src, localFile) {
  if (localFile) return fs.promises.readFile(localFile)
  const upstream = await fetchOriginWithRetry(src)
  const type = (upstream.headers.get('content-type') || '').toLowerCase()
  if (type.includes('gif') || type.includes('svg')) throw new Error('passthrough type')
  return Buffer.from(await upstream.arrayBuffer())
}

/**
 * What is on disk for this source+width, if anything. `exact` is false
 * when only the other format exists - still served (a format change must
 * never make a cached poster a miss) while the requested one is produced
 * behind the response.
 */
async function findCached(src, w, wantsWebp) {
  const p = pathsFor(src, w)
  const want = wantsWebp ? p.webp : p.jpg
  const other = wantsWebp ? p.jpg : p.webp
  if (await exists(want)) return { path: want, contentType: wantsWebp ? 'image/webp' : 'image/jpeg', exact: true }
  if (await exists(other)) return { path: other, contentType: wantsWebp ? 'image/jpeg' : 'image/webp', exact: false }
  return null
}

/**
 * Produce the requested output (or an acceptable one) for source+width and
 * return where it is. Concurrent callers for the same output share one
 * piece of work.
 */
function produce(src, { w, wantsWebp, localFile = null }) {
  const p = pathsFor(src, w)
  const key = wantsWebp ? p.webp : p.jpg
  if (inFlight.has(key)) return inFlight.get(key)

  const work = (async () => {
    const buf = await readSource(src, localFile)
    if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) throw new Error('bad size')

    const fmt = sniffFormat(buf)
    const dims = sourceDimensions(buf)
    if (dims && dims.width > 0 && dims.width <= w && (fmt === 'jpeg' || fmt === 'webp')) {
      // Nothing to resize and nothing a browser can't take: keep the bytes.
      const outPath = fmt === 'jpeg' ? p.jpg : p.webp
      if (!(await exists(outPath))) await writeAtomic(outPath, buf)
      if (wantsWebp && fmt === 'jpeg') scheduleEncode(p.webp, buf, { w, format: 'webp' })
      return { path: outPath, contentType: fmt === 'jpeg' ? 'image/jpeg' : 'image/webp' }
    }

    const enc = await getEncoder()
    const wanted = wantsWebp && enc.webp ? 'webp' : 'jpeg'
    // The encoder says what it actually produced; a WebP that could not be
    // encoded comes back as a JPEG and is filed as one.
    const { buf: out, format } = await pool.encode(buf, { w, format: wanted })
    const outPath = format === 'webp' ? p.webp : p.jpg
    await writeAtomic(outPath, out)
    return { path: outPath, contentType: format === 'webp' ? 'image/webp' : 'image/jpeg' }
  })()

  inFlight.set(key, work)
  work.finally(() => inFlight.delete(key)).catch(() => {})
  return work
}

// Encode a second format behind a response that has already been served.
function scheduleEncode(outPath, buf, opts) {
  // Its own key: the request that scheduled this is itself registered under
  // outPath while it runs, so keying the job the same way would make it
  // look already-in-flight and never start.
  const key = `${outPath}:background`
  if (inFlight.has(key)) return
  const job = (async () => {
    try {
      if (await exists(outPath)) return
      const { buf: out, format } = await pool.encode(buf, opts)
      // Only file it under the name that matches what came back.
      if (format !== opts.format) return
      await writeAtomic(outPath, out)
    } catch { /* the next request will try again the normal way */ }
  })()
  inFlight.set(key, job)
  job.finally(() => inFlight.delete(key)).catch(() => {})
}

/**
 * Pre-warm: make sure SOME output exists for this remote source at this
 * width, so the request that follows is a disk read. WebP is what nearly
 * every client asks for; a JPEG-only source lands as JPEG (pass-through)
 * and gets its WebP in the background exactly as a live request would.
 */
async function warm(src, w) {
  if (!/^https?:\/\//i.test(String(src || '')) || isPassthroughUrl(src)) return false
  const width = snapWidth(w)
  if (await findCached(src, width, true)) return false
  await assertSafeUrl(src)
  await produce(src, { w: width, wantsWebp: true })
  return true
}

module.exports = {
  ALLOWED_WIDTHS,
  snapWidth,
  resolveLocalAvatar,
  isPassthroughUrl,
  assertSafeUrl,
  findCached,
  produce,
  warm,
  getEncoder,
}
