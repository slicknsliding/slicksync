// Activity monitor - reads every connected person's library once a minute and
// feeds metrics and sessions. Watch notifications are sent by sessionTracker.js.
const { setCachedLibrary } = require('./libraryCache')
const { processAccountSessions } = require('./sessionTracker')
const { sendShareNotification: notifySendShareNotification } = require('./notify')

const CHECK_INTERVAL_MS = 1 * 60 * 1000 // 1 minute

// Public (multi-tenant) mode processes every registered account on this same
// 1-minute tick, one full native-library fetch + session/metrics pass per
// account. Each account's pass involves real outbound HTTP to Stremio/Nuvio's
// API, so with enough accounts a single pass can take longer than the
// interval between ticks - without a guard, the NEXT tick would start a
// second overlapping pass over the same accounts, compounding indefinitely
// (more concurrent outbound requests, more DB contention, memory pressure)
// rather than settling into a steady rate. isAccountsPassRunning makes a
// tick that finds a previous pass still in flight skip entirely instead of
// stacking - the same account just gets checked on the NEXT tick instead,
// which is a far safer failure mode than unbounded pile-up. ACCOUNT_BATCH_SIZE
// bounds how many accounts are processed in parallel within one pass - fully
// serial (batch size 1) is safe but slow with many accounts; fully parallel
// risks hammering every account's provider API and this box's own outbound
// connections at once. Neither of these was needed before tonight because
// private mode only ever has exactly one account to iterate.
let isAccountsPassRunning = false
const ACCOUNT_BATCH_SIZE = 5

let activityTimer = null

// Direct file-based heartbeat, bypassing console.log/stdout entirely. Console
// output from this backend process has not reliably reached `docker logs`
// during steady-state operation (confirmed: zero output over a 20-minute
// window despite active traffic) - the v1.9.2 stdbuf fix's own changelog
// admitted it was never actually confirmed to work with bun specifically.
// This gives a way to verify whether/how far the scheduler is actually
// executing, independent of whether console output ever surfaces.
function heartbeat(event, data = {}) {
  try {
    const fs = require('fs')
    const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}\n`
    require('./debugLogFile').appendCapped('/app/data/activity-monitor-debug.log', line)
  } catch {}
}

function clearActivityMonitor() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
}

// One read of an account at a time. The minute tick and a read asked for by
// one person (checkActivityForUser) both end in the same recording step, and
// two of them overlapping could record the same watch time twice.
const accountRuns = new Map() // accountId -> the run in flight (or queued last)

function checkActivityForAccount(prisma, accountId, decrypt, getAccountId, onlyUserId = null) {
  const run = () => readAccountActivity(prisma, accountId, decrypt, getAccountId, onlyUserId)
  const queued = (accountRuns.get(accountId) || Promise.resolve()).then(run, run)
  accountRuns.set(accountId, queued)
  const release = () => { if (accountRuns.get(accountId) === queued) accountRuns.delete(accountId) }
  queued.then(release, release)
  return queued
}

// The dependencies of the running monitor, kept for reads asked for between
// ticks (checkActivityForUser).
let monitorDeps = null

/**
 * Read one person's library now instead of waiting for the next tick, through
 * exactly the recording the tick does. Resolves false when the monitor is not
 * running (nothing to read with).
 */
async function checkActivityForUser(accountId, userId) {
  if (!monitorDeps) return false
  await checkActivityForAccount(monitorDeps.prisma, accountId || 'default', monitorDeps.decrypt, monitorDeps.getAccountId, userId)
  return true
}

async function readAccountActivity(prisma, accountId, decrypt, getAccountId, onlyUserId = null) {
  heartbeat('checkActivityForAccount:start', { accountId })
  try {
    // Nothing to do for an account that is not there.
    const account = await prisma.appAccount.findUnique({
      where: { id: accountId },
      select: { id: true }
    })

    heartbeat('checkActivityForAccount:account_lookup_done', { found: !!account })
    if (!account) return

    // Get all active users for this account
    const users = await prisma.user.findMany({
      where: {
        accountId: accountId,
        isActive: true
      },
      select: {
        id: true,
        username: true,
        email: true,
        stremioAuthKey: true,
        providerType: true,
        nuvioRefreshToken: true,
        nuvioUserId: true,
        jellyfinServerUrl: true,
        jellyfinServerId: true,
        jellyfinServerKind: true,
        jellyfinUserId: true,
        jellyfinToken: true,
        colorIndex: true,
        notifyOnWatch: true,
        discordWebhookUrl: true,
        // Needed so getLibraryForUser can clear the flag on a successful fetch
        // (the self-healing half of the "Reconnect needed" warning).
        providerConnectionError: true,
        providerConnectionErrorAt: true
      }
    })

    if (users.length === 0) return

    heartbeat('checkActivityForAccount:users_found', { count: users.length })

    // A read asked for by one person covers only them; everyone else waits
    // for the tick as usual. `users` stays the whole account for what is
    // matched against it (attribution among the household).
    const targets = onlyUserId ? users.filter((u) => u.id === onlyUserId) : users
    if (targets.length === 0) return

    // Process metrics for all users
    // This runs every 5 minutes to compute accurate watch time deltas
    try {
      const { processAccountMetrics } = require('./metricsProcessor')
      const { getCachedLibrary } = require('./libraryCache')
      const { makeCreateProvider } = require('../providers')
      const { encrypt } = require('./encryption')
      const createProvider = makeCreateProvider({ prisma, encrypt, getAccountId: () => accountId })

      // A live-fetch failure below falls back to a stale cached library so
      // sessions/metrics processing still has *something* to run against -
      // but that fallback used to be completely silent, with no record
      // anywhere that it was even happening. Confirmed real case: a user's
      // watch history went quiet for over a week with zero visibility into
      // why. providerConnectionError makes that visible and self-healing -
      // set on any live-fetch failure, cleared on the next success.
      function isAuthFailure(message) {
        const m = (message || '').toLowerCase()
        return m.includes('session does not exist') || m.includes('unauthorized') || m.includes('invalid auth') || m.includes(' 401')
          || m.includes('authentication expired') // Nuvio's refresh token was rejected
      }
      // providerConnectionErrorAt is when the outage STARTED: kept while it
      // keeps failing, so connectionAlerts can tell a blip from an outage
      // and announce each outage once. Returns that start, or null if the
      // write failed.
      async function recordConnectionError(user, message) {
        const since = (user.providerConnectionError && user.providerConnectionErrorAt) ? new Date(user.providerConnectionErrorAt) : new Date()
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { providerConnectionError: message.slice(0, 500), providerConnectionErrorAt: since },
          })
          return since
        } catch { return null }
      }
      async function clearConnectionError(userId) {
        try {
          await prisma.user.update({
            where: { id: userId },
            data: { providerConnectionError: null, providerConnectionErrorAt: null },
          })
        } catch {}
      }

      // The library cache moved from email-keyed to user-id-keyed filenames
      // (see libraryCache.js's getCacheFilePath for the corruption that
      // caused). The old email-keyed file is still safe to read for a user
      // whose email nothing else on this account shares - that file can only
      // have come from them. For a shared email it is exactly the ambiguous
      // case, so those users skip it and simply re-fetch.
      const emailCounts = new Map()
      for (const u of users) {
        if (!u.email) continue
        emailCounts.set(u.email, (emailCounts.get(u.email) || 0) + 1)
      }
      const canUseLegacyCache = (user) => !!user?.email && emailCounts.get(user.email) === 1

      // Helper function to get library for a user via their provider
      // (Stremio, Nuvio or Jellyfin); falls back to cache if no credentials or on error.
      // Fetched ONCE per pass: the metrics step and the sessions step both
      // ask for it within the same second, and each used to fetch, parse and
      // re-cache the whole library on its own - twice the network and twice
      // the CPU for an identical answer. The memo lives for this pass only.
      const libraryOnce = new Map()
      const getLibraryForUser = (user) => {
        if (!libraryOnce.has(user.id)) libraryOnce.set(user.id, fetchLibraryForUser(user))
        return libraryOnce.get(user.id)
      }
      const fetchLibraryForUser = async (user) => {
        try {
          const mockReq = { appAccountId: accountId }
          const provider = createProvider(user, { decrypt: (t) => decrypt(t, mockReq), req: mockReq })
          if (!provider) {
            // No usable credentials, use cached library (library-email.json)
            heartbeat('getLibraryForUser:no_provider', { userId: user.id })
            return getCachedLibrary(accountId, user, { allowLegacyEmailFile: canUseLegacyCache(user) }) || []
          }

          const libraryItems = await provider.getLibrary()
          const library = Array.isArray(libraryItems) ? libraryItems : (libraryItems?.result || libraryItems?.library || [])

          // Update cache with fresh data
          if (Array.isArray(library) && library.length > 0) {
            setCachedLibrary(accountId, user, library)
          }

          heartbeat('getLibraryForUser:live_fetch_ok', {
            userId: user.id,
            itemCount: Array.isArray(library) ? library.length : 0
          })

          // Titles watched before server posters existed (utils/jellyfinImages.js).
          if (user.providerType === 'jellyfin') {
            try {
              await require('./jellyfinImages').fillMissingPosters(prisma, accountId, user.__recordAs || user.id, library)
            } catch (e) {
              console.warn(`[ActivityMonitor] poster fill failed for ${user.id}:`, e.message)
            }
          }

          if (user.providerConnectionError) {
            await clearConnectionError(user.id)
            await require('./connectionAlerts').onConnectionRecovered(prisma, accountId, user)
          }
          return library || []
        } catch (error) {
          heartbeat('getLibraryForUser:live_fetch_failed', { userId: user.id, message: error.message })
          console.warn(`[ActivityMonitor] Failed to fetch library for user ${user.id}:`, error.message)
          // A daily limit's pause blocks a Jellyfin person through their
          // access schedule, which refuses SlickSync's own requests too.
          // That's expected while it lasts - not a sign-in to reconnect.
          const pausedByLimit = user.providerType === 'jellyfin'
            && await require('./screenTime').isStreamingPaused(prisma, accountId, user.__recordAs || user.id).catch(() => false)
          if (!pausedByLimit) {
            const prefix = isAuthFailure(error.message) ? 'Reconnect needed: ' : 'Connection issue: '
            const since = await recordConnectionError(user, prefix + error.message)
            if (since) await require('./connectionAlerts').onConnectionFailed(prisma, accountId, user, prefix + error.message, since)
          }
          // Fallback to cache if API call fails
          const cachedLibrary = getCachedLibrary(accountId, user, { allowLegacyEmailFile: canUseLegacyCache(user) })
          return cachedLibrary || []
        }
      }

      // A merged person (utils/userMerge.js) holds a second provider's login
      // that addon sync already uses, but its viewing was never read. Each
      // one is read here as its own entry: its id is the absorbed user's old
      // id, so its progress baselines stay apart from the main login's -
      // Stremio counts progress cumulatively, Nuvio as a position, and one
      // set of baselines for both would invent watch time - while
      // everything it watched is recorded for the person (__recordAs).
      let absorbedLogins = []
      try {
        const credentials = await prisma.userProviderCredential.findMany({ where: { userId: { in: users.map((u) => u.id) } } })
        absorbedLogins = credentials.map((c) => {
          const owner = users.find((u) => u.id === c.userId)
          if (!owner) return null
          return {
            ...owner,
            id: c.donorId || `absorbed-${c.id}`,
            providerType: c.providerType,
            stremioAuthKey: c.stremioAuthKey,
            nuvioRefreshToken: c.nuvioRefreshToken,
            nuvioUserId: c.nuvioUserId,
            jellyfinServerUrl: c.jellyfinServerUrl,
            jellyfinServerId: c.jellyfinServerId,
            jellyfinServerKind: c.jellyfinServerKind,
            jellyfinUserId: c.jellyfinUserId,
            jellyfinToken: c.jellyfinToken,
            providerConnectionError: null,
            __recordAs: owner.id,
            // A refreshed Nuvio token belongs on this login's own row.
            __persistNuvioRefreshToken: c.providerType === 'nuvio'
              ? async (encrypted) => { await prisma.userProviderCredential.update({ where: { id: c.id }, data: { nuvioRefreshToken: encrypted } }) }
              : undefined,
          }
        }).filter(Boolean)
      } catch (e) {
        console.warn('[ActivityMonitor] Could not read merged logins:', e.message)
      }
      const absorbedByPerson = new Map(absorbedLogins.map((a) => [a.__recordAs, a]))

      // Sessions are the person's live state, so they are tracked over both
      // of a merged person's libraries together: the session step closes any
      // session it cannot find in the library it is given, and given only
      // one login's library it would close the other's every minute.
      const getSessionLibrary = async (user) => {
        const own = await getLibraryForUser(user)
        const absorbed = absorbedByPerson.get(user.id)
        if (!absorbed) return own
        const theirs = await getLibraryForUser(absorbed)
        const byId = new Map()
        const lastWatched = (item) => new Date(item?.state?.lastWatched || item?._mtime || 0).getTime() || 0
        for (const item of [...(own || []), ...(theirs || [])]) {
          const id = item?._id || item?.id
          if (!id) continue
          const kept = byId.get(id)
          if (!kept || lastWatched(item) > lastWatched(kept)) byId.set(id, item)
        }
        return [...byId.values()]
      }

      // Process metrics for all users
      console.log(`[ActivityMonitor] Starting metrics processing for account ${accountId}, ${users.length} users`)
      heartbeat('processAccountMetrics:before')
      await processAccountMetrics(prisma, accountId, [...users, ...absorbedLogins], getLibraryForUser, new Date(), onlyUserId ? new Set([onlyUserId]) : null)
      heartbeat('processAccountMetrics:after')
      console.log(`[ActivityMonitor] Completed metrics processing for account ${accountId}`)

      // Process watch sessions (track start/end times)
      try {
        heartbeat('processAccountSessions:before')
        await processAccountSessions(prisma, accountId, targets, getSessionLibrary, new Date())
        heartbeat('processAccountSessions:after')
      } catch (sessionError) {
        heartbeat('processAccountSessions:error', { message: sessionError.message, stack: sessionError.stack })
        console.warn(`[ActivityMonitor] Error processing sessions:`, sessionError.message)
      }

      // Viewings a Jellyfin server's sessions list showed starting during the
      // library reads above - see utils/jellyfinLive.js.
      try {
        await require('./jellyfinLive').announceStarts(prisma, accountId, targets)
        await require('./jellyfinLive').noteDevices(prisma, accountId, targets)
      } catch (liveError) {
        console.warn(`[ActivityMonitor] Error announcing Jellyfin viewings:`, liveError.message)
      }

      // Detect silent account mismatches (proxy sees this user watching, but
      // their connected Stremio account logs none of it - device likely signed
      // into a different account). Runs after sessions are refreshed above so
      // it compares against the freshest native watch state. Self-contained /
      // best-effort - never disturbs the metrics work around it.
      try {
        if (!onlyUserId) {
          const { checkWatchSyncMismatch } = require('./watchSyncMismatch')
          await checkWatchSyncMismatch(prisma, accountId, users)
        }
      } catch (mismatchError) {
        console.warn(`[ActivityMonitor] Error checking watch-sync mismatch:`, mismatchError.message)
      }

      // Precompute and cache metrics for all periods - every five minutes,
      // not every pass. This block ran on the one-minute tick for years while
      // its own comment said five: nine full metrics builds per account per
      // minute, which on a public instance with a handful of accounts was a
      // twelve-second burst of full CPU every sixty seconds with nobody
      // using the app. Nothing waits on this cache: /users/metrics builds on
      // demand when it misses, and live events refresh open pages.
      const lastPrecompute = metricsPrecomputeAt.get(accountId) || 0
      if (!onlyUserId && Date.now() - lastPrecompute >= METRICS_PRECOMPUTE_INTERVAL_MS) try {
        metricsPrecomputeAt.set(accountId, Date.now())
        const { setCachedMetrics, recentlyRequestedPeriods } = require('./metricsCache')
        const { buildMetricsForAccount } = require('./metricsBuilder')
        // Keep warm what someone is actually using. The dashboard's own
        // period is always included so the page nobody can avoid stays
        // instant on a fresh instance; everything else earns its place by
        // having been opened in the last six hours. A period that has not
        // is still available - it is simply built when asked for, which is
        // what a cache miss has always done.
        //
        // This matters because the long periods are most of the cost: all
        // nine took 3.9 seconds per account per pass on two years of
        // history, and 3.6 of that was 30d/90d/1y/all. Rebuilding those
        // every five minutes for nobody is the kind of work a self-hosted
        // box pays for in fan noise.
        const DEFAULT_PERIODS = ['7d']
        const INTEREST_WINDOW_MS = 6 * 60 * 60 * 1000
        const periods = [...new Set([...DEFAULT_PERIODS, ...recentlyRequestedPeriods(accountId, INTEREST_WINDOW_MS)])]

        console.log(`[ActivityMonitor] Precomputing metrics cache for account ${accountId}`)
        for (const period of periods) {
          try {
            const metrics = await buildMetricsForAccount({
              prisma,
              accountId,
              period,
              decrypt
            })
            setCachedMetrics(accountId, period, metrics)
          } catch (periodError) {
            console.warn(`[ActivityMonitor] Failed to precompute metrics for period ${period}:`, periodError.message)
          }
        }
        console.log(`[ActivityMonitor] Metrics cache updated for account ${accountId}`)
      } catch (cacheError) {
        console.warn(`[ActivityMonitor] Error during metrics cache update:`, cacheError.message)
      }
    } catch (metricsError) {
      console.error(`[ActivityMonitor] Error during metrics processing for account ${accountId}:`, metricsError.message)
      console.error(`[ActivityMonitor] Error stack:`, metricsError.stack)
    }

    // Discord notifications for watch activity are handled by sessionTracker.js,
    // which sends them when a session starts (now playing) using user-level
    // webhooks. Nothing here reads the libraries a second time for that.
  } catch (error) {
    // This used to be a bare silent catch ("don't spam logs"), which meant a
    // genuine, persistent bug here (e.g. a broken Prisma model reference)
    // was completely indistinguishable from "nothing new happened this
    // cycle" — no way to tell the difference without instrumenting this by
    // hand. A single warning per failed 5-minute cycle is not log spam.
    heartbeat('checkActivityForAccount:error', { message: error.message, stack: error.stack })
    console.warn(`[ActivityMonitor] checkActivityForAccount failed for account ${accountId}:`, error.message)
    console.warn(error.stack)
  }
}

async function checkAllAccounts(prisma, decrypt, getAccountId, INSTANCE_TYPE) {
  if (isAccountsPassRunning) {
    heartbeat('checkAllAccounts:skipped_overlap', { INSTANCE_TYPE })
    return
  }
  isAccountsPassRunning = true
  const startedAt = Date.now()
  heartbeat('checkAllAccounts:start', { INSTANCE_TYPE })
  try {
    if (INSTANCE_TYPE === 'public') {
      // Check all accounts, bounded-concurrency batches rather than fully
      // serial (slow) or fully parallel (hammers every account's provider
      // API + this box's outbound connections simultaneously) - see the
      // module-level comment on isAccountsPassRunning/ACCOUNT_BATCH_SIZE.
      const accounts = await prisma.appAccount.findMany({
        select: { id: true }
      })
      // Spread the accounts across the minute rather than starting them all
      // together. Every account still runs once a minute at its own offset;
      // what changes is the shape: a dozen-second spike of full CPU at the
      // top of each minute (on a two-core allowance, every request in that
      // window waited behind it) becomes short, spaced-out pieces of work.
      const gapMs = accounts.length > 1 ? Math.min(12000, Math.floor(45000 / accounts.length)) : 0
      for (let i = 0; i < accounts.length; i++) {
        if (i > 0 && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
        await checkActivityForAccount(prisma, accounts[i].id, decrypt, getAccountId)
      }
      heartbeat('checkAllAccounts:done', { INSTANCE_TYPE, accountCount: accounts.length, durationMs: Date.now() - startedAt })
    } else {
      // Private mode: check default account
      const DEFAULT_ACCOUNT_ID = process.env.DEFAULT_ACCOUNT_ID || 'default'
      await checkActivityForAccount(prisma, DEFAULT_ACCOUNT_ID, decrypt, getAccountId)
    }
  } catch (error) {
    // Same reasoning as above — checkActivityForAccount already logs its own
    // errors, but this outer catch existing at all meant something could
    // theoretically still fail invisibly above/around that call.
    heartbeat('checkAllAccounts:error', { message: error.message, stack: error.stack })
    console.warn(`[ActivityMonitor] checkAllAccounts failed:`, error.message)
  } finally {
    isAccountsPassRunning = false
  }
}

// Per-account timestamp of the last metrics-cache precompute (see the
// block in checkActivityForAccount).
const metricsPrecomputeAt = new Map()
const METRICS_PRECOMPUTE_INTERVAL_MS = 5 * 60 * 1000

function scheduleActivityMonitor(prisma, decrypt, getAccountId, INSTANCE_TYPE) {
  heartbeat('scheduleActivityMonitor:init', { INSTANCE_TYPE })
  monitorDeps = { prisma, decrypt, getAccountId }
  clearActivityMonitor()

  // Run immediately on startup to update library database
  checkAllAccounts(prisma, decrypt, getAccountId, INSTANCE_TYPE)

  // Then run every 1 minute
  activityTimer = setInterval(() => {
    checkAllAccounts(prisma, decrypt, getAccountId, INSTANCE_TYPE)
  }, CHECK_INTERVAL_MS)
}

// Send share notification to a user's Discord webhook
async function sendShareNotification(webhookUrl, sharerUsername, sharerEmail, sharerColorIndex, item) {
  return await notifySendShareNotification(webhookUrl, sharerUsername, sharerEmail, sharerColorIndex, item)
}

module.exports = {
  scheduleActivityMonitor,
  clearActivityMonitor,
  sendShareNotification,
  checkActivityForUser,
  CHECK_INTERVAL_MS
}