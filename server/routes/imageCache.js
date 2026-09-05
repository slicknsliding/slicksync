const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { Jimp } = require('jimp');

// WebP encoding, loaded once and lazily.
//
// Jimp on its own writes JPEG and nothing else here, and a poster is the one
// thing this app serves thousands of: measured on a real TMDb poster at 342
// wide, WebP q78 is 33.3KB against JPEG q80's 45.3KB - a quarter of the
// bytes gone for the same picture, which is felt most on the phones and TVs
// this cache exists for.
//
// The codec is a WASM plugin rather than a native binary, deliberately: the
// same reason this route uses Jimp and not sharp (see the file comment) -
// nothing to fail to resolve under bun-on-alpine. It is ESM-only, hence the
// dynamic import, and it costs about 45ms more per encode, paid once per
// poster+width and never again.
//
// If the plugin cannot be loaded for any reason, this quietly falls back to
// plain Jimp and everything keeps serving JPEG exactly as before.
let encoderPromise = null;
function getEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      try {
        const [core, jimpMod, webpMod] = await Promise.all([
          import('@jimp/core'),
          import('jimp'),
          import('@jimp/wasm-webp'),
        ]);
        const webp = webpMod.default || webpMod.webp;
        const J = core.createJimp({
          formats: [...jimpMod.defaultFormats, webp],
          plugins: jimpMod.defaultPlugins,
        });
        return { read: (b) => J.read(b), webp: true };
      } catch (e) {
        console.warn('[ImageCache] WebP unavailable, serving JPEG:', e?.message);
        return { read: (b) => Jimp.read(b), webp: false };
      }
    })();
  }
  return encoderPromise;
}

// Poster resize/cache proxy. Poster sources (metahub, TMDb, addon artwork)
// serve one fixed size - typically 300x450+ JPEGs - while the app's cards
// display at ~90-180 CSS pixels. This endpoint fetches the original ONCE,
// resizes it to the width actually displayed, and serves it from a disk
// cache forever after: less data on phones/TV, faster grids, and repeat
// views never leave the operator's own box.
//
// Deliberately a sibling of /api/poster (posters.js), not a replacement:
// that route's whole job is keeping the RPDB API key out of rendered <img>
// URLs via a redirect, and its images already embed rating bars sized by
// RPDB itself. This route handles everything else - plain http(s) poster
// URLs already stored in item data.
//
// Jimp, not sharp, on purpose - same reasoning documented in
// utils/posterMosaic.js: pure JS, no native binary to fail to resolve
// under bun-on-alpine. Slower per image (~100-300ms), but each unique
// poster+width pays that exactly once, then it's a disk read.
//
// Anything that can't or shouldn't be processed (animated GIFs - Jimp
// would freeze them to frame one - SVGs, oversized files, fetch errors,
// decode errors) falls back to a 302 redirect to the original URL, so a
// broken cache path can never mean a broken image in the UI.

// Only these output widths exist. A fixed menu keeps one origin image from
// being cached at unbounded arbitrary sizes (cache-bombing) and matches
// what the UI actually renders: 342 covers poster cards up to ~170 CSS px
// at 2x DPR; 780 covers the detail modal's backdrop art.
const ALLOWED_WIDTHS = [154, 342, 500, 780];

const CACHE_DIR = path.join(process.cwd(), 'data', 'poster-cache');
const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // refuse to buffer anything bigger
const FETCH_TIMEOUT_MS = 10000;
// Prune target: posters are ~10-25KB each at these widths, so this is
// roughly 20-40k cached images - far beyond any real library before the
// oldest entries start rotating out.
const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const PRUNE_CHECK_EVERY_WRITES = 200;

function isPrivateIp(ip) {
  // Covers the ranges an SSRF attempt would aim at: loopback, RFC1918,
  // link-local (incl. cloud metadata at 169.254.169.254), and their IPv6
  // equivalents. The proxy only ever needs to reach public image CDNs.
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return isPrivateIp(v4[1]);
  return false;
}

async function assertSafeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('blocked host');
  }
  // Literal IP in the URL, or whatever DNS resolves the name to - both
  // checked, so neither a raw 169.254.169.254 nor a name pointing at it
  // gets through.
  if (isPrivateIp(host)) throw new Error('blocked host');
  try {
    const { address } = await dns.lookup(host);
    if (isPrivateIp(address)) throw new Error('blocked host');
  } catch (e) {
    if (e.message === 'blocked host') throw e;
    throw new Error('unresolvable host');
  }
  return url;
}

module.exports = () => {
  const router = express.Router();

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Dedupe concurrent misses for the same image+width - a freshly rendered
  // grid requests dozens of posters at once, and without this two requests
  // racing on the same cold entry would both fetch and both resize.
  const inFlight = new Map();
  let writesSincePrune = 0;

  function pruneIfNeeded() {
    writesSincePrune += 1;
    if (writesSincePrune < PRUNE_CHECK_EVERY_WRITES) return;
    writesSincePrune = 0;
    // Fire-and-forget: pruning is bookkeeping, never worth delaying a
    // response for.
    (async () => {
      try {
        const entries = await fs.promises.readdir(CACHE_DIR);
        const stats = await Promise.all(entries.map(async (name) => {
          const p = path.join(CACHE_DIR, name);
          try { const s = await fs.promises.stat(p); return { p, size: s.size, mtime: s.mtimeMs }; } catch { return null; }
        }));
        const files = stats.filter(Boolean);
        let total = files.reduce((sum, f) => sum + f.size, 0);
        if (total <= MAX_CACHE_BYTES) return;
        files.sort((a, b) => a.mtime - b.mtime);
        for (const f of files) {
          if (total <= MAX_CACHE_BYTES * 0.8) break;
          try { await fs.promises.unlink(f.p); total -= f.size; } catch {}
        }
      } catch {}
    })();
  }

  // GET /api/img?src=<encoded absolute http(s) URL>&w=<allowed width>
  router.get('/', async (req, res) => {
    const src = String(req.query.src || '');
    const requestedW = parseInt(String(req.query.w || ''), 10);
    if (!src) return res.status(400).json({ error: 'src required' });
    // Snap to the nearest allowed width rather than 400ing - callers pass a
    // constant from the client helper anyway, this just keeps the contract
    // forgiving.
    const w = Number.isFinite(requestedW)
      ? ALLOWED_WIDTHS.reduce((best, cur) => (Math.abs(cur - requestedW) < Math.abs(best - requestedW) ? cur : best))
      : 342;

    // Format is negotiated, not guessed: every browser that can decode WebP
    // says so in Accept, and anything that does not keeps getting JPEG. The
    // format is part of the cache key so the two never overwrite each other,
    // and Vary tells any cache in between that this response depends on the
    // request's Accept header.
    const encoder = await getEncoder();
    const wantsWebp = encoder.webp && /image\/webp/i.test(String(req.get('accept') || ''));
    const ext = wantsWebp ? 'webp' : 'jpg';
    const contentType = wantsWebp ? 'image/webp' : 'image/jpeg';
    res.setHeader('Vary', 'Accept');

    const hash = crypto.createHash('sha1').update(src).digest('hex');
    const key = `${hash}-w${w}.${ext}`;
    const cachePath = path.join(CACHE_DIR, key);
    // The same image in the other format. Because the format is part of the
    // cache key, the day WebP was switched on turned every already-cached
    // poster into a miss - each one re-fetched and re-encoded while someone
    // waited on the grid (measured: 561ms cold against 3ms warm). A format
    // change should be invisible, so a miss falls back to the copy that does
    // exist and upgrades quietly in the background.
    const altExt = wantsWebp ? 'jpg' : 'webp';
    const altPath = path.join(CACHE_DIR, `${hash}-w${w}.${altExt}`);
    const altType = wantsWebp ? 'image/jpeg' : 'image/webp';

    // Cache hit: serve the file with immutable caching - the key hashes the
    // source URL, so new art means a new URL means a new key.
    try {
      await fs.promises.access(cachePath);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', contentType);
      return fs.createReadStream(cachePath).pipe(res);
    } catch {}

    const fallback = () => {
      try { res.redirect(302, src); } catch {}
    };

    // Nothing in the requested format yet, but the other one is already on
    // disk: serve that immediately and encode the requested format behind
    // the response, so the next view gets it and nobody waits for the
    // switch. Only when neither exists does a request pay for a fetch.
    try {
      await fs.promises.access(altPath);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', altType);
      fs.createReadStream(altPath).pipe(res);
      if (!inFlight.has(key)) {
        const upgrade = (async () => {
          try {
            const upstream = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!upstream.ok) return;
            const buf = Buffer.from(await upstream.arrayBuffer());
            if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) return;
            const img = await encoder.read(buf);
            if (img.width > w) img.resize({ w });
            const out = wantsWebp
              ? await img.getBuffer('image/webp', { quality: 78 })
              : await img.getBuffer('image/jpeg', { quality: 80 });
            const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
            await fs.promises.writeFile(tmp, out);
            await fs.promises.rename(tmp, cachePath);
          } catch { /* the next request will try again the normal way */ }
          finally { inFlight.delete(key); }
        })();
        inFlight.set(key, upgrade);
      }
      return;
    } catch { /* no other format either - carry on and fetch it properly */ }

    try {
      await assertSafeUrl(src);
    } catch {
      // Not a fetchable/safe URL - don't even redirect to it.
      return res.status(400).json({ error: 'invalid source url' });
    }

    // Animated/vector formats pass straight through untouched.
    if (/\.(gif|svg)(\?|$)/i.test(src)) return fallback();

    if (inFlight.has(key)) {
      try {
        await inFlight.get(key);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Type', contentType);
        return fs.createReadStream(cachePath).pipe(res);
      } catch { return fallback(); }
    }

    // Fetches the origin image, retrying a transient failure before giving
    // up. Without this, one blip - a momentary network hiccup, or the image
    // host briefly rate-limiting a burst, which is exactly what a freshly
    // rendered grid of posters produces - permanently costs that poster its
    // resize and its cache entry: the request falls back to a redirect, so
    // the browser loads the full-size original, and the next view repeats
    // the whole thing because nothing was ever cached. Retries are cheap
    // here and only ever happen on the failure path.
    //
    // Only worth retrying what can plausibly succeed on a second attempt:
    // network/timeout errors, 429, and 5xx. A 404 means the poster genuinely
    // isn't there, and retrying it just delays the fallback.
    const RETRY_DELAYS_MS = [250, 750];
    const fetchOriginWithRetry = async () => {
      let lastErr;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const upstream = await fetch(src, { signal: controller.signal, redirect: 'follow' });
          if (!upstream.ok) {
            const retryable = upstream.status === 429 || upstream.status >= 500;
            const err = new Error(`upstream ${upstream.status}`);
            if (!retryable) throw err;
            lastErr = err;
          } else {
            return upstream;
          }
        } catch (e) {
          // A deliberate non-retryable throw above must not be retried.
          if (/^upstream (4\d\d)/.test(e?.message || '') && !/429/.test(e.message)) throw e;
          lastErr = e;
        } finally {
          clearTimeout(timer);
        }
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
      }
      throw lastErr || new Error('upstream fetch failed');
    };

    const work = (async () => {
      const upstream = await fetchOriginWithRetry();
      const type = (upstream.headers.get('content-type') || '').toLowerCase();
      if (type.includes('gif') || type.includes('svg')) throw new Error('passthrough type');
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) throw new Error('bad size');

      const img = await encoder.read(buf);
      // Only ever downscale - upscaling a small original just burns bytes
      // on blur.
      if (img.width > w) img.resize({ w });
      // 78 for WebP against 80 for JPEG: the two scales are not the same
      // curve, and 78 is where WebP stops being visibly better than the
      // JPEG it replaces while still being materially smaller.
      const out = wantsWebp
        ? await img.getBuffer('image/webp', { quality: 78 })
        : await img.getBuffer('image/jpeg', { quality: 80 });

      // Atomic write (tmp + rename) so a crash mid-write can't leave a
      // truncated file that would then be served as a "hit" forever.
      const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, out);
      await fs.promises.rename(tmp, cachePath);
      pruneIfNeeded();
    })();
    inFlight.set(key, work);

    try {
      await work;
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', contentType);
      return fs.createReadStream(cachePath).pipe(res);
    } catch {
      return fallback();
    } finally {
      inFlight.delete(key);
    }
  });

  return router;
};
