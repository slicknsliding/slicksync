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

function headers(accessToken) {
  return {
    'apikey': SUPABASE_ANON_KEY,
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

async function supabaseGet(table, params, accessToken) {
  return withResilience(`GET ${table}`, async () => {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`
    const res = await fetch(url, { headers: headers(accessToken), signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) })
    if (!res.ok) {
      console.error(`Supabase GET ${table} failed (${res.status})`)
      const err = new Error('Provider request failed')
      err.status = res.status
      throw err
    }
    return await res.json()
  })
}

async function supabasePost(table, rows, accessToken) {
  return withResilience(`POST ${table}`, async () => {
    const url = `${SUPABASE_URL}/rest/v1/${table}`
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(accessToken),
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

async function supabaseDelete(table, params, accessToken) {
  return withResilience(`DELETE ${table}`, async () => {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: headers(accessToken),
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

async function supabaseRpc(fn, body, accessToken) {
  return withResilience(`RPC ${fn}`, async () => {
    const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(accessToken),
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

module.exports = { supabaseGet, supabasePost, supabaseDelete, supabaseRpc, SUPABASE_URL, SUPABASE_ANON_KEY }
