const fs = require('fs');
const path = require('path');

// Log file path
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const PROXY_LOG_FILE = path.join(LOG_DIR, 'proxy.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Max log file size (10MB)
const MAX_LOG_SIZE = 10 * 1024 * 1024;

// Rotated proxy.log.<ts> files kept; older ones are deleted
const KEEP_ROTATED = 3;

/**
 * Reduce an upstream address to what is safe to keep in a shared log: origin plus path,
 * never the query string or credentials. AIOStreams-style addresses carry the encrypted
 * config (and vault-resolved keys) as a path segment, so long key-looking segments are
 * replaced. Anything that does not parse is dropped rather than logged raw.
 */
function redactUpstreamUrl(value) {
  if (!value || typeof value !== 'string') return null;
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    return null;
  }
  const segments = u.pathname.split('/').map((seg) => {
    if (seg.length >= 20 && /^[A-Za-z0-9._~%=+-]+$/.test(seg) && (seg.length >= 32 || /\d/.test(seg))) {
      return ':redacted';
    }
    return seg;
  });
  return `${u.origin}${segments.join('/')}`;
}

/**
 * Log a proxy request to file
 */
function logProxyRequest({ addon, accountId, path: requestPath, url, upstreamUrl, method, ip, userAgent, statusCode, cacheHit, responseTimeMs, error }) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    accountId: accountId || addon?.accountId || null,
    addonId: addon?.id,
    addonName: addon?.name,
    proxyUuid: addon?.proxyUuid,
    path: requestPath,
    url: url || null,
    upstreamUrl: redactUpstreamUrl(upstreamUrl),
    method,
    ip: ip || null,
    userAgent: userAgent ? userAgent.substring(0, 200) : null, // Truncate long UA strings
    statusCode: statusCode || null,
    cacheHit: cacheHit || false,
    responseTimeMs: responseTimeMs || null,
    error: error || null
  };

  const logLine = JSON.stringify(logEntry) + '\n';

  // Write to file (append mode)
  fs.appendFile(PROXY_LOG_FILE, logLine, (err) => {
    if (err) {
      console.error('Error writing to proxy log:', err);
    }
  });

  // Check if rotation needed (async)
  rotateLogIfNeeded();
}

/**
 * Rotate log file if it exceeds max size
 */
async function rotateLogIfNeeded() {
  try {
    const stats = await fs.promises.stat(PROXY_LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      const rotatedFile = `${PROXY_LOG_FILE}.${Date.now()}`;
      await fs.promises.rename(PROXY_LOG_FILE, rotatedFile);
      console.log(`Rotated proxy log to ${rotatedFile}`);
      await pruneRotatedLogs();
    }
  } catch (e) {
    // File doesn't exist yet, ignore
  }
}

/**
 * Delete all but the newest KEEP_ROTATED rotated logs
 */
async function pruneRotatedLogs() {
  try {
    const prefix = `${path.basename(PROXY_LOG_FILE)}.`;
    const rotated = (await fs.promises.readdir(path.dirname(PROXY_LOG_FILE)))
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    for (const name of rotated.slice(KEEP_ROTATED)) {
      await fs.promises.unlink(path.join(path.dirname(PROXY_LOG_FILE), name)).catch(() => {});
    }
  } catch (e) {
    // Best effort
  }
}

/**
 * Read proxy logs from file
 * @param {Object} options - Filter options
 * @param {string} options.addonId - Filter by addon ID
 * @param {string} options.proxyUuid - Filter by proxy UUID
 * @param {string} options.accountId - Only entries belonging to this account (see accountAddonIds)
 * @param {Iterable<string>} options.accountAddonIds - The account's addon ids: entries written before accountId was
 *   recorded are attributed by their addonId
 * @param {boolean} options.includeUnattributed - Also keep entries tied to no addon or account (single-account installs only)
 * @param {number} options.limit - Max number of entries to return (default 100)
 * @param {number} options.offset - Number of entries to skip (default 0)
 * @returns {Promise<{logs: Array, total: number}>}
 */
async function readProxyLogs(options = {}) {
  const { addonId, proxyUuid, accountId, accountAddonIds, includeUnattributed = false, limit = 100, offset = 0 } = options;
  const ownAddonIds = new Set(accountAddonIds || []);
  const matches = (log) => {
    if (accountId) {
      if (log.accountId) { if (log.accountId !== accountId) return false; }
      else if (log.addonId) { if (!ownAddonIds.has(log.addonId)) return false; }
      else if (!includeUnattributed) return false;
    }
    if (addonId && log.addonId !== addonId) return false;
    if (proxyUuid && log.proxyUuid !== proxyUuid) return false;
    return true;
  };

  try {
    if (!fs.existsSync(PROXY_LOG_FILE)) {
      return { logs: [], total: 0 };
    }

    // Read line by line, keeping only what the page needs. The newest entry
    // is the last line, so the page (newest first, from `offset`) is the
    // last offset+limit matching lines: hold just those in a ring and count
    // the rest. The whole 10 MB file used to be read into one string and
    // every line parsed into memory to show a hundred rows.
    const window = Math.max(0, Number(offset) || 0) + Math.max(0, Number(limit) || 0);
    const ring = new Array(window);
    let total = 0;
    const rl = require('readline').createInterface({ input: fs.createReadStream(PROXY_LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let log;
      try { log = JSON.parse(line); } catch { continue; }
      if (!log || !matches(log)) continue;
      if (window) ring[total % window] = log;
      total++;
    }

    const logs = [];
    const kept = Math.min(total, window);
    for (let i = 1; i <= kept; i++) logs.push(ring[(total - i) % window]);
    const page = logs.slice(offset, offset + limit)
      .map((log) => (log.upstreamUrl ? { ...log, upstreamUrl: redactUpstreamUrl(log.upstreamUrl) } : log));
    return { logs: page, total };
  } catch (e) {
    console.error('Error reading proxy logs:', e);
    return { logs: [], total: 0 };
  }
}

/**
 * Get log file stats
 */
async function getLogStats() {
  try {
    const stats = await fs.promises.stat(PROXY_LOG_FILE);
    return {
      exists: true,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      lastModified: stats.mtime
    };
  } catch (e) {
    return {
      exists: false,
      size: 0,
      sizeFormatted: '0 B',
      lastModified: null
    };
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  logProxyRequest,
  readProxyLogs,
  getLogStats,
  redactUpstreamUrl,
  pruneRotatedLogs,
  PROXY_LOG_FILE
};
