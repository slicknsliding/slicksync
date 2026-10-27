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
const net = require('net')
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

const { assertSafeUrl, isPrivateIp, safeFetch, instancePolicy } = require('./safeUrl')

// Ranges the entry check below refuses on an instance serving strangers but
// that a household's own install has always been able to fetch posters from:
// carrier-grade NAT (a Tailscale address, an addon on a tailnet), Tailscale's
// IPv6 range, and the benchmarking block (where a fake-IP proxy answers every
// name).
function isHouseholdReachableRange(ip) {
  const kind = net.isIP(ip)
  if (kind === 6) return /^fd7a:115c:a1e0:/i.test(ip)
  if (kind !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
}

// The entry check for a remote poster, used by the route, the pre-warmer and
// every redirect hop. Strict for everyone, except that on a household install an
// address in one of the ranges above is let through - and only those: LAN,
// loopback and link-local stay refused, since the poster route answers anyone
// and would otherwise fetch from the household's network.
async function assertImageUrl(src) {
  try {
    return await assertSafeUrl(src)
  } catch (e) {
    if (e?.message !== 'blocked host' || !instancePolicy().allowPrivate) throw e
    let url
    try { url = new URL(src) } catch { throw e }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    let addresses
    if (net.isIP(host)) addresses = [host]
    else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw e
    else {
      try { addresses = (await dns.lookup(host, { all: true })).map((a) => a.address) } catch { throw e }
    }
    if (!addresses.length || !addresses.every((ip) => !isPrivateIp(ip) || isHouseholdReachableRange(ip))) throw e
    return url
  }
}

// A refusal will not change on a second attempt, so it is not retried the way
// a timeout or a 503 is. (A name that could not be looked up may be a passing
// DNS failure, and keeps its retries.)
const NOT_RETRYABLE = new Set(['blocked host', 'unsupported protocol', 'invalid url', 'too many redirects'])

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

async function fetchOriginWithRetry(src, { followRedirects = true } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      // Redirects are followed by safeFetch, which checks every hop: a poster
      // host that is itself public could otherwise answer with a redirect to
      // an address this server must not fetch. Real poster hosts (TMDb,
      // fanart, Kitsu, MetaHub) redirect over http to https and across
      // regions, which stays well inside its five-hop limit. Every hop is held
      // to the same rule as the address the route accepted, so a household
      // install does not follow a redirect to its LAN either. The no-follow
      // mode is for a home server's own posters and is left as it was.
      const upstream = followRedirects
        ? await safeFetch(src, { signal: controller.signal }, { ...instancePolicy(), vet: assertImageUrl })
        : await fetch(src, { signal: controller.signal, redirect: 'manual' })
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
      if (NOT_RETRYABLE.has(e?.message)) throw e
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

// Sources fetched in the last minute, so the request that arrives while a
// poster's resize is still running doesn't fetch it from the CDN again.
const recentSources = new Map() // src -> { at, buf }
const RECENT_SOURCE_MS = 60 * 1000
const RECENT_SOURCE_MAX = 64

// The source bytes, wherever they live.
async function readSource(src, localFile, followRedirects = true) {
  if (localFile) return fs.promises.readFile(localFile)
  const held = recentSources.get(src)
  if (held && Date.now() - held.at < RECENT_SOURCE_MS) return held.buf
  const upstream = await fetchOriginWithRetry(src, { followRedirects })
  const type = (upstream.headers.get('content-type') || '').toLowerCase()
  if (type.includes('gif') || type.includes('svg')) throw new Error('passthrough type')
  const buf = Buffer.from(await upstream.arrayBuffer())
  recentSources.set(src, { at: Date.now(), buf })
  while (recentSources.size > RECENT_SOURCE_MAX) recentSources.delete(recentSources.keys().next().value)
  return buf
}

// A first-ever request for a poster that needs resizing is answered with the
// original at once when it is small enough to send as it is - the resize
// joins the encode queue behind the response. A freshly opened grid of new
// posters used to wait in that queue (three at a time, 100-200ms each): a
// screenful took 1.5-2 seconds to fill. The next request gets the resized file.
// Only when the original is near the size asked for: a tiny copy stands in for
// a blur (the detail panel's backdrop art on phones once was one), and sending
// the full picture there puts a sharp second scene where a soft glow belongs.
const QUICK_MAX_BYTES = 300 * 1024
const QUICK_MAX_SCALE = 3
const QUICK_TYPES = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }

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
 * piece of work. With `quick`, a source that would have to wait for an
 * encode comes back as { buf, contentType, provisional } instead, and the
 * encode runs behind it (see QUICK_MAX_BYTES).
 */
function produce(src, { w, wantsWebp, localFile = null, followRedirects = true, quick = false }) {
  const p = pathsFor(src, w)
  const key = `${wantsWebp ? p.webp : p.jpg}${quick ? ':quick' : ''}`
  if (inFlight.has(key)) return inFlight.get(key)

  const work = (async () => {
    const buf = await readSource(src, localFile, followRedirects)
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
    if (quick && !localFile && buf.length <= QUICK_MAX_BYTES && QUICK_TYPES[fmt] && dims && dims.width <= w * QUICK_MAX_SCALE) {
      scheduleEncode(wanted === 'webp' ? p.webp : p.jpg, buf, { w, format: wanted })
      return { buf, contentType: QUICK_TYPES[fmt], provisional: true }
    }
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
  await assertImageUrl(src)
  await produce(src, { w: width, wantsWebp: true })
  return true
}

module.exports = {
  ALLOWED_WIDTHS,
  snapWidth,
  resolveLocalAvatar,
  isPassthroughUrl,
  assertSafeUrl,
  assertImageUrl,
  isHouseholdReachableRange,
  findCached,
  produce,
  warm,
  getEncoder,
}
