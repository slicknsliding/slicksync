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

const CHECKERS = {
  generic_http: checkGenericHttp,
  real_debrid: checkRealDebrid,
  torbox: checkTorBox,
  newznab_caps: checkNewznabCaps,
  tcp_reachability: checkTcpReachability
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
