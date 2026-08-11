// Generic OIDC/SSO login - Authorization Code + PKCE against a single,
// operator-configured provider (Authentik/Authelia/Keycloak/Google/etc.).
// Sits alongside the existing password logins (env-var private-login,
// UUID+password public-login), never replaces them.
//
// Trust boundary / known simplification: after exchanging the code at the
// provider's token_endpoint, this does NOT independently verify the
// id_token's signature against the provider's JWKS. That exchange is
// already a confidential, client-secret-authenticated, direct HTTPS call to
// the provider (not something a third party can intercept or forge into),
// so the response is trusted the same way a typical "confidential client,
// authorization code flow" integration does - iss/aud/exp are still
// sanity-checked, and the actual profile data used (email/name/sub) comes
// from the userinfo_endpoint, called with the freshly-issued access token
// on that same trusted channel. Add JWKS-based id_token signature
// verification (e.g. via jwks-rsa) if this needs to satisfy a stricter
// compliance bar than "trust the direct token endpoint response."
//
// Pending-authorization state (PKCE verifier + where to redirect after) is
// an in-memory, one-shot Map keyed by `state`, same pattern as
// server/utils/twoFactor.js's pending 2FA challenges.
const crypto = require('crypto')
const {
  OIDC_ENABLED, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI,
  OIDC_SCOPES, OIDC_DISPLAY_NAME, OIDC_ALLOWED_EMAILS,
} = require('./config')

const pendingStore = new Map() // state -> { codeVerifier, expiresAt }
const PENDING_TTL_MS = 10 * 60 * 1000 // 10m - covers a slow provider-side login prompt

let discoveryCache = null // { doc, fetchedAt }
const DISCOVERY_TTL_MS = 60 * 60 * 1000 // 1h - these endpoints essentially never change

function isConfigured() {
  return OIDC_ENABLED
}

function displayName() {
  return OIDC_DISPLAY_NAME
}

async function getDiscoveryDocument() {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc
  }
  const base = OIDC_ISSUER.replace(/\/+$/, '')
  const res = await fetch(`${base}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) - check OIDC_ISSUER`)
  const doc = await res.json()
  discoveryCache = { doc, fetchedAt: Date.now() }
  return doc
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

// Returns { authorizationUrl } - caller does a real top-level redirect
// (this is a browser navigation flow, not a fetch/JSON API).
async function startAuthorization() {
  if (!isConfigured()) throw new Error('OIDC is not configured')
  const doc = await getDiscoveryDocument()
  if (!doc.authorization_endpoint) throw new Error('OIDC provider did not advertise an authorization_endpoint')

  const codeVerifier = base64url(crypto.randomBytes(32))
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const state = crypto.randomBytes(24).toString('hex')
  pendingStore.set(state, { codeVerifier, expiresAt: Date.now() + PENDING_TTL_MS })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OIDC_CLIENT_ID,
    redirect_uri: OIDC_REDIRECT_URI,
    scope: OIDC_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return { authorizationUrl: `${doc.authorization_endpoint}?${params.toString()}` }
}

// Completes the callback: exchanges the code, fetches userinfo, sanity-
// checks the id_token claims. Returns { sub, email, name } on success -
// throws on any failure (caller maps that to a login-page error redirect).
async function handleCallback(code, state) {
  if (!isConfigured()) throw new Error('OIDC is not configured')
  if (!code || !state) throw new Error('Missing code or state')

  const pending = pendingStore.get(state)
  pendingStore.delete(state) // one-shot regardless of outcome
  if (!pending) throw new Error('This sign-in attempt has expired - try again')
  if (Date.now() > pending.expiresAt) throw new Error('This sign-in attempt has expired - try again')

  const doc = await getDiscoveryDocument()
  if (!doc.token_endpoint) throw new Error('OIDC provider did not advertise a token_endpoint')

  const tokenRes = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: OIDC_REDIRECT_URI,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      code_verifier: pending.codeVerifier,
    }),
  })
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    console.error(`[OIDC] token exchange failed (${tokenRes.status}): ${body}`)
    throw new Error('Sign-in with your identity provider failed')
  }
  const tokens = await tokenRes.json()
  if (!tokens.access_token) throw new Error('OIDC provider did not return an access token')

  const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null
  if (idClaims) {
    const issuerHost = new URL(OIDC_ISSUER).host
    const claimIssuerHost = (() => { try { return new URL(idClaims.iss).host } catch { return null } })()
    if (claimIssuerHost && claimIssuerHost !== issuerHost) throw new Error('OIDC id_token issuer mismatch')
    const aud = Array.isArray(idClaims.aud) ? idClaims.aud : [idClaims.aud]
    if (!aud.includes(OIDC_CLIENT_ID)) throw new Error('OIDC id_token audience mismatch')
    if (idClaims.exp && Date.now() / 1000 > idClaims.exp) throw new Error('OIDC id_token expired')
  }

  let profile = idClaims || {}
  if (doc.userinfo_endpoint) {
    try {
      const uiRes = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      if (uiRes.ok) profile = { ...profile, ...(await uiRes.json()) }
    } catch {
      // fall back to id_token claims alone - not fatal
    }
  }

  const sub = profile.sub || idClaims?.sub
  if (!sub) throw new Error('OIDC provider did not return a subject id')
  const email = (profile.email || '').trim().toLowerCase() || null
  const name = profile.name || profile.preferred_username || null
  // Absent claim is treated as fine (not every provider sends it); only an
  // explicit `false` counts as unverified. Used to gate auto-linking an
  // OIDC identity onto an existing account purely by email match.
  const emailVerified = profile.email_verified !== false

  return { sub: String(sub), email, name, emailVerified }
}

// Private-mode extra gate - if OIDC_ALLOWED_EMAILS is set, only those
// emails may log into the single admin account this way. Unset = trust the
// provider itself as the access-control boundary (the normal
// SSO-in-front-of-a-homelab-app expectation).
function isEmailAllowedForPrivateMode(email) {
  if (OIDC_ALLOWED_EMAILS.length === 0) return true
  return !!email && OIDC_ALLOWED_EMAILS.includes(email.toLowerCase())
}

module.exports = {
  isConfigured,
  displayName,
  startAuthorization,
  handleCallback,
  isEmailAllowedForPrivateMode,
}
