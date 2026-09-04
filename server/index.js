// Restart trigger: 2026-01-29 - Refreshing backend state for library cache fixes
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
// Ensure Prisma uses the right provider at runtime
if (!process.env.PRISMA_PROVIDER) {
  // Infer from DATABASE_URL
  const dbUrl = process.env.DATABASE_URL || ''
  process.env.PRISMA_PROVIDER = dbUrl.startsWith('postgres') ? 'postgresql' : 'sqlite'
}
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StremioAPIStore, StremioAPIClient } = require('stremio-api-client');
const debug = require('./utils/debug');
require('dotenv').config();

// Import modular routers
const addonsRouter = require('./routes/addons');
const groupsRouter = require('./routes/groups');
const usersRouter = require('./routes/users');
const stremioRouter = require('./routes/stremio');
const settingsRouter = require('./routes/settings');
const externalApiRouter = require('./routes/externalApi');
const debugRouter = require('./routes/debug');
const publicAuthRouter = require('./routes/publicAuth');
const invitationsRouter = require('./routes/invitations');
const publicLibraryRouter = require('./routes/publicLibrary');
const proxyRouter = require('./routes/proxy');
const streamProxyRouter = require('./routes/streamProxy');
const nuvioRouter = require('./routes/nuvio');
const snapshotsRouter = require('./routes/snapshots');
const pushRouter = require('./routes/push');
const watchlistRouter = require('./routes/watchlist');
const avatarsRouter = require('./routes/avatars');
const vaultRouter = require('./routes/vault');
const automationRouter = require('./routes/automation');
const discoverRouter = require('./routes/discover');
const listsRouter = require('./routes/lists');
const healthRouter = require('./routes/health');
const postersRouter = require('./routes/posters');
const { makeCreateProvider } = require('./providers');

// Import configuration constants
const { INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, PRIVATE_AUTH_USERNAME, PRIVATE_AUTH_PASSWORD, JWT_SECRET, DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_UUID, defaultAddons, AUTH_ALLOWLIST, BACKUP_DIR, BACKUP_CFG, PEPPER, ENCRYPTION_KEY, allowedOrigins, QUIET, DEBUG_ENABLED, PORT } = require('./utils/config');

// Import utility modules
const { parseAddonIds, parseProtectedAddons, canonicalizeManifestUrl, normalizeUrl, isProdEnv, filterManifestByResources, filterManifestByCatalogs } = require('./utils/validation');
const { sha256Hex, hmacHex, manifestUrlHash, manifestUrlHmac, getAccountHmacKey, normalizeManifestObject, manifestHash, manifestHmac } = require('./utils/hashing');
const { validateStremioAuthKey, filterDefaultAddons, buildAddonDbData } = require('./utils/stremio');
const { pathIsAllowlisted, extractBearerToken, parseCookies, cookieName, issueAccessToken, issueRefreshToken, issuePublicToken, randomCsrfToken } = require('./utils/auth');
const { getAccountId: getAccountIdHelper, scopedWhere, assignUserToGroup } = require('./utils/helpers');
const { selectKeyForRequest, encrypt, decrypt, getAccountHmacKey: getAccountHmacKeyEnc, encryptIf, decryptIf, getDecryptedManifestUrl, decryptWithFallback } = require('./utils/encryption');

async function ensureDefaultAccount(prismaClient) {
  if (INSTANCE_TYPE === 'public') return

  const defaultPassword = process.env.PRIVATE_ACCOUNT_PASSWORD || 'private-mode'
  const existing = await prismaClient.appAccount.findUnique({ where: { id: DEFAULT_ACCOUNT_ID } })

  if (!existing) {
    const passwordHash = await bcrypt.hash(defaultPassword, 12)
    await prismaClient.appAccount.create({
      data: {
        id: DEFAULT_ACCOUNT_ID,
        uuid: DEFAULT_ACCOUNT_UUID,
        passwordHash,
        sync: JSON.stringify({ enabled: false, frequency: '0' })
      }
    })
  } else {
    const updates = {}
    if (!existing.uuid || existing.uuid !== DEFAULT_ACCOUNT_UUID) {
      updates.uuid = DEFAULT_ACCOUNT_UUID
    }
    if (!existing.sync) {
      updates.sync = JSON.stringify({ enabled: false, frequency: '0' })
    }
    if (!existing.passwordHash) {
      updates.passwordHash = await bcrypt.hash(defaultPassword, 12)
    }
    if (Object.keys(updates).length > 0) {
      await prismaClient.appAccount.update({ where: { id: DEFAULT_ACCOUNT_ID }, data: updates })
    }
  }

  // Normalize existing data to default account scope
  await Promise.all([
    prismaClient.user.updateMany({ where: { OR: [{ accountId: null }, { accountId: '' }] }, data: { accountId: DEFAULT_ACCOUNT_ID } }),
    prismaClient.group.updateMany({ where: { OR: [{ accountId: null }, { accountId: '' }] }, data: { accountId: DEFAULT_ACCOUNT_ID } }),
    prismaClient.addon.updateMany({ where: { OR: [{ accountId: null }, { accountId: '' }] }, data: { accountId: DEFAULT_ACCOUNT_ID } })
  ])

  console.log('👤 Private mode: default account ready')
}

// Optional quiet mode: suppress non-error console output when QUIET=true or DEBUG is not enabled
// QUIET and DEBUG_ENABLED are now imported from utils/config
if (QUIET || !DEBUG_ENABLED) {
  const noop = () => { }
  console.log = noop
  console.info = noop
  console.warn = noop
}

const app = express();
// PORT is now imported from utils/config
const prisma = new PrismaClient();
console.log('Prisma client initialized:', !!prisma);

// Provider factory: routes addon operations to Stremio or Nuvio based on user.providerType
const createProvider = makeCreateProvider({ prisma, encrypt, getAccountId: getAccountIdHelper });

// Trust proxy headers (for correct client IP behind reverse proxies)
// Trust exactly one hop (the Traefik reverse proxy in front of this container).
// NOTE: trust proxy = true (trust ALL hops) is intentionally avoided — it lets a
// client spoof X-Forwarded-For and bypass IP-based rate limiting entirely, and
// express-rate-limit refuses to start with that setting for exactly this reason.
app.set('trust proxy', 1);

// Use helper-provided getAccountId (account scoping rules centralized)
const getAccountId = getAccountIdHelper

// Response compression - JSON payloads (users, history, discover) shrink
// several-fold over the wire, which is most of what a phone on cell data
// ever downloads from here. The default filter already skips content types
// that are compressed by nature (the poster cache's webp/jpeg included);
// the explicit check skips SSE streams, where buffering a gzip window
// would hold events hostage instead of delivering them.
const compression = require('compression');
app.use(compression({
  filter: (req, res) => {
    if ((res.getHeader('Content-Type') || '').toString().includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// Parse JSON bodies
app.use(express.json());

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some((re) => re.test(origin))) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

// Rate limiting (disabled by default)
// Default max raised from 1000 - a household with a few open tabs plus
// several users/groups worth of SyncBadge polling could get within range of
// 1000/15min on its own even without any bug; 4000 keeps real headroom for
// legitimate multi-tab/multi-device polling while still catching genuine
// abuse. The actual incident that prompted this (site-wide 429s locking out
// Dashboard/Addons/Groups) was a real N+1 bug - see SyncBadge.tsx - not
// primarily an undersized limit, but this is cheap, real defense-in-depth
// for whatever the next chatty component turns out to be.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '4000'),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api', limiter);

// Stricter limiter for credential-handling endpoints (login/OAuth/token exchange)
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many authentication attempts from this IP, please try again later.',
});
app.use('/api/nuvio/validate', authLimiter);
app.use('/api/nuvio/connect', authLimiter);
app.use('/api/nuvio/start-oauth', authLimiter);
app.use('/api/nuvio/exchange-oauth', authLimiter);
app.use('/api/nuvio/connect-authkey', authLimiter);
// Nuvio admin login (publicAuth.js) - same shape as the /api/nuvio ones
// above, but reachable pre-auth, so it needs its own limiter mounts on both
// aliases the router is mounted under.
app.use('/api/auth/nuvio-start-oauth', authLimiter);
app.use('/api/public-auth/nuvio-start-oauth', authLimiter);
app.use('/api/auth/nuvio-login', authLimiter);
app.use('/api/public-auth/nuvio-login', authLimiter);
// UUID/password login+register and the superadmin operator login - only
// the generic 4000-req/15min-per-IP limiter covered these before, which is
// several requests a second and does nothing to slow down someone
// hammering account credentials or the single shared superadmin password
// (no MFA on that one - this limiter is its only throttle).
app.use('/api/auth/login', authLimiter);
app.use('/api/public-auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/public-auth/register', authLimiter);
app.use('/api/superadmin/login', authLimiter);
// 2FA code verification - a 6-digit TOTP is brute-forceable (1-in-a-million
// per guess, but that's nothing without a hard cap on attempts); same
// 20-req/15min throttle as the credential checks above.
app.use('/api/auth/verify-2fa', authLimiter);
app.use('/api/public-auth/verify-2fa', authLimiter);

// Higher-frequency limiter for OAuth polling (device-code flow polls every few seconds)
const pollLimiter = rateLimit({
  windowMs: 60000,
  max: parseInt(process.env.POLL_RATE_LIMIT_MAX_REQUESTS || '60'),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/nuvio/poll-oauth', pollLimiter);
app.use('/api/auth/nuvio-poll-oauth', pollLimiter);
app.use('/api/public-auth/nuvio-poll-oauth', pollLimiter);
// User-panel Nuvio login (publicLibrary.js) - same shape as the admin/
// account-level Nuvio OAuth mounts above, for the same public, pre-auth
// device-code flow.
app.use('/api/public-library/generate-oauth-nuvio', authLimiter);
app.use('/api/public-library/authenticate-nuvio', authLimiter);
app.use('/api/public-library/poll-oauth-nuvio', pollLimiter);

app.use(express.json({ limit: '10mb' }));

// Multer - use centralized configuration
const { standardUpload, imageUpload } = require('./utils/helpers');
const upload = standardUpload;

// Serve uploaded avatar images. data/avatars is the same bind-mounted volume
// as the rest of persistent data, so uploads survive container recreation.
app.use('/uploads/avatars', express.static(path.join(process.cwd(), 'data', 'avatars')));

// Encryption helpers
const { getServerKey, aesGcmEncrypt, aesGcmDecrypt, getAccountDek } = require('./utils/encryption')

// Liveness/readiness probe. Deliberately registered BEFORE the auth gate
// and kept separate from /api/health (routes/health.js), which is the
// dashboard's System Health data source - that one is account-scoped and
// queries addons, vault entries, notifications and users, which is far too
// heavy to run every 30 seconds and returns 500 rather than a meaningful
// status when the DB is unreachable.
//
// This exists because a real outage went undetected: the container's
// HEALTHCHECK probed only the frontend (port 3000), so when the backend
// process died the container kept reporting "healthy" while every API call
// failed. A probe has to touch the thing that can actually break - here,
// the backend process answering at all, plus one trivial DB round-trip.
//
// 200 = serving and the database answers. 503 = process is up but the
// database is not reachable, which is the state an orchestrator (or Docker's
// own restart policy) needs to distinguish from a hard crash. The boot log
// has always advertised this path; until now nothing served it and it 404'd.
app.get('/health', async (req, res) => {
  try {
    // Cheapest possible round-trip that proves the connection is live, and
    // works identically on SQLite and PostgreSQL.
    await prisma.$queryRaw`SELECT 1`
    res.status(200).json({ status: 'ok', database: 'up' })
  } catch (e) {
    res.status(503).json({ status: 'degraded', database: 'down', error: e?.message?.slice(0, 200) })
  }
})

// Global auth and CSRF gates via middleware factories
const { createAuthGate, createCsrfGuard } = require('./middleware/auth')
app.use(createAuthGate({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, JWT_SECRET, pathIsAllowlisted, parseCookies, cookieName, extractBearerToken, issueAccessToken, randomCsrfToken, isProdEnv, prisma }))
app.use(createCsrfGuard({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, pathIsAllowlisted, parseCookies, cookieName }))

if (INSTANCE_TYPE !== 'public' && !PRIVATE_AUTH_ENABLED) {
  app.use((req, res, next) => {
    if (!req.appAccountId) {
      req.appAccountId = DEFAULT_ACCOUNT_ID
    }
    next()
  })
}

// Per-account rate limiter, public multi-tenant mode only - private mode's
// single shared DEFAULT_ACCOUNT_ID makes this redundant with (and strictly
// worse than) the per-IP limiter above, since every request in private mode
// carries the same account id regardless of source. In public mode this
// closes a real gap the per-IP limiter can't: a registered, legitimate-
// looking account spreading requests across many IPs/devices to evade it.
// Runs after createAuthGate resolves req.appAccountId from the session
// cookie, so it's available here; keyGenerator falls back to IP for the
// handful of pre-account-resolution requests (login/register) that already
// have their own stricter authLimiter mounted above anyway.
if (INSTANCE_TYPE === 'public') {
  const accountLimiter = rateLimit({
    windowMs: parseInt(process.env.ACCOUNT_RATE_LIMIT_WINDOW_MS || '900000'),
    max: parseInt(process.env.ACCOUNT_RATE_LIMIT_MAX_REQUESTS || '6000'),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.appAccountId || ipKeyGenerator(req.ip),
    message: 'Too many requests from this account, please try again later.',
  })
  app.use('/api', accountLimiter)
}

// Account scoping middleware - ensures req.appAccountId is set before these
// routes run; the routes themselves do the actual per-query accountId
// filtering (see server/middleware/accountScoping.js for why this used to
// also swap a global Prisma reference, and why that was removed).
const { createAccountScopingMiddleware } = require('./middleware/accountScoping');
const accountScopingMiddleware = createAccountScopingMiddleware();
app.use('/api/groups', accountScopingMiddleware);
app.use('/api/users', accountScopingMiddleware);
app.use('/api/addons', accountScopingMiddleware);
app.use('/api/stremio', accountScopingMiddleware);
app.use('/api/nuvio', accountScopingMiddleware);
app.use('/api/snapshots', accountScopingMiddleware);
app.use('/api/vault', accountScopingMiddleware);
app.use('/api/automation', accountScopingMiddleware);
app.use('/api/watch-together', accountScopingMiddleware);

// Mount routers
const publicAuthRouterInstance = publicAuthRouter({ prisma, getAccountId, INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, PRIVATE_AUTH_USERNAME, PRIVATE_AUTH_PASSWORD, DEFAULT_ACCOUNT_ID, issueAccessToken, issueRefreshToken, cookieName, isProdEnv, encrypt, decrypt, getDecryptedManifestUrl, scopedWhere, getAccountDek, decryptWithFallback, manifestUrlHmac, manifestHash, filterManifestByResources, filterManifestByCatalogs, parseCookies, JWT_SECRET });
app.use('/api/auth', publicAuthRouterInstance);
app.use('/api/public-auth', publicAuthRouterInstance);
app.use('/api/addons', addonsRouter({ prisma, getAccountId, decrypt, encrypt, getDecryptedManifestUrl, scopedWhere, INSTANCE_TYPE, manifestHash, filterManifestByResources, filterManifestByCatalogs, manifestUrlHmac }));
app.use('/api/groups', groupsRouter({ prisma, getAccountId, scopedWhere, INSTANCE_TYPE, assignUserToGroup, getDecryptedManifestUrl, manifestUrlHmac, decrypt, createProvider }));
app.use('/api/users', usersRouter({ prisma, getAccountId, scopedWhere, INSTANCE_TYPE, decrypt, encrypt, parseAddonIds, parseProtectedAddons, getDecryptedManifestUrl, StremioAPIClient, StremioAPIStore, assignUserToGroup, debug, defaultAddons, canonicalizeManifestUrl, getAccountDek, getServerKey, aesGcmDecrypt, validateStremioAuthKey, manifestUrlHmac, manifestHash, createProvider }));
app.use('/api/scrobble', require('./routes/scrobble')({ prisma }));
app.use('/api/stremio', stremioRouter({ prisma, getAccountId, encrypt, decrypt, assignUserToGroup, INSTANCE_TYPE }));
app.use('/api/nuvio', nuvioRouter({ prisma, getAccountId, encrypt, decrypt }));
app.use('/api/snapshots', snapshotsRouter({ prisma, getAccountId, encrypt, decrypt, createProvider }));
app.use('/api/avatars', avatarsRouter({ imageUpload }));
app.use('/api/vault', vaultRouter({ prisma, getAccountId, encrypt, decrypt }));
app.use('/api/automation', automationRouter({ prisma, getAccountId }));
app.use('/api/watch-together', require('./routes/watchTogether')({ prisma, getAccountId }));
app.use('/api/settings', settingsRouter({ prisma, INSTANCE_TYPE, getAccountDek, getDecryptedManifestUrl, getAccountId }));
app.use('/api/push', pushRouter({ prisma, getAccountId }));
app.use('/api/watchlist', watchlistRouter({ prisma, getAccountId }));
// Discover proxies to Cinemeta on every single request (browse/search/
// people-search/cast lookups) - the one endpoint under the broad account
// limiter above where a moderate request COUNT still means real, repeated
// external-API cost per request, not just DB reads. Tighter, per-minute
// cap, same account-or-IP key.
if (INSTANCE_TYPE === 'public') {
  const discoverLimiter = rateLimit({
    windowMs: 60000,
    max: parseInt(process.env.DISCOVER_RATE_LIMIT_MAX_REQUESTS || '90'),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.appAccountId || ipKeyGenerator(req.ip),
    message: 'Too many Discover requests, please slow down.',
  })
  app.use('/api/discover', discoverLimiter)
}
app.use('/api/discover', discoverRouter({ prisma, getAccountId }));
app.use('/api/lists', listsRouter({ prisma, getAccountId, decrypt }));
app.use('/api/federation', require('./routes/federation')({ prisma }));
app.use('/api/health', healthRouter({ prisma, getAccountId, INSTANCE_TYPE }));
app.use('/api/superadmin', require('./routes/superadmin')({ prisma, JWT_SECRET, isProdEnv, cookieName, parseCookies }));
app.use('/api/poster', postersRouter({ prisma, getAccountId }));
// Resize/cache proxy for plain external poster/backdrop URLs - see the
// route's own header for how it relates to /api/poster above.
app.use('/api/img', require('./routes/imageCache')());
app.use('/api/qr', require('./routes/qr')());
// Live-update stream (SSE) - tells connected clients "refetch now" the
// moment something changes, instead of waiting out their poll interval.
// See utils/liveEvents.js for why it carries types only, never data.
app.get('/api/events', (req, res) => require('./utils/liveEvents').handleEventsRequest(req, res, getAccountId));
// Read-only browse of the public Stremio addon directory - see the route's
// own header for why this is proxied rather than fetched client-side.
app.use('/api/addon-directory', require('./routes/addonDirectory')());
// External API (API key protected, account-scoped)
app.use('/api/ext', externalApiRouter({
  prisma,
  getAccountId,
  scopedWhere,
  reloadDeps: { decrypt, encrypt, getDecryptedManifestUrl, filterManifestByResources, filterManifestByCatalogs, manifestHash },
  syncGroupUsers: require('./routes/groups')({ prisma, getAccountId, scopedWhere, INSTANCE_TYPE, assignUserToGroup, getDecryptedManifestUrl, manifestUrlHmac, decrypt, createProvider }).syncGroupUsers
}));
// Interactive docs for the /api/ext surface above (see server/utils/openapi.js
// for why only that surface, not the whole app, gets a spec). Viewing the
// docs needs no auth - same as API.md already being world-readable in the
// public repo - actually calling an endpoint from the "Try it out" panel
// still needs a real API key. helmet's default CSP blocks swagger-ui-dist's
// inline bootstrap script (a known helmet/swagger-ui-express conflict), so
// it's relaxed for this one path only.
//
// swaggerUi.serve + swaggerUi.setup() (the README's default recipe) issues
// its own internal bare-path -> trailing-slash redirect when mounted at a
// sub-path like this instead of app root - confirmed live on betatest this
// produces an infinite redirect LOOP (/api/docs -> /api/docs/ -> /api/docs
// -> ...), not just a cosmetic extra hop. serveFiles()+generateHTML() is
// swagger-ui-express's own documented alternative for exactly this
// mounted-at-a-subpath case: it serves the page directly at the exact GET
// route with no redirect involved at all.
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./utils/openapi');
app.use('/api/docs', (req, res, next) => { res.removeHeader('Content-Security-Policy'); next(); });
app.use('/api/docs', swaggerUi.serveFiles(openapiSpec, {}));
app.get('/api/docs', (req, res) => {
  res.send(swaggerUi.generateHTML(openapiSpec, { customSiteTitle: 'SlickSync API' }));
});
app.use('/api/invitations', invitationsRouter({ prisma, getAccountId, INSTANCE_TYPE, encrypt, decrypt, assignUserToGroup }));
app.use('/invite', invitationsRouter.createPublicRouter({ prisma, encrypt, assignUserToGroup, decrypt }));
// Public library router (no auth required)
const { getCachedLibrary, setCachedLibrary } = require('./utils/libraryCache');
app.use('/api/public-library', publicLibraryRouter({ prisma, DEFAULT_ACCOUNT_ID, encrypt, decrypt, getCachedLibrary, setCachedLibrary, JWT_SECRET }));

// Addon proxy router (no auth required - UUID serves as bearer token)
app.use('/proxy', proxyRouter({ prisma, decrypt, getAccountId, getServerKey }));

// SlickTrax Addon - SlickSync serving the Stremio addon protocol itself
// (per-user token in the URL is the credential; allowlisted like /proxy)
app.use('/trax', require('./routes/traxAddon')({ prisma }));

// One-code instance migration - /bundle is token-gated and allowlisted (the
// caller is the receiving server, sessionless); offer/receive live under
// /api/settings with normal auth.
app.use('/api/migration', require('./routes/migration')({ prisma, decrypt }));

// Stream proxy router (no auth required - handles encrypted stream URLs)
app.use('/stream', streamProxyRouter({ getServerKey }).router);

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ message: 'Internal server error', error: error.message });
});

// Shutdown
process.on('SIGINT', async () => { console.log('🛑 Shutting down gracefully...'); await prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('🛑 Shutting down gracefully...'); await prisma.$disconnect(); process.exit(0); });

// Initialize sync schedule on startup (works in all modes)
const { reloadGroupAddons } = require('./routes/users');

// Create a mock request object for scheduler context
const schedulerReq = {
  appAccountId: INSTANCE_TYPE === 'public' ? undefined : DEFAULT_ACCOUNT_ID
};

async function bootstrap() {
  if (INSTANCE_TYPE !== 'public') {
    await ensureDefaultAccount(prisma)
  }

  // Defer heavy startup tasks to avoid blocking the main thread during boot
  setTimeout(async () => {
    // Import schedulers here to break circular dependencies
    const { ensureBackupDir, readBackupFrequencyDays, scheduleBackups } = require('./utils/backup');
    const { scheduleSyncs, readSyncFrequencyMinutes } = require('./utils/syncScheduler');
    const { scheduleUserExpiration } = require('./utils/userExpiration');
    const { scheduleActivityMonitor } = require('./utils/activityMonitor');

    // Scheduled backups now run in BOTH modes. Public mode backs up every
    // account individually (see backup.js's performBackupOnce) via the export
    // builder attached to the public-auth router - previously private-only
    // because the old self-fetch path had no way to name a tenant.
    //
    // Frequency source differs by mode: private reads the schedule.json the
    // Settings UI writes (per-instance operator choice); public has no such
    // UI (it's the multi-tenant host's decision, not any single tenant's), so
    // it takes PUBLIC_BACKUP_FREQUENCY_DAYS from env and defaults to daily -
    // set it to 0 to disable public backups entirely.
    try {
      ensureBackupDir()
      const backupDays = INSTANCE_TYPE === 'public'
        ? Number(process.env.PUBLIC_BACKUP_FREQUENCY_DAYS ?? 1)
        : readBackupFrequencyDays()
      scheduleBackups(backupDays, prisma, {
        INSTANCE_TYPE,
        buildConfigExportPayload: publicAuthRouterInstance.buildConfigExportPayload,
      })
    } catch (err) {
      console.error('⚠️ Failed to initialize backup scheduler:', err)
    }

    try {
      const fs = require('fs')
      require('./utils/debugLogFile').appendCapped('/app/data/activity-monitor-debug.log', `[${new Date().toISOString()}] index.js:before_scheduleSyncs {}\n`)
    } catch {}
    scheduleSyncs(
      readSyncFrequencyMinutes(),
      prisma,
      getAccountId,
      scopedWhere,
      decrypt,
      reloadGroupAddons,
      schedulerReq,
      INSTANCE_TYPE
    )
    try {
      const fs = require('fs')
      require('./utils/debugLogFile').appendCapped('/app/data/activity-monitor-debug.log', `[${new Date().toISOString()}] index.js:after_scheduleSyncs {}\n`)
    } catch {}

    // Schedule user expiration cleanup (runs at midnight)
    try {
      scheduleUserExpiration(prisma, decrypt, StremioAPIClient, createProvider)
    } catch (err) {
      console.error('⚠️ Failed to initialize user expiration scheduler:', err)
    }

    // Schedule activity monitor (checks for new watch activity every 5 minutes)
    try {
      const fs = require('fs')
      require('./utils/debugLogFile').appendCapped('/app/data/activity-monitor-debug.log', `[${new Date().toISOString()}] index.js:about_to_call_scheduleActivityMonitor {}\n`)
    } catch {}
    try {
      scheduleActivityMonitor(prisma, decrypt, getAccountId, INSTANCE_TYPE)
    } catch (err) {
      try {
        const fs = require('fs')
        require('./utils/debugLogFile').appendCapped('/app/data/activity-monitor-debug.log', `[${new Date().toISOString()}] index.js:scheduleActivityMonitor_threw ${JSON.stringify({ message: err.message, stack: err.stack })}\n`)
      } catch {}
      console.error('⚠️ Failed to initialize activity monitor:', err)
    }

    // Schedule proxy stream monitor ("Now Playing" via AIOStreams proxy stats)
    try {
      const { scheduleProxyStreamMonitor } = require('./utils/proxyStreamMonitor')
      scheduleProxyStreamMonitor(prisma, DEFAULT_ACCOUNT_ID, {
        baseUrl: process.env.AIOSTREAMS_URL,
        username: process.env.AIOSTREAMS_AUTH_USERNAME,
        password: process.env.AIOSTREAMS_AUTH_PASSWORD,
      })
    } catch (err) {
      console.error('⚠️ Failed to initialize proxy stream monitor:', err)
    }

    // Schedule vault monitor (active-checks + expiry notifications, every 6h)
    try {
      // Self-update verdict: performSelfUpdate leaves a marker on the data
      // volume before the restart. Whichever process boots next - the new
      // version, or the old one restored by the watchdog - reads it and
      // says plainly what happened. Without this, an automatic rollback
      // would be indistinguishable from the update never running.
      try {
        const fs = require('fs')
        const path = require('path')
        const marker = path.join(process.cwd(), 'data', 'pending-update-check.json')
        if (fs.existsSync(marker)) {
          let info = null
          try { info = JSON.parse(fs.readFileSync(marker, 'utf8')) } catch { info = null }
          fs.unlinkSync(marker)
          const nowVersion = (() => { try { return require('../package.json')?.version || null } catch { return null } })()
          const { createNotification } = require('./utils/notificationStore')
          if (info && nowVersion && info.fromVersion && nowVersion !== info.fromVersion) {
            await createNotification(prisma, DEFAULT_ACCOUNT_ID, {
              type: 'task',
              title: `Updated to ${nowVersion}`,
              body: `Self-update from ${info.fromVersion} completed and the new version passed its health check.`,
            }).catch(() => {})
          } else if (info) {
            await createNotification(prisma, DEFAULT_ACCOUNT_ID, {
              type: 'task',
              title: 'Update rolled back',
              body: `The new version failed its health check, so the watchdog restored ${info.fromVersion || 'the previous version'}. This instance is running normally on the old image - check the release notes before retrying.`,
            }).catch(() => {})
          }
        }
      } catch (e) {
        console.warn('Update-verdict check failed:', e?.message)
      }

      // Opt-in scheduled self-update (see utils/selfUpdate.js)
      try {
        const { scheduleAutoUpdate } = require('./utils/selfUpdate')
        scheduleAutoUpdate(prisma, { INSTANCE_TYPE })
      } catch (e) { console.warn('Auto-update scheduler failed to start:', e?.message) }

      const { scheduleVaultMonitor } = require('./utils/vaultMonitor')
      scheduleVaultMonitor({ prisma, decrypt, getAccountId })
    } catch (err) {
      console.error('⚠️ Failed to initialize vault monitor:', err)
    }

    // Schedule catalog auto-refresh (daily re-pull of imported catalogs
    // that opted in to autoRefresh)
    try {
      const { scheduleCatalogAutoRefresh } = require('./utils/catalogAutoRefresh')
      scheduleCatalogAutoRefresh(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize catalog auto-refresh:', err)
    }

    // Schedule content-rating enforcement (daily, only for catalogs with an
    // active keptRatings policy - no-op query when nobody has one set)
    try {
      const { scheduleContentRatingEnforcement } = require('./utils/contentRatingEnforcement')
      scheduleContentRatingEnforcement(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize content rating enforcement:', err)
    }

    // Schedule debrid auto-remove (daily, only for real_debrid/torbox Vault
    // entries with autoRemoveEnabled set - no-op query when nobody has it on)
    try {
      const { scheduleDebridAutoRemove } = require('./utils/debridAutoRemove')
      scheduleDebridAutoRemove(prisma, decrypt)
    } catch (err) {
      console.error('⚠️ Failed to initialize debrid auto-remove:', err)
    }

    // Schedule SIMKL sync (pull + push, every 30m, only for users who've
    // linked a SIMKL account - no-op query when nobody has)
    try {
      const { scheduleSimklSync } = require('./utils/simklSync')
      scheduleSimklSync(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize SIMKL sync:', err)
    }

    // Schedule Automation's own time.daily trigger (every 1m, only for
    // accounts with an enabled time.daily rule - no-op query otherwise)
    try {
      const { scheduleAutomationTimeTriggers } = require('./utils/automation/scheduler')
      scheduleAutomationTimeTriggers(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize automation scheduler:', err)
    }

    // Schedule auto-generated themed catalogs (daily, only for accounts
    // that opted in via Settings -> SlickTrax -> Auto-generated catalogs)
    try {
      const { scheduleAutoThemedCatalogs } = require('./utils/autoThemedCatalogs')
      scheduleAutoThemedCatalogs(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize auto-themed catalogs:', err)
    }

    // Schedule DB maintenance (scheduled VACUUM + opt-in watch-history
    // pruning, both off by default - operator-controlled via the
    // Superadmin panel, private/SQLite mode only)
    try {
      const { scheduleDbMaintenance } = require('./utils/dbMaintenance')
      scheduleDbMaintenance(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize DB maintenance scheduler:', err)
    }

    // Schedule the Collections Guard (hourly snapshots of every Nuvio
    // user's home-screen collections + external-overwrite alarms - see
    // utils/collectionsGuard.js). Both instance types: collections belong
    // to whoever's Nuvio account is connected, not to the instance.
    try {
      const { scheduleCollectionsGuard } = require('./utils/collectionsGuard')
      scheduleCollectionsGuard(prisma, { createProvider, decrypt })
    } catch (err) {
      console.error('⚠️ Failed to initialize Collections Guard:', err)
    }

    // Schedule new-episode alerts (Cinemeta episode-list polling for shows
    // with recent watch history, every 6h)
    try {
      const { scheduleEpisodeAlerts } = require('./utils/episodeAlerts')
      scheduleEpisodeAlerts(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize episode alerts:', err)
    }

    // Schedule update-available notifications (every 6h - matches
    // getVersionStatus's own GitHub-API cache TTL) - opt-in, off by default.
    try {
      const { scheduleUpdateCheckNotifier } = require('./utils/updateCheckNotifier')
      scheduleUpdateCheckNotifier(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize update-check notifier:', err)
    }

    // Nudges an account whose Disaster Recovery Kit is stale/missing while
    // its Vault holds credentials nothing else can restore - opt-in, off by
    // default. See recoveryKitReminder.js for why this is a reminder rather
    // than an automated off-site kit export.
    try {
      const { scheduleRecoveryKitReminder } = require('./utils/recoveryKitReminder')
      scheduleRecoveryKitReminder(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize recovery-kit reminder:', err)
    }

    // Schedule notification digest sends (hourly check, actual send gated by
    // each account's daily/weekly cadence) - opt-in, off by default.
    try {
      const { scheduleNotificationDigest } = require('./utils/notificationDigest')
      scheduleNotificationDigest(prisma)
    } catch (err) {
      console.error('⚠️ Failed to initialize notification digest:', err)
    }

    // Schedule vault backup export (decrypted JSON snapshot to data/backup/vault/,
    // nightly by default — set VAULT_BACKUP_INTERVAL_HOURS to change)
    try {
      const { scheduleVaultBackups } = require('./utils/vaultBackup')
      const intervalHours = parseInt(process.env.VAULT_BACKUP_INTERVAL_HOURS || '24', 10)
      scheduleVaultBackups({ prisma, decrypt, intervalHours })
    } catch (err) {
      console.error('⚠️ Failed to initialize vault backup scheduler:', err)
    }

    // Drop Trash items past their retention window. Runs at boot and daily -
    // cheap, and keeps deleted-item archives from accumulating forever.
    try {
      const { purgeExpiredTrash } = require('./utils/trash')
      setTimeout(() => purgeExpiredTrash(prisma), 90 * 1000)
      setInterval(() => purgeExpiredTrash(prisma), 24 * 60 * 60 * 1000)
    } catch (err) {
      console.error('⚠️ Failed to schedule trash purge:', err)
    }

    // Schedule metadata-provider key health checker (TMDb/OMDb/MDBList/RPDB) -
    // same "catch it before a user notices broken posters" idea as the addon
    // health checker below, aimed at the keys instead of the addons.
    try {
      const { startMetadataKeyHealthScheduler } = require('./utils/metadataKeyHealth')
      startMetadataKeyHealthScheduler(prisma, schedulerReq.appAccountId)
    } catch (err) {
      console.error('⚠️ Failed to initialize metadata key health checker:', err)
    }

    // Schedule addon health checker (checks if addon manifests are reachable)
    try {
      const { startHealthCheckScheduler } = require('./utils/addonHealthCheck')
      startHealthCheckScheduler(prisma, schedulerReq.appAccountId)
    } catch (err) {
      console.error('⚠️ Failed to initialize addon health checker:', err)
    }

    // Schedule monthly poster mosaic (checks every 6h whether the account
    // has crossed into a new month and hasn't posted last month's recap yet)
    try {
      const { scheduleMosaicMonitor } = require('./utils/posterMosaic')
      scheduleMosaicMonitor(prisma, schedulerReq.appAccountId)
    } catch (err) {
      console.error('⚠️ Failed to initialize poster mosaic scheduler:', err)
    }

    // Schedule Sync Guardian (catches a synced user's addons reverting
    // outside SlickSync - see utils/syncGuardian.js for the full mechanism)
    try {
      const { scheduleSyncGuardian } = require('./utils/syncGuardian')
      scheduleSyncGuardian(prisma, {
        getAccountId, decrypt, parseAddonIds, parseProtectedAddons,
        getDecryptedManifestUrl, canonicalizeManifestUrl, StremioAPIClient, createProvider,
      }, schedulerReq.appAccountId)
    } catch (err) {
      console.error('⚠️ Failed to initialize Sync Guardian:', err)
    }

    // Schedule DB size sampling for the Tasks page's storage chart
    // (private/SQLite-mode only - no-ops itself if DATABASE_URL isn't file:)
    try {
      const { scheduleDbSizeMonitor } = require('./utils/dbSizeMonitor')
      scheduleDbSizeMonitor(prisma, schedulerReq.appAccountId || DEFAULT_ACCOUNT_ID)
    } catch (err) {
      console.error('⚠️ Failed to initialize DB size monitor:', err)
    }

    // Startup repair: reload addons with uninitialized resources/catalogs across all accounts
    try {
      const { reloadAddon } = require('./routes/addons')
      const reloadDeps = { filterManifestByResources, filterManifestByCatalogs, encrypt, decrypt, getDecryptedManifestUrl, manifestHash, silent: true }

      // Find all addons with empty resources AND empty catalogs that have an originalManifest
      const uninitializedAddons = await prisma.addon.findMany({
        where: {
          isActive: true,
          originalManifest: { not: null },
          OR: [
            { resources: '[]' },
            { resources: null }
          ]
        },
        select: { id: true, name: true, accountId: true, catalogs: true }
      })

      // Filter to only those where catalogs is also empty
      const toRepair = uninitializedAddons.filter(a => {
        if (!a.catalogs || a.catalogs === '[]') return true
        try {
          const parsed = JSON.parse(a.catalogs)
          return !Array.isArray(parsed) || parsed.length === 0
        } catch { return true }
      })

      if (toRepair.length > 0) {
        console.error(`🔧 Startup repair: found ${toRepair.length} addon(s) with uninitialized resources/catalogs, reloading...`)
        let repaired = 0
        let failed = 0
        for (const addon of toRepair) {
          try {
            const mockReq = { appAccountId: addon.accountId }
            await reloadAddon(prisma, () => addon.accountId, addon.id, mockReq, reloadDeps, true)
            repaired++
          } catch (err) {
            failed++
            console.error(`  ❌ Failed to repair ${addon.name}: ${err.message}`)
          }
        }
        console.error(`🔧 Startup repair complete: ${repaired} repaired, ${failed} failed`)
      }
    } catch (err) {
      console.error('⚠️ Failed to run startup addon repair:', err)
    }
  }, 10000)

  const storageLabel = process.env.PRISMA_PROVIDER === 'sqlite' ? 'SQLite with Prisma' : 'PostgreSQL with Prisma'

  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 SlickSync (Database) running on port', PORT)
    console.log('📊 Health check: http://127.0.0.1:' + PORT + '/health')
    console.log('🔌 API endpoints: http://127.0.0.1:' + PORT + '/api/')
    console.log('🎬 Stremio integration: ENABLED')
    console.log(`💾 Storage: ${storageLabel}`)
  })
}

bootstrap().catch((err) => {
  console.error('❌ Failed to start SlickSync server:', err)
  process.exit(1)
})



