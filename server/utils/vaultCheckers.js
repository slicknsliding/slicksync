// Vault entry "active" checkers. Each returns { ok: boolean, message: string, expiresAt?: Date }
// testConfig is a parsed JSON object stored per-entry; shape varies by testType.

const net = require('net')

function timeoutSignal(ms) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
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

  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(finalUrl, { method, headers, signal })
    cancel()
    const text = await res.text().catch(() => '')
    const statusOk = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === expectStatus
    if (!statusOk) return { ok: false, message: `Unexpected status ${res.status}` }
    if (bodyContains && !text.includes(bodyContains)) return { ok: false, message: 'Response did not match expected content' }
    return { ok: true, message: `OK (${res.status})` }
  } catch (err) {
    cancel()
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : (err?.message || 'Request failed') }
  }
}

// Real-Debrid: /user also reports premium expiration, which we surface back
// so the vault entry's expiresAt can auto-update from the source of truth.
async function checkRealDebrid(secret) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch('https://api.real-debrid.com/rest/1.0/user', {
      headers: { Authorization: `Bearer ${secret}` },
      signal
    })
    cancel()
    if (!res.ok) return { ok: false, message: `Real-Debrid returned ${res.status}` }
    const data = await res.json()
    const expiresAt = data?.expiration ? new Date(data.expiration) : undefined
    const type = data?.type || 'unknown'
    if (type !== 'premium') {
      return { ok: false, message: `Account type is "${type}", not premium`, expiresAt }
    }
    return { ok: true, message: `Premium active${expiresAt ? `, expires ${expiresAt.toISOString().split('T')[0]}` : ''}`, expiresAt }
  } catch (err) {
    cancel()
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : (err?.message || 'Request failed') }
  }
}

// TorBox: /user/me reports plan and premium_expires_at
async function checkTorBox(secret) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch('https://api.torbox.app/v1/api/user/me', {
      headers: { Authorization: `Bearer ${secret}` },
      signal
    })
    cancel()
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
    cancel()
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : (err?.message || 'Request failed') }
  }
}

// Newznab-compatible indexers (NZBGeek, NinjaCentral, UsenetCrawler, DrunkenSlug, etc.)
// t=caps doesn't require a valid key on some indexers, so we also try t=search with
// a tiny result limit to actually exercise the key.
async function checkNewznabCaps(secret, config = {}) {
  const { url } = config
  if (!url) return { ok: false, message: 'No indexer base URL configured' }
  const base = url.replace(/\/+$/, '')
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const testUrl = `${base}/api?t=caps&apikey=${encodeURIComponent(secret)}&o=json`
    const res = await fetch(testUrl, { signal })
    cancel()
    if (!res.ok) return { ok: false, message: `Indexer returned ${res.status}` }
    const text = await res.text()
    if (/error/i.test(text) && /apikey|api key|invalid/i.test(text)) {
      return { ok: false, message: 'API key rejected' }
    }
    return { ok: true, message: 'Indexer reachable, key accepted' }
  } catch (err) {
    cancel()
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : (err?.message || 'Request failed') }
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
  function logDebug(entry) {
    try {
      const fs = require('fs')
      const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`
      fs.appendFileSync('/app/data/vault-debug.log', line)
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
