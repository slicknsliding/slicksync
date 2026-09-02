// Active validity checks for the four metadata-provider keys (TMDb, OMDb,
// MDBList, RPDB) - the same idea Vault already runs against Real-Debrid/
// TorBox/etc (vaultCheckers.js), applied to the keys typed into Settings
// instead of Vault entries.
//
// Why this exists: these keys silently rot - a free-tier key gets revoked,
// a daily quota resets and the app hits it again, someone fat-fingers a
// paste. Nothing in the app today notices until a poster or rating badge
// quietly stops rendering, and there is no error a user can report because
// nothing actually failed loudly - RPDB/OMDb/MDBList calls that 401 just
// fall back to no rating/no poster rather than throwing. This is the same
// blind spot addon health checks close for addons, aimed at these keys
// instead.
//
// Deliberately cheap: one small GET per provider, per account, on a daily
// cadence (see the scheduler in index.js) - not on every poster render.
// Each check function returns a uniform shape so the caller never needs to
// know provider-specific response formats.

const CHECK_TIMEOUT_MS = 8000;

/** @returns {Promise<{ok: boolean, message: string, rateLimited: boolean}>} */
async function timedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// TMDb's own /authentication endpoint exists specifically to validate a key
// with no other side effects - documented, and already the lightest call
// their API offers.
async function checkTmdb(key) {
  try {
    const res = await timedFetch(`https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(key)}`);
    if (res.status === 401) return { ok: false, message: 'Key rejected (401) - likely revoked or mistyped', rateLimited: false };
    if (res.status === 429) return { ok: false, message: 'Rate limited (429)', rateLimited: true };
    if (!res.ok) return { ok: false, message: `TMDb returned ${res.status}`, rateLimited: false };
    const body = await res.json().catch(() => null);
    if (body && body.success === true) return { ok: true, message: 'OK', rateLimited: false };
    return { ok: false, message: (body && body.status_message) || 'Unexpected response', rateLimited: false };
  } catch (e) {
    return { ok: false, message: describeNetworkError(e), rateLimited: false };
  }
}

// OMDb has no dedicated validate endpoint - a real, permanent, always-
// resolvable IMDb ID (Shawshank Redemption) doubles as the cheapest
// possible real lookup. OMDb's free tier caps at 1000 req/day and reports
// that as its own error string rather than an HTTP status, so that string
// is checked for explicitly.
async function checkOmdb(key) {
  try {
    const res = await timedFetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&i=tt0111161`);
    if (res.status === 401) return { ok: false, message: 'Key rejected (401) - likely revoked or mistyped', rateLimited: false };
    const body = await res.json().catch(() => null);
    if (body && body.Response === 'True') return { ok: true, message: 'OK', rateLimited: false };
    const err = (body && body.Error) || '';
    if (/limit reached/i.test(err)) return { ok: false, message: 'Daily request limit reached', rateLimited: true };
    if (/invalid api key/i.test(err)) return { ok: false, message: 'Invalid API key', rateLimited: false };
    return { ok: false, message: err || `OMDb returned ${res.status}`, rateLimited: false };
  } catch (e) {
    return { ok: false, message: describeNetworkError(e), rateLimited: false };
  }
}

// MDBList's /user endpoint returns the account tied to the key (and its own
// request quota) - a genuine identity check, not a guess at a working
// lookup, and it's the same api.mdblist.com host already used elsewhere in
// this codebase for list import/export.
//
// Also the ONLY one of the four providers whose real usage is checkable at
// all - confirmed against MDBList's own published OpenAPI spec, which
// documents api_requests (the account's total quota) and api_requests_count
// (used so far) on this exact response. Deliberately not attempted for the
// other three: TMDb removed rate limiting outright in Dec 2019 (nothing to
// show), OMDb exposes no usage endpoint at all - only a hard stop once
// exhausted - and RPDB's own help docs say usage is checkable by logging
// into their website, not through the API. Faking a number for any of those
// would be worse than showing nothing.
async function checkMdblist(key) {
  try {
    const res = await timedFetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(key)}`);
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Key rejected (${res.status})`, rateLimited: false };
    if (res.status === 429) return { ok: false, message: 'Rate limited (429)', rateLimited: true };
    if (!res.ok) return { ok: false, message: `MDBList returned ${res.status}`, rateLimited: false };
    const body = await res.json().catch(() => null);
    if (body && (body.error || body.Error)) {
      return { ok: false, message: String(body.error || body.Error), rateLimited: false };
    }
    const usage = (body && Number.isFinite(body.api_requests) && Number.isFinite(body.api_requests_count))
      ? {
          used: body.api_requests_count,
          limit: body.api_requests,
          percentUsed: body.api_requests > 0 ? Math.round((body.api_requests_count / body.api_requests) * 1000) / 10 : 0,
          plan: typeof body.plan === 'string' ? body.plan : null,
        }
      : undefined;
    return { ok: true, message: 'OK', rateLimited: false, ...(usage ? { usage } : {}) };
  } catch (e) {
    return { ok: false, message: describeNetworkError(e), rateLimited: false };
  }
}

// RPDB documents /isValid specifically for this purpose - the same
// api.ratingposterdb.com host the poster proxy already calls.
async function checkRpdb(key) {
  try {
    const res = await timedFetch(`https://api.ratingposterdb.com/${encodeURIComponent(key)}/isValid`);
    if (!res.ok) return { ok: false, message: `RPDB returned ${res.status}`, rateLimited: res.status === 429 };
    const body = await res.json().catch(() => null);
    if (body && body.valid === true) return { ok: true, message: 'OK', rateLimited: false };
    return { ok: false, message: 'Key reported invalid', rateLimited: false };
  } catch (e) {
    return { ok: false, message: describeNetworkError(e), rateLimited: false };
  }
}

function describeNetworkError(e) {
  if (e && e.name === 'AbortError') return 'Timed out';
  return (e && e.message) || 'Network error';
}

const CHECKERS = { tmdb: checkTmdb, omdb: checkOmdb, mdblist: checkMdblist, rpdb: checkRpdb };

/**
 * Runs whichever of the four checks have a key configured for this account
 * (own Settings value, falling back to the instance-wide env var - the same
 * resolution order every other use of these keys already follows), and
 * returns a result per provider actually checked. Providers with no key at
 * all (neither the account's own nor an env fallback) are skipped entirely -
 * nothing to validate.
 */
async function runKeyHealthChecks(resolvedKeys) {
  const results = {};
  await Promise.all(
    Object.entries(resolvedKeys).map(async ([provider, key]) => {
      if (!key || !CHECKERS[provider]) return;
      results[provider] = { ...(await CHECKERS[provider](key)), checkedAt: new Date().toISOString() };
    })
  );
  return results;
}

const MINUTE_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * MINUTE_MS; // daily - these keys don't need finer granularity than addon uptime does
let schedulerTimer = null;

async function getNotifyTarget(prisma, accountId) {
  try {
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } });
    let cfg = account?.sync;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
    // Defaults true, same reasoning as notifyOnAddonHealth: a key silently
    // dying means posters/ratings silently stop rendering with no error a
    // user could report, so the admin finding out at all should be the
    // default, not an opt-in they have to discover first.
    return cfg?.notifyOnKeyHealth !== false;
  } catch { return true; }
}

const PROVIDER_LABEL = { tmdb: 'TMDb', omdb: 'OMDb', mdblist: 'MDBList', rpdb: 'RPDB' };

/**
 * Resolves this account's four provider keys, checks whichever are set,
 * merges the results into its stored keyHealth, and - unless notify:false -
 * fires a notification + automation event on every ok<->failing transition
 * (not on every check, so a key that's been broken for a week doesn't
 * re-notify daily). Shared by the manual "check now" route and the daily
 * scheduler below, so both go through identical persist/notify logic.
 */
// Provider key -> the Settings field holding it, so the matching `...Backup`
// field can be found. Explicit rather than derived: a rename should break
// loudly here rather than silently stop reporting that a backup exists.
const FIELD_BY_PROVIDER = {
  tmdb: 'tmdbApiKey',
  omdb: 'omdbApiKey',
  mdblist: 'mdblistApiKey',
  rpdb: 'rpdbApiKey',
};

async function checkAndPersistAccountKeys(prisma, accountId, { notify = true, only = null } = {}) {
  const { resolveKeyFromSettings } = require('./listImport');
  const noReq = null;
  const getId = () => accountId;

  // allowBackup:false - this checks the PRIMARY keys specifically. If it
  // followed failover it would test whichever key is currently in use, so a
  // working backup would record the provider as healthy, which is precisely
  // the signal that decides the primary is fine again. See listImport.js.
  const opts = { allowBackup: false };
  const [tmdb, omdb, mdblist, rpdb] = await Promise.all([
    resolveKeyFromSettings(prisma, getId, noReq, 'tmdbApiKey', 'TMDB_API_KEY', opts),
    resolveKeyFromSettings(prisma, getId, noReq, 'omdbApiKey', 'OMDB_API_KEY', opts),
    resolveKeyFromSettings(prisma, getId, noReq, 'mdblistApiKey', 'MDBLIST_API_KEY', opts),
    resolveKeyFromSettings(prisma, getId, noReq, 'rpdbApiKey', 'RPDB_API_KEY', opts),
  ]);

  // `only` narrows the run to one provider - used by the on-blur check when
  // a single key is edited in Settings, where re-testing the other three on
  // every blur would be pure waste. The merge below already preserves
  // previous results for providers not in this run.
  const all = { tmdb, omdb, mdblist, rpdb };
  const toCheck = only && all[only] !== undefined ? { [only]: all[only] } : all;
  const results = await runKeyHealthChecks(toCheck);

  const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } });
  let cfg = account?.sync;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  const previousHealth = (cfg.keyHealth && typeof cfg.keyHealth === 'object') ? cfg.keyHealth : {};

  // Per-key ring health for the Key Pool: every configured key for a
  // provider (primary, backup, extras) gets its own check, stored under
  // keyHealth[provider].pool keyed by a hash-prefix tag - never the key
  // itself, since keyHealth rides in the same JSON config exports read.
  // The ring selector (keyPool.js) skips members marked failing or
  // rate-limited. Only runs for providers with a ring bigger than one key -
  // the single-key case is exactly what the primary check above already is.
  try {
    const { buildRing, keyTag } = require('./keyPool');
    const FIELD_OF = { tmdb: 'tmdbApiKey', omdb: 'omdbApiKey', mdblist: 'mdblistApiKey', rpdb: 'rpdbApiKey' };
    for (const provider of Object.keys(toCheck)) {
      const ring = buildRing(cfg, FIELD_OF[provider]);
      if (ring.length <= 1) continue;
      const perKey = [];
      for (const key of ring) {
        const r = await CHECKERS[provider](key);
        perKey.push({ tag: keyTag(key), last4: String(key).slice(-4), ok: r.ok, rateLimited: !!r.rateLimited, checkedAt: new Date().toISOString() });
      }
      results[provider] = { ...(results[provider] || {}), pool: perKey };
    }
  } catch (e) {
    console.warn('[KeyHealth] Pool ring check failed:', e?.message);
  }

  const mergedHealth = { ...previousHealth, ...results };

  await prisma.appAccount.update({
    where: { id: accountId },
    data: { sync: JSON.stringify({ ...cfg, keyHealth: mergedHealth }) },
  });

  if (notify) {
    try {
      const shouldNotify = await getNotifyTarget(prisma, accountId);
      const { emitAutomationEvent } = require('./automation/engine');
      for (const [provider, result] of Object.entries(results)) {
        const wasOk = previousHealth[provider]?.ok;
        // Only a genuine transition, in either direction. `wasOk === undefined`
        // (never checked before) counts as "was fine" for this purpose - the
        // first-ever check finding a broken key should still surface it, but
        // the very first check of an already-fine key shouldn't announce
        // "recovered" from nothing.
        const failed = result.ok === false && wasOk !== false;
        const recovered = result.ok === true && wasOk === false;
        if (!failed && !recovered) continue;

        const label = PROVIDER_LABEL[provider] || provider;
        if (shouldNotify) {
          const { createNotification } = require('./notificationStore');
          await createNotification(prisma, accountId, {
            type: 'task',
            title: failed ? `${label} key stopped working` : `${label} key working again`,
            body: failed ? result.message : 'Posters/ratings from this provider are resolving normally again.',
            dedupeKey: `keyhealth-${provider}-${failed ? 'fail' : 'ok'}-${new Date().toDateString()}`,
          });
        }
        const backupKey = (typeof cfg[`${FIELD_BY_PROVIDER[provider]}Backup`] === 'string')
          ? cfg[`${FIELD_BY_PROVIDER[provider]}Backup`].trim()
          : '';

        await emitAutomationEvent(prisma, accountId, failed ? 'metadata_key.failed' : 'metadata_key.recovered', {
          provider,
          providerLabel: label,
          message: result.message,
          rateLimited: !!result.rateLimited,
          hasBackup: !!backupKey,
        });

        // Same ok -> failing edge, so it fires once rather than daily while
        // the primary stays broken. Lookups use the backup from here on.
        if (failed && backupKey) {
          await emitAutomationEvent(prisma, accountId, 'metadata_key.failover_activated', {
            provider,
            providerLabel: label,
            message: result.message,
            rateLimited: !!result.rateLimited,
          });
        }
      }

      // Quota warnings are independent of ok/failing: a key can be perfectly
      // valid and still be about to run out, which is exactly the moment
      // worth knowing about. Fires once per CROSSING, not on every daily
      // check - a key sitting at 85% for a fortnight should not produce a
      // fortnight of identical alerts, so the previous reading decides.
      for (const [provider, result] of Object.entries(results)) {
        const usage = result.usage;
        if (!usage || !Number.isFinite(usage.percentUsed)) continue;
        const previousPercent = previousHealth[provider]?.usage?.percentUsed;
        const wasBelow = !Number.isFinite(previousPercent) || previousPercent < QUOTA_WARN_PERCENT;
        if (usage.percentUsed < QUOTA_WARN_PERCENT || !wasBelow) continue;

        const label = PROVIDER_LABEL[provider] || provider;
        if (shouldNotify) {
          const { createNotification } = require('./notificationStore');
          await createNotification(prisma, accountId, {
            type: 'task',
            title: `${label} key is ${Math.round(usage.percentUsed)}% used`,
            body: `${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} requests used. Posters and ratings from ${label} stop appearing once the allowance runs out.`,
            url: '/settings',
            dedupeKey: `keyquota-${provider}-${new Date().toISOString().slice(0, 7)}`,
          });
        }
        await emitAutomationEvent(prisma, accountId, 'metadata_key.quota_low', {
          provider,
          providerLabel: label,
          percentUsed: usage.percentUsed,
          used: usage.used,
          limit: usage.limit,
        });
      }
    } catch { /* notification/automation failure must never break the check itself */ }
  }

  return mergedHealth;
}

async function runAllAccountsKeyHealthCheck(prisma, accountId) {
  try {
    const accounts = accountId
      ? [{ id: accountId }]
      : await prisma.appAccount.findMany({ select: { id: true } });
    for (const acc of accounts) {
      try { await checkAndPersistAccountKeys(prisma, acc.id, { notify: true }); }
      catch (e) { console.error(`[MetadataKeyHealth] Check failed for account ${acc.id}:`, e?.message); }
    }
  } catch (e) {
    console.error('[MetadataKeyHealth] Scheduled check failed:', e?.message);
  }
}

/** accountId: DEFAULT_ACCOUNT_ID for private mode, undefined for public
 * (checks every account) - same convention addonHealthCheck's scheduler
 * uses, called the same way from index.js. */
function startMetadataKeyHealthScheduler(prisma, accountId = undefined) {
  if (schedulerTimer) clearInterval(schedulerTimer);
  // Staggered well clear of the other boot-time schedulers (addon health
  // fires at 10s) so a cold boot doesn't fire every external HTTP check at
  // once.
  setTimeout(() => runAllAccountsKeyHealthCheck(prisma, accountId), 45000);
  schedulerTimer = setInterval(() => runAllAccountsKeyHealthCheck(prisma, accountId), CHECK_INTERVAL_MS);
}

function stopMetadataKeyHealthScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

module.exports = {
  runKeyHealthChecks,
  CHECKERS,
  checkAndPersistAccountKeys,
  startMetadataKeyHealthScheduler,
  stopMetadataKeyHealthScheduler,
};
