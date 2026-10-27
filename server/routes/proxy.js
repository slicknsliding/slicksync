const express = require('express');
const { logProxyRequest } = require('../utils/proxyLogger');
const streamProxyFactory = require('./streamProxy');
const { isSafeContentType, applyProxiedBodyHeaders } = streamProxyFactory;
const { safeFetch, instancePolicy } = require('../utils/safeUrl');

// In-memory cache for proxied responses (60s TTL).
//
// The key carries the whole request path and an entry used to leave only when
// that exact path was asked for again after it expired, so every distinct
// catalog, meta or stream path stayed in memory for good - and anyone holding
// a proxy link could ask for paths without end. It is bounded three ways: how
// many entries, how many bytes in all, and how big one body may be. When it is
// full the oldest entries go first, and a timer drops the expired ones.
const _proxyCache = new Map(); // key: cacheKey, value: { data, contentType, ts, size }
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const CACHE_SWEEP_MS = 60 * 1000;
let _cacheBytes = 0;

function sizeOf(data) {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
}

function dropCached(key) {
  const rec = _proxyCache.get(key);
  if (!rec) return;
  _proxyCache.delete(key);
  _cacheBytes -= rec.size;
}

function getCachedProxy(key) {
  const rec = _proxyCache.get(key);
  if (!rec) return null;
  if (Date.now() - rec.ts > CACHE_TTL_MS) {
    dropCached(key);
    return null;
  }
  return rec;
}

function setCachedProxy(key, data, contentType) {
  // Re-adding a key must not leave the old copy counted, nor keep its place
  // in the eviction order.
  dropCached(key);
  const size = sizeOf(data);
  if (size > CACHE_MAX_ENTRY_BYTES) return false;
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (_proxyCache.size > 0 && (_proxyCache.size >= CACHE_MAX_ENTRIES || _cacheBytes + size > CACHE_MAX_BYTES)) {
    dropCached(_proxyCache.keys().next().value);
  }
  _proxyCache.set(key, { data, contentType, ts: Date.now(), size });
  _cacheBytes += size;
  return true;
}

// Entries are added in time order, so everything past the first one that is
// still fresh is fresh too.
function sweepProxyCache(now = Date.now()) {
  for (const [key, rec] of _proxyCache) {
    if (now - rec.ts <= CACHE_TTL_MS) break;
    dropCached(key);
  }
}

// unref: a cache sweeper must never be what keeps the process from exiting.
setInterval(sweepProxyCache, CACHE_SWEEP_MS).unref();

/**
 * Get the base URL from a manifest URL
 * e.g., https://addon.com/path/manifest.json -> https://addon.com/path
 */
function getBaseUrl(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json$/i, '');
}

/**
 * Rewrite all occurrences of the original addon URL to the proxy URL
 * This is critical for security - ensures original URL is never exposed
 */
function rewriteUrls(content, originalBaseUrl, proxyBaseUrl, uuid) {
  let text = typeof content === 'string' ? content : JSON.stringify(content);

  // Escape special regex characters in the URL
  const escaped = originalBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Replace https:// variant
  const httpsPattern = new RegExp(escaped.replace(/^https?:/, 'https:'), 'gi');
  text = text.replace(httpsPattern, `${proxyBaseUrl}/proxy/${uuid}`);

  // Replace http:// variant
  const httpPattern = new RegExp(escaped.replace(/^https?:/, 'http:'), 'gi');
  text = text.replace(httpPattern, `${proxyBaseUrl}/proxy/${uuid}`);

  // Replace protocol-relative variant (//domain.com/path)
  const noProtocol = originalBaseUrl.replace(/^https?:/, '');
  const noProtocolEscaped = noProtocol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noProtocolPattern = new RegExp(noProtocolEscaped, 'gi');
  text = text.replace(noProtocolPattern, `${proxyBaseUrl.replace(/^https?:/, '')}/proxy/${uuid}`);

  return text;
}

/**
 * Set CORS headers for Stremio compatibility
 */
function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '86400');
}

/**
 * Get the real client IP address, checking proxy headers first
 */
function getClientIp(req) {
  // Check common proxy headers for the real client IP
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated list, take the first one
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0];
  }
  
  const realIp = req.get('x-real-ip');
  if (realIp) {
    return realIp;
  }
  
  const cfConnectingIp = req.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp;
  }
  
  // Fall back to req.ip if no proxy headers
  return req.ip;
}

module.exports = ({ prisma, decrypt, getAccountId, getServerKey }) => {
  const router = express.Router();
  const { processStreamResponse } = streamProxyFactory({ getServerKey });

  // CORS preflight for all proxy routes
  router.options('/:uuid/*', (req, res) => {
    setCorsHeaders(res);
    res.status(204).end();
  });

  router.options('/:uuid', (req, res) => {
    setCorsHeaders(res);
    res.status(204).end();
  });

  // GET /:uuid/manifest.json - serve manifest from database
  router.get('/:uuid/manifest.json', async (req, res) => {
    const startTime = Date.now();
    const { uuid } = req.params;
    let addon = null;
    let errorMessage = null;
    let requestUrl = null;
    // Outer scope on purpose: the res.on('finish') handler below closes over
    // this. It used to reference `originalManifestUrl`, which is declared
    // with `let` INSIDE the try block, so the closure hit a ReferenceError
    // at response-finish time - and because that runs in an event handler,
    // the throw was uncaught and killed the whole backend process. Serving
    // one proxied manifest took the server down. Matches how the sibling
    // route below has always declared it.
    let upstreamUrl = null;

    // Set up logging to run when response is finished
    res.on('finish', () => {
      const responseTimeMs = Date.now() - startTime;
      if (addon) {
        try {
        logProxyRequest({
          addon,
          accountId: addon.accountId,
          path: '/manifest.json',
          url: requestUrl,
          upstreamUrl,
          method: req.method,
          ip: getClientIp(req),
          userAgent: req.get('user-agent'),
          statusCode: res.statusCode,
          cacheHit: false,
          responseTimeMs,
          error: errorMessage
        });
        } catch (logErr) {
          // Logging is observability, not the request - never let it throw
          // out of this handler, where it would be an uncaught exception.
          console.error('[Proxy] request logging failed:', logErr?.message)
        }
      }
    });

    try {
      setCorsHeaders(res);

      // Look up addon by proxyUuid
      addon = await prisma.addon.findFirst({
        where: {
          proxyUuid: uuid,
          proxyEnabled: true,
          isActive: true
        }
      });

      if (!addon) {
        errorMessage = 'Addon not found or proxy not enabled';
        return res.status(404).json({ error: errorMessage });
      }

      // Decrypt the manifest
      let manifestData;
      try {
        if (addon.manifest) {
          manifestData = JSON.parse(decrypt(addon.manifest, req));
        } else {
          errorMessage = 'Addon manifest not available';
          return res.status(404).json({ error: errorMessage });
        }
      } catch (e) {
        console.error('Error decrypting manifest:', e);
        errorMessage = 'Failed to decrypt manifest';
        return res.status(500).json({ error: errorMessage });
      }

      // Get the original manifest URL to determine base URL for rewriting
      let originalManifestUrl;
      try {
        originalManifestUrl = decrypt(addon.manifestUrl, req);
        // Vault-injected configs: {{vault:<id>}} placeholders resolve to the
        // entry's CURRENT secret here, server-side, at request time - the
        // real key exists only between this line and the upstream fetch.
        // See utils/vaultInjection.js.
        {
          const { hasVaultPlaceholders, resolvePlaceholders } = require('../utils/vaultInjection');
          if (hasVaultPlaceholders(originalManifestUrl)) {
            originalManifestUrl = await resolvePlaceholders(prisma, addon.accountId, originalManifestUrl, decrypt);
          }
        }
        upstreamUrl = originalManifestUrl;
      } catch (e) {
        console.error('Error decrypting manifest URL:', e);
        errorMessage = 'Failed to resolve addon URL';
        return res.status(500).json({ error: errorMessage });
      }

      // Build the proxy URL that was actually accessed (NOT the upstream URL)
      requestUrl = `${req.protocol}://${req.get('host')}/proxy/${uuid}/manifest.json`;

      const originalBaseUrl = getBaseUrl(originalManifestUrl);
      const proxyBaseUrl = `${req.protocol}://${req.get('host')}`;

      // Rewrite all URLs in manifest to point to proxy
      const rewrittenManifest = rewriteUrls(manifestData, originalBaseUrl, proxyBaseUrl, uuid);

      res.set('Content-Type', applyProxiedBodyHeaders(res, 'application/json'));
      res.send(rewrittenManifest);
    } catch (error) {
      console.error('Error serving proxy manifest:', error);
      errorMessage = error?.message || 'Internal server error';
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ALL /:uuid/* - proxy requests to upstream addon
  router.all('/:uuid/*', async (req, res) => {
    const startTime = Date.now();
    const { uuid } = req.params;
    const path = req.params[0]; // Everything after /:uuid/
    let addon = null;
    let cacheHit = false;
    let errorMessage = null;
    let requestUrl = null;
    let upstreamUrl = null;

    // Set up logging to run when response is finished
    res.on('finish', () => {
      const responseTimeMs = Date.now() - startTime;
      if (addon) {
        try {
        logProxyRequest({
          addon,
          accountId: addon.accountId,
          path: `/${path}`,
          url: requestUrl,
          upstreamUrl: upstreamUrl,
          method: req.method,
          ip: getClientIp(req),
          userAgent: req.get('user-agent'),
          statusCode: res.statusCode,
          cacheHit,
          responseTimeMs,
          error: errorMessage
        });
        } catch (logErr) {
          // Logging is observability, not the request - never let it throw
          // out of this handler, where it would be an uncaught exception.
          console.error('[Proxy] request logging failed:', logErr?.message)
        }
      }
    });

    try {
      setCorsHeaders(res);

      // Look up addon by proxyUuid
      addon = await prisma.addon.findFirst({
        where: {
          proxyUuid: uuid,
          proxyEnabled: true,
          isActive: true
        }
      });

      if (!addon) {
        errorMessage = 'Addon not found or proxy not enabled';
        return res.status(404).json({ error: errorMessage });
      }

      // Get the original manifest URL to determine upstream base URL
      let originalManifestUrl;
      try {
        originalManifestUrl = decrypt(addon.manifestUrl, req);
        // Vault-injected configs: {{vault:<id>}} placeholders resolve to the
        // entry's CURRENT secret here, server-side, at request time - the
        // real key exists only between this line and the upstream fetch.
        // See utils/vaultInjection.js.
        {
          const { hasVaultPlaceholders, resolvePlaceholders } = require('../utils/vaultInjection');
          if (hasVaultPlaceholders(originalManifestUrl)) {
            originalManifestUrl = await resolvePlaceholders(prisma, addon.accountId, originalManifestUrl, decrypt);
          }
        }
      } catch (e) {
        console.error('Error decrypting manifest URL:', e);
        errorMessage = 'Failed to resolve addon URL';
        return res.status(500).json({ error: errorMessage });
      }

      const originalBaseUrl = getBaseUrl(originalManifestUrl);
      upstreamUrl = `${originalBaseUrl}/${path}`;
      // `path` is decoded, so an encoded "../" arrives as a real one and the
      // address would climb out of the addon's own path on its server. The
      // resolved address has to stay under the addon's base.
      {
        const base = new URL(`${originalBaseUrl.replace(/\/+$/, '')}/`);
        const resolved = new URL(upstreamUrl);
        if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
          errorMessage = 'Not a path of this addon';
          return res.status(400).json({ error: errorMessage });
        }
      }
      // Build the proxy URL that was actually accessed (NOT the upstream URL)
      requestUrl = `${req.protocol}://${req.get('host')}/proxy/${uuid}/${path}`;
      const proxyBaseUrl = `${req.protocol}://${req.get('host')}`;

      // Check cache first
      const cacheKey = `${uuid}:${path}`;
      const cached = getCachedProxy(cacheKey);
      if (cached) {
        cacheHit = true;
        res.set('Content-Type', applyProxiedBodyHeaders(res, cached.contentType));
        res.set('X-Proxy-Cache', 'HIT');
        res.send(cached.data);
        return;
      }

      // Fetch from upstream
      let upstreamResponse;
      try {
        // The saved address is whatever the addon's owner typed, and this
        // route answers anyone holding the link, so the fetch (and every
        // redirect it meets) goes through the same address check as the rest
        // of the server: an instance serving strangers never reaches its own
        // network, and no install reaches link-local.
        upstreamResponse = await safeFetch(upstreamUrl, {
          method: req.method,
          headers: {
            'User-Agent': 'SlickSync-Proxy/1.0',
            'Accept': req.get('Accept') || '*/*'
          }
        }, instancePolicy());
      } catch (e) {
        console.error('Error fetching from upstream:', e);
        if (['blocked host', 'unsupported protocol', 'invalid url'].includes(e?.message)) {
          errorMessage = 'Upstream address is not allowed';
          return res.status(403).json({ error: errorMessage });
        }
        errorMessage = 'Failed to fetch from upstream addon';
        return res.status(502).json({ error: errorMessage });
      }

      if (!upstreamResponse.ok) {
        errorMessage = `Upstream returned ${upstreamResponse.status}`;
        return res.status(upstreamResponse.status).json({
          error: errorMessage
        });
      }

      const contentType = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
      let responseData;
      // Catalogs, metas and stream lists are what repeat; a binary body is the
      // kind that is big and is not asked for twice in a minute.
      let cacheable = false;

      // Only rewrite URLs for JSON and text content types. A type that is not
      // safe to show on our origin (HTML, JS, SVG...) is not read as text: it
      // goes out as an attachment below and is never cached.
      if (isSafeContentType(contentType) && (contentType.includes('json') || contentType.includes('text'))) {
        cacheable = true;
        const text = await upstreamResponse.text();
        let processedData = rewriteUrls(text, originalBaseUrl, proxyBaseUrl, uuid);
        
        // If this is a stream response, encrypt stream URLs to hide them from clients
        if (path.includes('/stream/') || path.startsWith('stream/')) {
          try {
            const serverKey = getServerKey ? getServerKey() : null;
            if (serverKey) {
              processedData = await processStreamResponse(processedData, serverKey, proxyBaseUrl);
            }
          } catch (streamErr) {
            console.error('Error encrypting stream URLs:', streamErr);
            // Continue with unencrypted data if encryption fails
          }
        }
        
        responseData = processedData;
      } else {
        // For binary content, pass through as-is
        responseData = Buffer.from(await upstreamResponse.arrayBuffer());
      }

      // Cache the response (only for GET requests)
      if (req.method === 'GET' && cacheable) {
        setCachedProxy(cacheKey, responseData, contentType);
      }

      res.set('Content-Type', applyProxiedBodyHeaders(res, contentType));
      res.set('X-Proxy-Cache', 'MISS');
      res.send(responseData);
    } catch (error) {
      console.error('Error proxying request:', error);
      errorMessage = error?.message || 'Internal server error';
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

// Exposed for tests.
module.exports._test = {
  getCachedProxy,
  setCachedProxy,
  sweepProxyCache,
  cacheStats: () => ({ entries: _proxyCache.size, bytes: _cacheBytes }),
  clearCache: () => { _proxyCache.clear(); _cacheBytes = 0; },
  CACHE_MAX_ENTRIES,
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRY_BYTES,
  CACHE_TTL_MS,
};
