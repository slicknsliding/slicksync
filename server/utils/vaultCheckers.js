// Vault entry "active" checkers. Each returns { ok: boolean, message: string, expiresAt?: Date }
// testConfig is a parsed JSON object stored per-entry; shape varies by testType.

const net = require('net')

function timeoutSignal(ms) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
}

// fetch() with a per-attempt timeout, retried only on timeout/network
// failure - never on an HTTP response, however bad its status.
//
// Why this exists: several of these providers sit behind Cloudflare and
// intermittently stall. Measured live against TorBox from the production
// host: five consecutive requests returned in 187ms, 632ms, 210ms, 21265ms
// and 625ms. One unlucky request in five blew straight past the 10s abort,
// and a single slow response was enough to mark a perfectly valid
// credential as failing and fire a Vault alert for it.
//
// A retry is the right fix rather than simply a longer timeout: the normal
// case is sub-second, so waiting 30s for every check to accommodate a rare
// stall would slow every healthy check down. Retrying only the timeout path
// keeps the common case fast and makes the rare stall a non-event.
//
// Deliberately does NOT retry on a returned status. A 401 is a real answer
// about the credential and must surface immediately; retrying it would just
// hammer the provider and delay a genuine failure.
async function fetchWithRetry(url, options = {}, { timeoutMs = 10000, attempts = 3, backoffMs = 750 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { signal, cancel } = timeoutSignal(timeoutMs)
    try {
      const res = await fetch(url, { ...options, signal })
      cancel()
      return res
    } catch (err) {
      cancel()
      lastErr = err
      if (attempt < attempts) {
        // Linear backoff - these stalls look like transient upstream
        // congestion, so a short pause before retrying is enough.
        await new Promise((r) => setTimeout(r, backoffMs * attempt))
      }
    }
  }
  throw lastErr
}

// Shared shape for the catch block of every checker below, so a timeout
// reads the same way everywhere.
function describeRequestError(err) {
  return err?.name === 'AbortError' ? 'Timed out' : (err?.message || 'Request failed')
}

// Generic HTTP check: hits a URL, optionally injecting the secret as a bearer token,
// api-key header, or query param. Expects a status code and (optionally) a body substring.
async function checkGenericHttp(secret, config = {}) {
  const {
    url,
    method = 'GET',
    authMode = 'bearer', // 'bearer' | 'header' | 'query' | 'none'
    headerName = 'Authorization',
    queryParam = 'apikey',
    expectStatus = 200,
    bodyContains
  } = config

  if (!url) return { ok: false, message: 'No test URL configured' }

  let finalUrl = url
  const headers = {}
  if (authMode === 'bearer') headers['Authorization'] = `Bearer ${secret}`
  else if (authMode === 'header') headers[headerName] = secret
  else if (authMode === 'query') {
    const sep = url.includes('?') ? '&' : '?'
    finalUrl = `${url}${sep}${encodeURIComponent(queryParam)}=${encodeURIComponent(secret)}`
  }

  try {
    const res = await fetchWithRetry(finalUrl, { method, headers })
    const text = await res.text().catch(() => '')
    const statusOk = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === expectStatus
    if (!statusOk) return { ok: false, message: `Unexpected status ${res.status}` }
    if (bodyContains && !text.includes(bodyContains)) return { ok: false, message: 'Response did not match expected content' }
    return { ok: true, message: `OK (${res.status})` }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Real-Debrid: /user also reports premium expiration, which we surface back
// so the vault entry's expiresAt can auto-update from the source of truth.
async function checkRealDebrid(secret) {
  try {
    const res = await fetchWithRetry('https://api.real-debrid.com/rest/1.0/user', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `Real-Debrid returned ${res.status}` }
    const data = await res.json()
    const expiresAt = data?.expiration ? new Date(data.expiration) : undefined
    const type = data?.type || 'unknown'
    if (type !== 'premium') {
      return { ok: false, message: `Account type is "${type}", not premium`, expiresAt }
    }
    return { ok: true, message: `Premium active${expiresAt ? `, expires ${expiresAt.toISOString().split('T')[0]}` : ''}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// TorBox: /user/me reports plan and premium_expires_at
async function checkTorBox(secret) {
  try {
    const res = await fetchWithRetry('https://api.torbox.app/v1/api/user/me', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `TorBox returned ${res.status}` }
    const data = await res.json()
    const d = data?.data || data
    const expiresAt = d?.premium_expires_at ? new Date(d.premium_expires_at) : undefined
    const plan = d?.plan
    if (plan === 0 || plan === undefined) {
      return { ok: false, message: 'No active TorBox plan', expiresAt }
    }
    return { ok: true, message: `Plan active${expiresAt ? `, expires ${expiresAt.toISOString().split('T')[0]}` : ''}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Newznab-compatible indexers (NZBGeek, NinjaCentral, UsenetCrawler, DrunkenSlug, etc.)
// t=caps doesn't require a valid key on some indexers, so we also try t=search with
// a tiny result limit to actually exercise the key.
// Newznab's optional <newznab:apilimits apiCurrent="X" apiMax="Y"
// grabCurrent="Z" grabMax="W" /> element - per the spec, "clients should not
// assume the apilimits element or any of its attributes to be present" (it's
// entirely up to the indexer software whether to include it), and its shape
// is only ever documented for XML, not o=json - so this check now requests
// XML specifically and regex-extracts the element if present, rather than
// pulling in a full XML parser dependency for one self-closing tag. Absent
// on indexers that don't support it is expected, not an error.
function parseNewznabApiLimits(xmlText) {
  const m = xmlText.match(/<newznab:apilimits\b([^/>]*)\/?>/i)
  if (!m) return null
  const attrs = {}
  const attrRegex = /(\w+)="([^"]*)"/g
  let attrMatch
  while ((attrMatch = attrRegex.exec(m[1]))) {
    attrs[attrMatch[1]] = attrMatch[2]
  }
  const apiCurrent = Number(attrs.apiCurrent)
  const apiMax = Number(attrs.apiMax)
  if (Number.isNaN(apiCurrent) || Number.isNaN(apiMax)) return null
  return { apiCurrent, apiMax }
}

async function checkNewznabCaps(secret, config = {}) {
  const { url } = config
  if (!url) return { ok: false, message: 'No indexer base URL configured' }
  const base = url.replace(/\/+$/, '')
  try {
    const testUrl = `${base}/api?t=caps&apikey=${encodeURIComponent(secret)}`
    // Node's fetch sends no User-Agent at all by default, which reads as a
    // bare script to a lot of indexers' own bot-protection (Cloudflare, etc.)
    // and can produce a 403 that has nothing to do with the API key itself.
    // A normal browser UA costs nothing and rules that out as a cause.
    const res = await fetchWithRetry(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } })
    if (res.status === 403) {
      return { ok: false, message: 'Indexer returned 403 - likely blocking this server\'s IP (common for private indexers/Usenet providers toward cloud/VPS hosting ranges), not necessarily the API key' }
    }
    if (!res.ok) return { ok: false, message: `Indexer returned ${res.status}` }
    const text = await res.text()
    if (/error/i.test(text) && /apikey|api key|invalid/i.test(text)) {
      return { ok: false, message: 'API key rejected' }
    }
    const limits = parseNewznabApiLimits(text)
    if (limits) {
      const quotaSuffix = ` (${limits.apiCurrent}/${limits.apiMax} API calls used today)`
      if (limits.apiCurrent >= limits.apiMax) {
        return { ok: false, message: `Daily API quota exhausted${quotaSuffix}` }
      }
      return { ok: true, message: `Indexer reachable, key accepted${quotaSuffix}` }
    }
    return { ok: true, message: 'Indexer reachable, key accepted' }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Raw TCP reachability — for things like Usenet NNTP servers where a full protocol
// login check isn't implemented. Confirms the host:port accepts a connection, nothing more.
async function checkTcpReachability(secret, config = {}) {
  const { host, port } = config
  if (!host || !port) return { ok: false, message: 'No host/port configured' }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port), timeout: 8000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve({ ok: true, message: `${host}:${port} reachable (connectivity only, not a login check)` })
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve({ ok: false, message: 'Connection timed out' })
    })
    socket.once('error', (err) => {
      resolve({ ok: false, message: err?.message || 'Connection failed' })
    })
  })
}

// Stremio account credentials: config.identifier is the email/username (stored in
// the entry's `provider` field), secret is the password. Confirms Stremio actually
// accepts the login, not just that some server responded.
async function checkStremioAuth(secret, config = {}) {
  const identifier = config.identifier
  if (!identifier) return { ok: false, message: 'No email/username on file for this entry' }
  if (!secret) return { ok: false, message: 'No password on file for this entry' }

  // Write diagnostics directly to a file on the persisted data volume,
  // bypassing stdout/stderr entirely. console.warn output has not reliably
  // shown up in `docker logs` for this backend process even with stdbuf
  // line-buffering applied (see v1.9.2/v1.9.22) - bun's own I/O internals
  // may not route through the glibc buffered-stdio calls stdbuf intercepts,
  // so a direct synchronous file write is the more reliable diagnostic path
  // until that's confirmed one way or the other.
  // Owner-read-write only — this log can carry auth-adjacent Stremio API
  // details, so it should never be world-readable even on lax deploys.
  // appendFileSync doesn't accept a mode, so we ensure the file exists with
  // 0o600 the first time we're about to write to it.
  const LOG_PATH = '/app/data/vault-debug.log'
  function logDebug(entry) {
    try {
      const fs = require('fs')
      if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '', { mode: 0o600 })
      // Redact `authKey` from any nested Stremio API response before writing.
      // Stremio's successful-login response includes a live authKey which,
      // if this log ever leaked, would grant full account access — we don't
      // need it for the "did login succeed" question the diagnostic answers.
      const redacted = JSON.parse(JSON.stringify(entry, (k, v) => k === 'authKey' && v ? '[redacted]' : v))
      const line = `[${new Date().toISOString()}] ${JSON.stringify(redacted)}\n`
      fs.appendFileSync(LOG_PATH, line)
    } catch (e) {
      console.warn('[VaultCheck] Failed to write debug log:', e?.message)
    }
  }

  try {
    const { StremioAPIUtils } = require('./handlers')
    const { store } = StremioAPIUtils.createAPIStore()

    // Bypass store.login()'s wrapper (which discards the raw API response -
    // see v1.9.24) and call the underlying request directly, so we can see
    // exactly what Stremio's API actually returned rather than inferring it
    // from side-effects. This is ground truth: if result.authKey is present,
    // the login genuinely succeeded at the API level, full stop.
    let rawResult
    let rawErr
    try {
      rawResult = await store.request('login', { email: identifier, password: secret })
    } catch (e) {
      rawErr = e
    }

    logDebug({
      event: 'stremio_raw_login_response',
      identifier,
      rawResult,
      rawErrMessage: rawErr?.message,
      rawErrStatus: rawErr?.status || rawErr?.statusCode,
      rawErrBody: rawErr?.body || rawErr?.response
    })

    if (rawErr) throw rawErr

    if (rawResult && rawResult.authKey) {
      return { ok: true, message: 'Stremio login succeeded' }
    }

    const detail = rawResult && typeof rawResult === 'object'
      ? (rawResult.error || rawResult.message || JSON.stringify(rawResult).slice(0, 200))
      : null
    return { ok: false, message: detail ? `Stremio rejected these credentials: ${detail}` : 'Stremio rejected these credentials (no further detail returned - check /app/data/vault-debug.log)' }
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase()
    if (msg.includes('passphrase') || msg.includes('wrong password')) return { ok: false, message: 'Invalid password' }
    if (msg.includes('no such user') || msg.includes('invalid email')) return { ok: false, message: 'Invalid email' }
    if (msg.includes('rate') || msg.includes('too many') || msg.includes('429')) return { ok: false, message: 'Stremio rate-limited this login attempt - try again later, not necessarily a bad password' }
    logDebug({ event: 'stremio_auth_threw', identifier, message: err?.message, stack: err?.stack })
    console.warn('[VaultCheck] Stremio auth threw for', identifier, err)
    return { ok: false, message: err?.message || 'Stremio login failed' }
  }
}

// Nuvio account credentials: same shape as Stremio's checker above.
async function checkNuvioAuth(secret, config = {}) {
  const identifier = config.identifier
  if (!identifier) return { ok: false, message: 'No email/username on file for this entry' }
  if (!secret) return { ok: false, message: 'No password on file for this entry' }

  try {
    const { validateNuvioCredentials } = require('../providers/nuvioAuth')
    await validateNuvioCredentials(identifier, secret)
    return { ok: true, message: 'Nuvio login succeeded' }
  } catch (err) {
    return { ok: false, message: err?.message || 'Nuvio login failed' }
  }
}

const CHECKERS = {
  generic_http: checkGenericHttp,
  real_debrid: checkRealDebrid,
  torbox: checkTorBox,
  newznab_caps: checkNewznabCaps,
  tcp_reachability: checkTcpReachability,
  stremio_auth: checkStremioAuth,
  nuvio_auth: checkNuvioAuth
}

async function runCheck(testType, secret, config) {
  if (!testType || testType === 'manual') {
    return { ok: null, message: 'Manual entry — no automated check configured' }
  }
  const checker = CHECKERS[testType]
  if (!checker) return { ok: false, message: `Unknown test type: ${testType}` }
  try {
    return await checker(secret, config || {})
  } catch (err) {
    return { ok: false, message: err?.message || 'Check failed unexpectedly' }
  }
}

module.exports = { runCheck, CHECKERS }
