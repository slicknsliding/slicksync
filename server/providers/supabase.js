/**
 * Low-level Supabase PostgREST HTTP client.
 * All Nuvio API calls go through these functions.
 */

// Nuvio's backend, fronted by their own custom domain (api.nuvio.tv) rather than
// the raw Supabase project URL. Confirmed current as of the AIOManager reference
// implementation (github.com/Sonicx161/AIOManager, beta branch) — the previous
// default here pointed at a raw *.supabase.co URL that no longer authenticates.
const SUPABASE_URL = process.env.NUVIO_SUPABASE_URL || 'https://api.nuvio.tv'
const SUPABASE_ANON_KEY = process.env.NUVIO_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI'

// Every request below takes an optional serverConfig so an account can point
// Nuvio at its own self-hosted backend instead of api.nuvio.tv. Falls back to
// the env vars, then to the public defaults - so an instance that sets
// nothing behaves exactly as before, and the parameter being optional means
// existing call sites didn't have to change.
//
// This is what brings Nuvio in line with every other integration here
// (TMDb/OMDb/MDBList/RPDB/SIMKL): the account's own setting wins, the env var
// is only a fallback. Nuvio's backend was the one that never got that.
function resolveConfig(serverConfig) {
  const url = (serverConfig?.url || '').trim() || SUPABASE_URL
  const anonKey = (serverConfig?.anonKey || '').trim() || SUPABASE_ANON_KEY
  // Trailing slashes would produce `//rest/v1/...` on a custom URL.
  return { url: url.replace(/\/+$/, ''), anonKey }
}

// Reads the per-account override out of AppAccount.sync, the same JSON blob
// the other per-account keys live in - so no schema change is needed. Both
// fields must be set to take effect: a URL without its matching anon key
// would authenticate against the wrong backend and fail confusingly, so a
// half-filled override is ignored rather than half-applied.
async function resolveServerConfigForAccount(prisma, accountId) {
  try {
    const acc = await prisma?.appAccount?.findUnique({
      where: { id: accountId || 'default' },
      select: { sync: true }
    })
    let cfg = acc?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (!cfg || typeof cfg !== 'object') return null
    const url = typeof cfg.nuvioServerUrl === 'string' ? cfg.nuvioServerUrl.trim() : ''
    const anonKey = typeof cfg.nuvioAnonKey === 'string' ? cfg.nuvioAnonKey.trim() : ''
    if (!url || !anonKey) return null
    return { url, anonKey }
  } catch {
    return null
  }
}

// Nuvio's self-host stack publishes a discovery document so a client can be
// pointed at one Backend URL and configure itself, rather than the operator
// hand-copying an anon key out of `./nuvio credentials`.
// (github.com/NuvioMedia/self-host).
//
// Written defensively on purpose: the exact field names couldn't be verified
// against a live self-hosted instance, so this accepts the plausible spellings
// rather than betting on one and silently failing. If none match, the caller
// falls back to asking for the key manually - which always works.
async function discoverNuvioBackend(baseUrl) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!root) return { ok: false, error: 'No backend URL given' }
  if (!/^https?:\/\//i.test(root)) return { ok: false, error: 'URL must start with http:// or https://' }

  let res
  try {
    res = await fetch(`${root}/.well-known/nuvio`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' ? 'Timed out reaching that URL' : 'Could not reach that URL' }
  }
  if (!res.ok) return { ok: false, error: `Discovery endpoint returned ${res.status}` }

  let doc
  try { doc = await res.json() } catch { return { ok: false, error: 'Discovery endpoint did not return JSON' } }

  // Flatten one level so a nested { supabase: { anon_key } } shape works too.
  const flat = { ...doc }
  for (const v of Object.values(doc || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(flat, v)
  }
  const pick = (...names) => {
    for (const n of names) {
      const val = flat[n]
      if (typeof val === 'string' && val.trim()) return val.trim()
    }
    return ''
  }

  const anonKey = pick('anon_key', 'anonKey', 'publishable_key', 'publishableKey', 'ANON_KEY', 'supabase_anon_key')
  const apiUrl = pick('api_url', 'apiUrl', 'supabase_url', 'supabaseUrl', 'url', 'backend_url', 'backendUrl') || root

  if (!anonKey) {
    return { ok: false, error: 'That backend answered, but its discovery document had no anon key - enter it manually', url: apiUrl }
  }
  return { ok: true, url: apiUrl.replace(/\/+$/, ''), anonKey }
}

function headers(accessToken, serverConfig) {
  return {
    'apikey': resolveConfig(serverConfig).anonKey,
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'prefer': 'return=representation'
  }
}

// --- Resilience: concurrency cap + circuit breaker for Nuvio's backend ---
// Confirmed real incident: Nuvio's own Supabase backend degraded (429s
// escalating to 504/524 gateway timeouts), and with no timeout and no
// concurrency limit, requests from the once-a-minute sync poller (one per
// connected Nuvio user) piled up faster than they could ever clear,
// eventually starving the whole Node process - including its own internal
// proxy for completely unrelated requests like /api/users. A single
// external dependency going down should never be able to take unrelated
// features (Stremio, the admin panel's own basic endpoints) down with it.
// Two layers, both shared across every call below since they all hit the
// same backend:
//   1. Concurrency cap - bounds how many Nuvio requests can be in flight at
//      once, no matter how many users/poll cycles want one right now. Caps
//      worst-case resource usage regardless of how bad or long the outage is.
//   2. Circuit breaker - once several calls in a row have failed, stop even
//      attempting new ones for a cooldown window instead of continuing to
//      queue against a backend that's clearly down. Fails instantly during
//      the cooldown (no network attempt, no timeout wait), and gives
//      Nuvio's own backend room to recover instead of adding to its load.
const SUPABASE_TIMEOUT_MS = 15000
const MAX_CONCURRENT = 8
const FAILURE_THRESHOLD = 5
const CIRCUIT_COOLDOWN_MS = 30000

let activeCount = 0
const waitQueue = []
let consecutiveFailures = 0
let circuitOpenUntil = 0

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++
    return Promise.resolve()
  }
  return new Promise((resolve) => waitQueue.push(resolve))
}

// Hands the freed slot directly to the next waiter rather than
// decrementing-then-incrementing, so activeCount never dips below what's
// actually in flight the moment a waiter is ready to run.
function releaseSlot() {
  const next = waitQueue.shift()
  if (next) next()
  else activeCount--
}

async function withResilience(label, fn) {
  if (Date.now() < circuitOpenUntil) {
    console.error(`Supabase call skipped, circuit open (${label})`)
    const err = new Error('Nuvio backend unavailable - too many recent failures')
    err.status = 503
    throw err
  }
  await acquireSlot()
  try {
    const result = await fn()
    consecutiveFailures = 0
    return result
  } catch (e) {
    consecutiveFailures++
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS
      consecutiveFailures = 0
      console.error(`Supabase circuit opened for ${CIRCUIT_COOLDOWN_MS / 1000}s after ${FAILURE_THRESHOLD} consecutive failures`)
    }
    throw e
  } finally {
    releaseSlot()
  }
}

async function supabaseGet(table, params, accessToken, serverConfig) {
  return withResilience(`GET ${table}`, async () => {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const url = `${resolveConfig(serverConfig).url}/rest/v1/${table}?${query}`
    const res = await fetch(url, { headers: headers(accessToken, serverConfig), signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) })
    if (!res.ok) {
      console.error(`Supabase GET ${table} failed (${res.status})`)
      const err = new Error('Provider request failed')
      err.status = res.status
      throw err
    }
    return await res.json()
  })
}

async function supabasePost(table, rows, accessToken, serverConfig) {
  return withResilience(`POST ${table}`, async () => {
    const url = `${resolveConfig(serverConfig).url}/rest/v1/${table}`
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(accessToken, serverConfig),
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS)
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`Supabase POST ${table} failed (${res.status}): ${bodyText}`)
      const err = new Error('Provider request failed')
      err.status = res.status
      throw err
    }
    return await res.json()
  })
}

async function supabaseDelete(table, params, accessToken, serverConfig) {
  return withResilience(`DELETE ${table}`, async () => {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const url = `${resolveConfig(serverConfig).url}/rest/v1/${table}?${query}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: headers(accessToken, serverConfig),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS)
    })
    if (!res.ok) {
      console.error(`Supabase DELETE ${table} failed (${res.status})`)
      const err = new Error('Provider request failed')
      err.status = res.status
      throw err
    }
  })
}

async function supabaseRpc(fn, body, accessToken, serverConfig) {
  return withResilience(`RPC ${fn}`, async () => {
    const url = `${resolveConfig(serverConfig).url}/rest/v1/rpc/${fn}`
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(accessToken, serverConfig),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS)
    })
    if (!res.ok) {
      console.error(`Supabase RPC ${fn} failed (${res.status})`)
      const err = new Error('Provider request failed')
      err.status = res.status
      throw err
    }
    // A write-only RPC (e.g. sync_push_collections) can legitimately return
    // a 2xx with an empty body - blindly calling .json() on that throws
    // "Unexpected end of JSON input" and makes a successful write look like
    // a failure. Only parse when there's actually a body to parse.
    const text = await res.text()
    return text ? JSON.parse(text) : null
  })
}

module.exports = {
  supabaseGet,
  supabasePost,
  supabaseDelete,
  supabaseRpc,
  resolveConfig,
  resolveServerConfigForAccount,
  discoverNuvioBackend,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
}
