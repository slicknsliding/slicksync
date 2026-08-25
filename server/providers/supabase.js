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
// hand-copying a key out of `./nuvio credentials`.
//
// The contract is documented in the self-host repo (docs/client-configuration.md
// in github.com/NuvioMedia/self-host):
//
//   {
//     "version": 1,
//     "service": "nuvio",
//     "self_hosted": true,
//     "backend_url": "https://backend.example.com",
//     "publishable_key": "<PUBLIC_CLIENT_KEY>",
//     "capabilities": { "email_password_auth": true, "tv_login": true }
//   }
//
// backend_url/publishable_key are read first as the documented names; the
// other spellings are kept as a cheap hedge against the shape shifting, and
// a failed parse falls back to manual entry rather than failing silently.
// The publishable key is public client configuration by design - the document
// deliberately excludes service-role keys, DB passwords and dashboard creds.
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

  // Documented names first, then the hedges.
  const anonKey = pick('publishable_key', 'publishableKey', 'anon_key', 'anonKey', 'ANON_KEY', 'supabase_anon_key')
  const apiUrl = pick('backend_url', 'backendUrl', 'api_url', 'apiUrl', 'supabase_url', 'supabaseUrl', 'url') || root

  // Guards against pointing at some unrelated host that happens to answer
  // that path with JSON - better a clear "that isn't a Nuvio backend" than
  // saving a key that will fail on every sync afterwards.
  const service = pick('service')
  if (service && service.toLowerCase() !== 'nuvio') {
    return { ok: false, error: `That URL answered, but identifies itself as "${service}", not a Nuvio backend` }
  }

  if (!anonKey) {
    return { ok: false, error: 'That backend answered, but its discovery document had no publishable key - enter it manually', url: apiUrl }
  }
  return {
    ok: true,
    url: apiUrl.replace(/\/+$/, ''),
    anonKey,
    selfHosted: flat.self_hosted === true || flat.selfHosted === true,
  }
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
//
// A third behaviour on top of those two, added after a confirmed live
// incident where the first two alone weren't enough: Nuvio's backend
// started answering 429 (rate limited) rather than failing outright, and a
// FIXED cooldown turned into an endless sawtooth - open 30s, resume at full
// rate, get 429'd within seconds, open again - for hours, hammering an
// already-complaining backend the whole time. So:
//   3. Rate-limit-aware backoff - 429 is an explicit "you are going too
//      fast", not a generic error, so it trips the breaker after far fewer
//      hits, honours a Retry-After header when one is sent, and each
//      consecutive trip doubles the cooldown (30s, 60s, 2m, ... capped)
//      until calls actually start succeeding again.
const SUPABASE_TIMEOUT_MS = 15000
const MAX_CONCURRENT = 8
const FAILURE_THRESHOLD = 5
// 429 says the backend is already unhappy - two in a row is plenty.
const RATE_LIMIT_THRESHOLD = 2
const CIRCUIT_COOLDOWN_MS = 30000
const MAX_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000
// How long calls must have been healthy before the escalating cooldown is
// forgotten. Without this, a single success between two rate-limited
// windows would reset the backoff to 30s and restore the sawtooth.
const STABLE_PERIOD_MS = 5 * 60 * 1000

let activeCount = 0
const waitQueue = []
let consecutiveFailures = 0
let consecutiveRateLimits = 0
let circuitOpenUntil = 0
let circuitTrips = 0
let lastTripAt = 0

// Retry-After is seconds or an HTTP-date (RFC 9110). Both are honoured;
// anything unparseable just falls through to our own backoff.
function retryAfterMsFrom(res) {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_CIRCUIT_COOLDOWN_MS)
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), MAX_CIRCUIT_COOLDOWN_MS))
  return 0
}

// Every call site builds its failure the same way - status drives the
// breaker's rate-limit path, retryAfterMs sets a floor for the cooldown.
function providerError(res) {
  const err = new Error('Provider request failed')
  err.status = res.status
  err.retryAfterMs = retryAfterMsFrom(res)
  return err
}

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
    consecutiveRateLimits = 0
    // Only forget the escalating backoff once calls have been healthy for a
    // while - see STABLE_PERIOD_MS.
    if (circuitTrips > 0 && Date.now() - lastTripAt > STABLE_PERIOD_MS) circuitTrips = 0
    return result
  } catch (e) {
    consecutiveFailures++
    const rateLimited = e?.status === 429
    if (rateLimited) consecutiveRateLimits++

    if (consecutiveFailures >= FAILURE_THRESHOLD || consecutiveRateLimits >= RATE_LIMIT_THRESHOLD) {
      // Each consecutive trip doubles the wait, so a backend that keeps
      // saying "too fast" gets progressively more room instead of being
      // re-hammered every 30 seconds.
      const escalated = Math.min(CIRCUIT_COOLDOWN_MS * (2 ** circuitTrips), MAX_CIRCUIT_COOLDOWN_MS)
      const cooldown = Math.max(escalated, e?.retryAfterMs || 0)
      circuitOpenUntil = Date.now() + cooldown
      lastTripAt = Date.now()
      circuitTrips++
      consecutiveFailures = 0
      consecutiveRateLimits = 0
      const why = rateLimited ? 'rate limiting (429)' : `${FAILURE_THRESHOLD} consecutive failures`
      console.error(`Supabase circuit opened for ${Math.round(cooldown / 1000)}s after ${why}`)
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
      throw providerError(res)
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
      throw providerError(res)
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
      throw providerError(res)
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
      throw providerError(res)
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
