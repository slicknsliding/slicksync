// Authentication and security functions
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// The signing secret has one home, utils/config.js. It is read when a token is
// signed or checked, not when this file loads: config.js brings in the key
// manager, which writes data/server_secret.key on a fresh install, and this
// file is also loaded by code that only wants the path matcher below.
function jwtSecret() {
  return require('./config').JWT_SECRET;
}

/**
 * Check if path is allowlisted for public access
 *
 * An entry that ends in '-' or '/' is a deliberate open-ended prefix
 * ('/proxy/', '/api/auth/jellyfin-'). Any other entry matches that path and
 * what sits below it ('/api/ext', '/api/ext/account'), but never a sibling
 * that only starts the same way ('/api/auth/login-reset', '/invitexyz') - so
 * a route added later with a similar name is not opened by accident.
 */
function pathIsAllowlisted(path) {
  const AUTH_ALLOWLIST = [
    '/health',
    // Only the build stamp - open tabs check it to notice an update, signed in
    // or not. The rest of /api/health is the admin Health page; the bare
    // '/api/health' is matched on its own, exactly, below.
    '/api/health/build',
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/generate-uuid',
    // NOT a bare '/api/public-auth' prefix - that used to sit here and,
    // since an entry covers everything under it, silently allowlisted every
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
    // Signing in with a Jellyfin-compatible server: checking the address,
    // Quick Connect and the sign-in itself (publicAuth.js). Every route with
    // this prefix is one of those four.
    '/api/public-auth/jellyfin-',
    '/api/auth/jellyfin-',
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
    // Playback links in proxied stream responses (routes/streamProxy.js): the
    // caller is a Stremio or Nuvio app with no session, and the encrypted
    // token in the URL is the credential - same model as '/proxy/' above.
    // Trailing slash keeps it narrow.
    '/stream/',
    // The shareable "my stats" page (client/app/(public)/u/[slug]): a visitor
    // has no session by design, and the unguessable slug in the URL is the
    // credential (routes/users.js). Only this one read - the rest of
    // /api/users stays behind a login, so no bare '/api/users'.
    '/api/users/public-stats/',
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
  if (typeof path !== 'string') return false;
  // Bare /api/health stays reachable for health checks people already point
  // at it - without a login it answers only "ok" (routes/health.js). Exact
  // match: /api/health/proxy-ignore and anything else under it stay gated.
  if (path === '/api/health' || path === '/api/health/') return true;
  // One trailing slash names the same route to Express ('/api/auth/login/'),
  // so it must not be what makes a login path look unlisted.
  const trimmed = trimTrailingSlash(path);
  return AUTH_ALLOWLIST.some((entry) => {
    if (entry.endsWith('-') || entry.endsWith('/')) return path.startsWith(entry);
    return trimmed === entry || trimmed.startsWith(entry + '/');
  });
}

function trimTrailingSlash(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Paths that are open without a login but hand back an account's own data
 * when a session comes with the request. For these the account behind the
 * session has to still exist and be switched on. The sign-in paths are
 * deliberately not here: a disabled household's stale cookie must never stop
 * anyone signing in as someone else from the same browser.
 */
function pathNeedsLiveAccount(path) {
  if (typeof path !== 'string') return false;
  const trimmed = trimTrailingSlash(path);
  return trimmed === '/api/health' || trimmed === '/api/ext' || trimmed.startsWith('/api/ext/');
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
  return jwt.sign({ accId: appAccountId, typ: 'access' }, jwtSecret(), { expiresIn: '30d' });
}

/**
 * Issue refresh token
 */
function issueRefreshToken(appAccountId) {
  return jwt.sign({ accId: appAccountId, typ: 'refresh' }, jwtSecret(), { expiresIn: '365d' });
}

/**
 * Accept an already-verified token payload as an account token of one of the
 * given kinds ('access', 'refresh'); throws otherwise. The same secret also
 * signs the superadmin session and the user-portal sessions, and neither of
 * those may ever pass for an account - they carry no accId, or a different
 * typ. Tokens from before the type claim existed carry none and stay valid
 * in either slot, as they always did.
 */
function checkAccountClaims(decoded, kinds = ['access', 'refresh']) {
  if (!decoded || typeof decoded !== 'object') throw new Error('not an account token');
  if (typeof decoded.accId !== 'string' || !decoded.accId) throw new Error('not an account token');
  if (decoded.typ !== undefined && !kinds.includes(decoded.typ)) throw new Error('wrong token type');
  return decoded;
}

/**
 * Verify a session token and return its payload, or throw. `kinds` is which
 * account token types the slot it came from accepts: ['access'] for the
 * bearer header and the access cookie, ['refresh'] for the refresh cookie,
 * both where the code takes whichever cookie is left. `secret` is for callers
 * that were handed one.
 */
function verifyAccountToken(token, kinds = ['access', 'refresh'], secret = jwtSecret()) {
  return checkAccountClaims(jwt.verify(token, secret), kinds);
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

// The password a private instance's default account is seeded with. Sign-in
// there goes through the operator login, SSO or a passkey, not through this
// password, so unless the operator chose one (PRIVATE_ACCOUNT_PASSWORD) it is
// random and nobody ever knows it. It used to be the fixed word below, which
// anyone could try against the (public) default uuid.
const LEGACY_DEFAULT_PASSWORD = 'private-mode';
function defaultAccountPassword() {
  return process.env.PRIVATE_ACCOUNT_PASSWORD || crypto.randomBytes(32).toString('hex');
}

// For an existing default account: a fresh hash when the stored one still
// opens with the old well-known password (and the operator has not chosen a
// password of their own), otherwise null. Run at boot so installs seeded
// before the password became random stop accepting it.
async function replaceLegacyDefaultHash(storedHash) {
  if (!storedHash || process.env.PRIVATE_ACCOUNT_PASSWORD) return null;
  const bcrypt = require('bcryptjs');
  if (!(await bcrypt.compare(LEGACY_DEFAULT_PASSWORD, storedHash))) return null;
  return bcrypt.hash(defaultAccountPassword(), 12);
}

module.exports = {
  pathIsAllowlisted,
  pathNeedsLiveAccount,
  extractBearerToken,
  parseCookies,
  cookieName,
  issueAccessToken,
  issueRefreshToken,
  checkAccountClaims,
  verifyAccountToken,
  randomCsrfToken,
  defaultAccountPassword,
  LEGACY_DEFAULT_PASSWORD,
  replaceLegacyDefaultHash
}
