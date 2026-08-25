const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { Jimp } = require('jimp');

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

    const key = `${crypto.createHash('sha1').update(src).digest('hex')}-w${w}.jpg`;
    const cachePath = path.join(CACHE_DIR, key);

    // Cache hit: serve the file with immutable caching - the key hashes the
    // source URL, so new art means a new URL means a new key.
    try {
      await fs.promises.access(cachePath);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      return fs.createReadStream(cachePath).pipe(res);
    } catch {}

    const fallback = () => {
      try { res.redirect(302, src); } catch {}
    };

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
        res.setHeader('Content-Type', 'image/jpeg');
        return fs.createReadStream(cachePath).pipe(res);
      } catch { return fallback(); }
    }

    const work = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const upstream = await fetch(src, { signal: controller.signal, redirect: 'follow' });
        if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
        const type = (upstream.headers.get('content-type') || '').toLowerCase();
        if (type.includes('gif') || type.includes('svg')) throw new Error('passthrough type');
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) throw new Error('bad size');

        const img = await Jimp.read(buf);
        // Only ever downscale - upscaling a small original just burns bytes
        // on blur.
        if (img.width > w) img.resize({ w });
        const out = await img.getBuffer('image/jpeg', { quality: 80 });

        // Atomic write (tmp + rename) so a crash mid-write can't leave a
        // truncated file that would then be served as a "hit" forever.
        const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmp, out);
        await fs.promises.rename(tmp, cachePath);
        pruneIfNeeded();
      } finally {
        clearTimeout(timer);
      }
    })();
    inFlight.set(key, work);

    try {
      await work;
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      return fs.createReadStream(cachePath).pipe(res);
    } catch {
      return fallback();
    } finally {
      inFlight.delete(key);
    }
  });

  return router;
};
