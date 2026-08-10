// SIMKL PIN (device-code) authentication - docs at api.simkl.org, but that's
// the documentation site only; the real API host (confirmed against actual
// curl examples in the docs, not just prose) is api.simkl.com.
// Simpler than Nuvio's TV login: no separate anonymous session or exchange
// step, and the poll response carries the access_token directly once
// authorized. Only a client_id is needed (no secret).
//
// clientId is deliberately a parameter on every function here, not read
// from process.env internally - resolveSimklClientId() below resolves the
// account's own Settings value first, SIMKL_CLIENT_ID only as a fallback,
// same pattern every other API key in this codebase already follows
// (TMDb/MDBList/OMDb via resolveKeyFromSettings). One app registration
// serves every user under that account by default, but an account can
// still bring its own if they don't want to depend on the instance-wide
// env var.
//
// Tokens are long-lived (5yr expiry per Simkl's docs) and simply remain
// valid until the user revokes the app from their own Connected Apps
// settings - there is no refresh flow to implement.

const { resolveKeyFromSettings } = require('./listImport')

const SIMKL_BASE = 'https://api.simkl.com'

async function resolveSimklClientId(prisma, getAccountId, req) {
  const clientId = await resolveKeyFromSettings(prisma, getAccountId, req, 'simklClientId', 'SIMKL_CLIENT_ID')
  if (!clientId) {
    const err = new Error('No SIMKL Client ID configured - add one in Settings, or set SIMKL_CLIENT_ID for the whole instance')
    err.status = 400
    throw err
  }
  return clientId
}

// accountId-direct variant for background jobs (no req/getAccountId), same
// shape as resolveOmdbKeyForAccount.
async function resolveSimklClientIdForAccount(prisma, accountId) {
  return resolveSimklClientId(prisma, () => accountId, null)
}

async function startSimklPin(clientId) {
  const res = await fetch(`${SIMKL_BASE}/oauth/pin?client_id=${encodeURIComponent(clientId)}`)
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    console.error(`SIMKL pin request failed (${res.status}): ${bodyText}`)
    throw new Error('Failed to start SIMKL authorization')
  }
  const data = await res.json()
  return {
    userCode: data.user_code,
    verificationUrl: data.verification_url || data.verification_uri,
    expiresIn: data.expires_in,
    pollIntervalSeconds: data.interval || 5,
  }
}

// Result shape: { status: 'pending' | 'authorized', accessToken? }
// Deliberately stops the caller from continuing to poll past a success -
// Simkl's own docs warn that polling again after receiving the token can
// return a newly-generated (different) code.
async function pollSimklPin(clientId, userCode) {
  const res = await fetch(`${SIMKL_BASE}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(clientId)}`)
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    console.error(`SIMKL pin poll failed (${res.status}): ${bodyText}`)
    throw new Error('Failed to poll SIMKL authorization')
  }
  const data = await res.json()
  if (data.result === 'OK' && data.access_token) {
    return { status: 'authorized', accessToken: data.access_token }
  }
  return { status: 'pending' }
}

function authHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'simkl-api-key': clientId,
  }
}

async function getSimklAccountInfo(clientId, accessToken) {
  const res = await fetch(`${SIMKL_BASE}/users/settings`, { headers: authHeaders(clientId, accessToken) })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  return data?.user?.name || data?.account?.id || null
}

module.exports = {
  resolveSimklClientId,
  resolveSimklClientIdForAccount,
  startSimklPin,
  pollSimklPin,
  authHeaders,
  getSimklAccountInfo,
  SIMKL_BASE,
}
