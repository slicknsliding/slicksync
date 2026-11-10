// Configuration constants and variables
const path = require('path');
const crypto = require('crypto');

// Instance type configuration
const INSTANCE_TYPE = process.env.INSTANCE_TYPE || process.env.INSTANCE || 'private';
if (INSTANCE_TYPE !== 'public' && INSTANCE_TYPE !== 'private') {
  throw new Error(`Invalid INSTANCE_TYPE: ${INSTANCE_TYPE}. Must be 'public' or 'private'`);
}

const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_ACCOUNT_UUID = '00000000-0000-4000-8000-000000000000';

// Private instance auth (username/password from env vars)
const PRIVATE_AUTH_USERNAME = process.env.SLICKSYNC_PRIVATE_USERNAME || null;
const PRIVATE_AUTH_PASSWORD = process.env.SLICKSYNC_PRIVATE_PASSWORD || null;
const PRIVATE_AUTH_ENABLED = INSTANCE_TYPE !== 'public' && PRIVATE_AUTH_USERNAME && PRIVATE_AUTH_PASSWORD;

// OIDC/SSO - single provider, operator-configured via env vars (the
// self-hosted-homelab pattern: Authentik/Authelia/Keycloak/Google/etc. in
// front of this app). Sits ALONGSIDE the password login above, never
// replaces it - see server/utils/oidc.js for the full flow. All four of
// these must be set for the "Continue with SSO" button to appear at all.
const OIDC_ISSUER = (process.env.OIDC_ISSUER || '').trim() || null;
const OIDC_CLIENT_ID = (process.env.OIDC_CLIENT_ID || '').trim() || null;
const OIDC_CLIENT_SECRET = (process.env.OIDC_CLIENT_SECRET || '').trim() || null;
const OIDC_REDIRECT_URI = (process.env.OIDC_REDIRECT_URI || '').trim() || null;
const OIDC_SCOPES = (process.env.OIDC_SCOPES || 'openid profile email').trim();
const OIDC_DISPLAY_NAME = (process.env.OIDC_DISPLAY_NAME || 'SSO').trim();
// Optional extra gate for private mode specifically - without it, ANY
// identity your OIDC provider successfully authenticates can sign into the
// single private-mode admin account, same trust boundary as putting this
// app behind an SSO-enforcing reverse proxy. Set to restrict to specific
// verified emails from the provider's own userinfo response.
const OIDC_ALLOWED_EMAILS = (process.env.OIDC_ALLOWED_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const OIDC_ENABLED = !!(OIDC_ISSUER && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET && OIDC_REDIRECT_URI);

// Default Stremio addons that should be ignored in sync checks
const defaultAddons = {
  names: [
    'Cinemeta',
    'Local Files'
  ],
  ids: [
    'com.linvo.cinemeta',
    'org.stremio.local'
  ],
  manifestUrls: [
    'http://127.0.0.1:11470/local-addon/manifest.json',
    'https://v3-cinemeta.strem.io/manifest.json'
  ]
};

// Backup configuration
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup');
const BACKUP_CFG = path.join(BACKUP_DIR, 'schedule.json');

// Encryption key — auto-generated and persisted if unset, with decrypt fallback
// support if the env key changes later. See utils/keyManager.js.
const { ENCRYPTION_KEY, ENCRYPTION_KEY_FALLBACKS } = require('./keyManager');

// What sessions are signed with. This is the ONE place that decides; every
// signer and verifier takes it from here (utils/auth.js reads it lazily, and
// index.js hands it to the routers that sign their own tokens).
//
// The placeholder below used to be the fallback when JWT_SECRET was unset. It
// is public in the source repository, so signing with it lets anyone mint a
// session for any account (or the superadmin panel) on an install that never
// set its own. An install without a usable JWT_SECRET now gets one derived
// from its own ENCRYPTION_KEY instead: stable across restarts, different on
// every install. An install that sets its own JWT_SECRET is untouched, so the
// sessions it has issued stay valid.
const PUBLIC_PLACEHOLDER_SECRET = 'slicksync-dev-secret-change-me';

function resolveJwtSecret({ envSecret, encryptionKey }) {
  const own = typeof envSecret === 'string' ? envSecret : '';
  const trimmed = own.trim();
  if (trimmed && trimmed !== PUBLIC_PLACEHOLDER_SECRET) return { secret: own, source: 'env' };
  const why = trimmed ? 'placeholder' : 'unset';
  if (Buffer.isBuffer(encryptionKey) && encryptionKey.length > 0) {
    const secret = crypto.createHmac('sha256', encryptionKey).update('slicksync-jwt-secret-v1').digest('hex');
    return { secret, source: 'derived', why };
  }
  // No key to derive from at all - this run only, so nothing guessable is
  // ever used. Sessions do not survive a restart in this case.
  return { secret: crypto.randomBytes(48).toString('hex'), source: 'random', why };
}

const jwtSecretChoice = resolveJwtSecret({ envSecret: process.env.JWT_SECRET, encryptionKey: ENCRYPTION_KEY });
const JWT_SECRET = jwtSecretChoice.secret;
if (jwtSecretChoice.source === 'derived') {
  console.log(
    `[auth] JWT_SECRET is ${jwtSecretChoice.why === 'unset' ? 'not set' : 'still the placeholder from the source code'} - ` +
    "signing sessions with a key derived from this install's ENCRYPTION_KEY. Set JWT_SECRET to choose your own; " +
    'changing ENCRYPTION_KEY signs everyone out.'
  );
} else if (jwtSecretChoice.source === 'random') {
  console.warn(
    '[auth] JWT_SECRET is not set and there is no encryption key to derive one from - signing sessions with a ' +
    'random key for this run only. Everyone is signed out on restart; set JWT_SECRET to keep sessions.'
  );
}

// CORS allowed origins
// Allow localhost on any port for development (more permissive for local dev)
// In production, this should be restricted to specific domains
// Only asked for explicitly: an install with NODE_ENV unset (the usual case in
// Docker) is not a development machine, and credentialed CORS for every
// localhost port would let any local web app talk to it as the signed-in person.
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true'
const allowedOrigins = isDevelopment
  ? [
      /^http:\/\/localhost:\d+$/,  // Allow any localhost port in dev
      /^http:\/\/127\.0\.0\.1:\d+$/,  // Allow any 127.0.0.1 port in dev
    ]
  : [
      /^http:\/\/localhost:300\d$/,  // Only specific ports in production
      /^http:\/\/127\.0\.0\.1:300\d$/,
    ];

// Quiet mode
const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1';
const DEBUG_ENABLED = process.env.NEXT_PUBLIC_DEBUG === 'true' || process.env.NEXT_PUBLIC_DEBUG === '1';

// Port
const PORT = process.env.PORT || 4000;

module.exports = {
  INSTANCE_TYPE,
  PRIVATE_AUTH_ENABLED,
  PRIVATE_AUTH_USERNAME,
  PRIVATE_AUTH_PASSWORD,
  OIDC_ENABLED,
  OIDC_ISSUER,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_REDIRECT_URI,
  OIDC_SCOPES,
  OIDC_DISPLAY_NAME,
  OIDC_ALLOWED_EMAILS,
  JWT_SECRET,
  resolveJwtSecret,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_UUID,
  defaultAddons,
  BACKUP_DIR,
  BACKUP_CFG,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_FALLBACKS,
  allowedOrigins,
  QUIET,
  DEBUG_ENABLED,
  PORT
};

