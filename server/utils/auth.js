// Authentication and security functions
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'slicksync-dev-secret-change-me';

/**
 * Check if path is allowlisted for public access
 */
function pathIsAllowlisted(path) {
  const AUTH_ALLOWLIST = [
    '/health',
    '/api/health',
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/generate-uuid',
    // NOT a bare '/api/public-auth' prefix - that used to sit here and,
    // since this function matches by startsWith, silently allowlisted every
    // OTHER route on this same router too ('/me', '/logout', '/config-export',
    // '/reset', '/account', ...), skipping req.appAccountId assignment for
    // all of them. That broke "stay signed in after register/login" - the
    // dashboard's own /me call came back with no account id and the client
    // treated it as logged out. Every actually-public sub-path needs its own
    // explicit entry here, same as the '/api/auth/*' ones below.
    '/api/public-auth/login',
    '/api/public-auth/register',
    '/api/public-auth/generate-uuid',
    '/api/public-auth/stremio-login',
    '/api/public-auth/nuvio-start-oauth',
    '/api/public-auth/nuvio-poll-oauth',
    '/api/public-auth/nuvio-login',
    '/api/auth/stremio-login',
    '/api/auth/nuvio-start-oauth',
    '/api/auth/nuvio-poll-oauth',
    '/api/auth/nuvio-login',
    '/api/public-auth/private-login', // Private instance username/password login
    '/api/auth/private-login', // Private instance username/password login (alt path)
    // Passkey sign-in: the whole point is that no session exists yet. Only
    // these two - registering a passkey stays behind a session, so nobody
    // can add one without already being signed in.
    '/api/public-auth/passkey/options',
    '/api/public-auth/passkey/verify',
    '/api/auth/passkey/options',
    '/api/auth/passkey/verify',
    '/api/public-auth/verify-2fa', // Completes a login paused by the 2FA gate - no session cookie exists yet at this point
    '/api/auth/verify-2fa',
    '/api/public-auth/oidc/config', // Tells the login page whether to show a "Continue with SSO" button - no auth required to ask
    '/api/auth/oidc/config',
    '/api/public-auth/oidc/start', // Browser navigation to the OIDC provider's own login page - no session cookie exists yet
    '/api/auth/oidc/start',
    '/api/public-auth/oidc/callback', // Where the OIDC provider redirects back to - no session cookie exists yet
    '/api/auth/oidc/callback',
    '/api/public-auth/suggest-uuid',
    '/api/qr', // QR-code rendering for TV Mode's Stremio/Nuvio OAuth linking - needed on the pre-login page too, and never carries anything sensitive (just re-renders a URL already shown/clickable elsewhere)
    '/api/ext', // External API uses API key auth (handled by externalApi router)
    // Cross-instance catalog subscription: the caller is another SlickSync
    // server, so there is no session to present. The catalog's own
    // federationToken authorizes the read and the router verifies it on every
    // request. Scoped to '/catalog/' rather than a bare '/api/federation'
    // prefix - this list matches by startsWith, and a bare prefix would
    // allowlist any future publish/revoke routes added to the same router,
    // which is exactly the mistake documented on '/api/public-auth' above.
    '/api/federation/catalog/',
    // Addon proxy - the caller is a Stremio app with no session; the UUID in
    // the URL is the credential and proxy.js resolves it on every request.
    // This entry was MISSING while the feature shipped: on any instance with
    // auth enabled (slicksync.vip confirmed live), /proxy/<uuid>/manifest.json
    // returned 401 to Stremio's fetches, so the proxied URL never worked
    // outside auth-disabled dev setups. Trailing slash keeps it narrow.
    '/proxy/',
    // SlickTrax Addon - same model exactly: per-user token in the URL,
    // resolved by traxAddon.js on every request, Stremio apps as callers.
    '/trax/',
    // One-code migration: the receiving instance pulls the bundle
    // server-to-server with no session; the single-use 15-minute token in
    // the query is the credential (see routes/migration.js). Narrow path -
    // offer/receive stay behind normal auth.
    '/api/migration/bundle',
    '/invite', // Public invitation endpoints (request submission, status check, OAuth completion)
    '/api/public-library', // Public library endpoints (OAuth-based access)
    // /api/superadmin runs its OWN completely separate auth (a distinct
    // sfm_superadmin cookie, never an account JWT - see superadmin.js) -
    // allowlisted here only so a request with no account cookie at all (the
    // normal case: an operator never logs into any tenant account) reaches
    // that check instead of being 401'd by this generic gate first. Every
    // route under this prefix enforces its own requireSuperAdmin regardless
    // of what happens here.
    '/api/superadmin',
    // Stremio helpers are NOT allowlisted; require auth
    // Note: addons endpoints are NOT allowlisted; they require auth/CSRF
  ];
  return AUTH_ALLOWLIST.some((prefix) => path.startsWith(prefix));
}

/**
 * Extract bearer token from request headers
 */
function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

/**
 * Parse cookies from request headers
 */
function parseCookies(req) {
  try {
    const raw = req.headers && req.headers.cookie;
    if (!raw) return {};
    const map = Object.create(null);
    raw.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      map[k] = v;
    });
    return map;
  } catch {
    return {};
  }
}

/**
 * Generate cookie name based on environment
 */
function cookieName(base) {
  const isProdEnv = String(process.env.NODE_ENV) === 'production';
  return isProdEnv ? `__Host-${base}` : base;
}

/**
 * Issue access token
 */
function issueAccessToken(appAccountId) {
  return jwt.sign({ accId: appAccountId, typ: 'access' }, JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Issue refresh token
 */
function issueRefreshToken(appAccountId) {
  return jwt.sign({ accId: appAccountId, typ: 'refresh' }, JWT_SECRET, { expiresIn: '365d' });
}

/**
 * Issue public token (kept for compatibility)
 */
function issuePublicToken(appAccountId) {
  return jwt.sign({ accId: appAccountId }, JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Generate random CSRF token
 */
function randomCsrfToken() {
  try { 
    return crypto.randomUUID(); 
  } catch { 
    return Math.random().toString(36).slice(2); 
  }
}

module.exports = {
  pathIsAllowlisted,
  extractBearerToken,
  parseCookies,
  cookieName,
  issueAccessToken,
  issueRefreshToken,
  issuePublicToken,
  randomCsrfToken
}
