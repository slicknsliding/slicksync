// Configuration constants and variables
const path = require('path');

// Instance type configuration
const INSTANCE_TYPE = process.env.INSTANCE_TYPE || process.env.INSTANCE || 'private';
if (INSTANCE_TYPE !== 'public' && INSTANCE_TYPE !== 'private') {
  throw new Error(`Invalid INSTANCE_TYPE: ${INSTANCE_TYPE}. Must be 'public' or 'private'`);
}

const JWT_SECRET = process.env.JWT_SECRET || 'slicksync-dev-secret-change-me';
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_ACCOUNT_UUID = '00000000-0000-4000-8000-000000000000';

// Private instance auth (username/password from env vars)
const PRIVATE_AUTH_USERNAME = process.env.SLICKSYNC_PRIVATE_USERNAME || null;
const PRIVATE_AUTH_PASSWORD = process.env.SLICKSYNC_PRIVATE_PASSWORD || null;
const PRIVATE_AUTH_ENABLED = INSTANCE_TYPE !== 'public' && PRIVATE_AUTH_USERNAME && PRIVATE_AUTH_PASSWORD;

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

// Auth allowlist for public endpoints
const AUTH_ALLOWLIST = [
  '/health',
  '/api/health',
  '/api/public-auth/login',
  '/api/public-auth/register',
  '/api/public-auth/generate-uuid',
  '/api/public-auth/suggest-uuid',
  '/api/public-auth/private-login', // Private instance username/password login
  '/invite', // Public invitation endpoints (request submission, status check, OAuth completion)
  '/proxy', // Addon proxy routes (UUID serves as bearer token)
  // Stremio endpoints require auth now (no allowlist)
];

// Backup configuration
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup');
const BACKUP_CFG = path.join(BACKUP_DIR, 'schedule.json');

// Encryption/hashing pepper
const PEPPER = process.env.HASH_PEPPER || process.env.ENCRYPTION_KEY || 'slicksync-pepper';

// Encryption key — auto-generated and persisted if unset, with decrypt fallback
// support if the env key changes later. See utils/keyManager.js.
const { ENCRYPTION_KEY, ENCRYPTION_KEY_FALLBACKS } = require('./keyManager');

// CORS allowed origins
// Allow localhost on any port for development (more permissive for local dev)
// In production, this should be restricted to specific domains
const isDevelopment = process.env.NODE_ENV !== 'production' || process.env.DEBUG === 'true'
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
  JWT_SECRET,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_UUID,
  defaultAddons,
  AUTH_ALLOWLIST,
  BACKUP_DIR,
  BACKUP_CFG,
  PEPPER,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_FALLBACKS,
  allowedOrigins,
  QUIET,
  DEBUG_ENABLED,
  PORT
};

