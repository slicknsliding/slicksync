// Activity monitor - checks for new watch activity and sends Discord notifications
const { StremioAPIClient } = require('stremio-api-client')
const { setCachedLibrary } = require('./libraryCache')
const { processAccountSessions } = require('./sessionTracker')
const { fetchKitsuMetadata } = require('./kitsuUtils')
const { sendShareNotification: notifySendShareNotification } = require('./notify')

const CHECK_INTERVAL_MS = 1 * 60 * 1000 // 1 minute

let activityTimer = null
// Track notified items: Map<accountId, Set<itemId>>
const notifiedItems = new Map()

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
    fs.appendFileSync('/app/data/activity-monitor-debug.log', line)
  } catch {}
}

function clearActivityMonitor() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
  notifiedItems.clear()
}

function getWatchDate(item) {
  // IMPORTANT: Only use state.lastWatched - this is the actual watch timestamp
  // Do NOT use _mtime - that's just when the library item was modified (e.g., added to library)
  // Do NOT use _ctime - that's creation time
  if (item.state?.lastWatched) {
    const d = new Date(item.state.lastWatched)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

function isActuallyWatched(item) {
  // Check if the item was actually watched vs just previewed/bookmarked.
  // Nuvio records a nonzero position even for brief hover/preview autoplay
  // while browsing the library - so overallTimeWatched/timeOffset > 0 alone
  // is NOT reliable "watched" evidence on its own. Require it to be a
  // meaningful fraction of the item's actual runtime instead.
  const state = item.state || {}

  const timeWatched = Number(state.timeWatched || 0)
  if (timeWatched > 0) return true

  const progressMs = Math.max(Number(state.timeOffset || 0), Number(state.overallTimeWatched || 0))
  if (progressMs <= 0) return false

  const duration = Number(state.duration || 0)
  if (duration > 0) {
    // Same 5% threshold used by AIOManager - filters out preview-autoplay
    // noise while still catching real partial watches
    return (progressMs / duration) > 0.05
  }

  // No duration to compute a ratio against - fall back to requiring a
  // real video_id alongside the progress (e.g. live TV/IPTV items report
  // duration: 0 but a genuine position)
  return !!(state.video_id && state.video_id.trim() !== '')
}

async function checkActivityForAccount(prisma, accountId, decrypt, getAccountId) {
  heartbeat('checkActivityForAccount:start', { accountId })
  try {
    // Get account sync config to check for webhook URL
    const account = await prisma.appAccount.findUnique({
      where: { id: accountId },
      select: { sync: true }
    })

    heartbeat('checkActivityForAccount:account_lookup_done', { found: !!account })
    if (!account) return

    let syncCfg = account.sync || null
    if (syncCfg && typeof syncCfg === 'string') {
      try { syncCfg = JSON.parse(syncCfg) } catch { syncCfg = null }
    }

    const webhookUrl = syncCfg?.webhookUrl

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
        colorIndex: true,
        notifyOnWatch: true,
        discordWebhookUrl: true
      }
    })

    if (users.length === 0) return

    heartbeat('checkActivityForAccount:users_found', { count: users.length })

    // Process metrics for all users (regardless of webhook configuration)
    // This runs every 5 minutes to compute accurate watch time deltas
    try {
      const { processAccountMetrics } = require('./metricsProcessor')
      const { getCachedLibrary } = require('./libraryCache')
      const { makeCreateProvider } = require('../providers')
      const { encrypt } = require('./encryption')
      const createProvider = makeCreateProvider({ prisma, encrypt })

      // Helper function to get library for a user via their provider
      // (Stremio or Nuvio); falls back to cache if no credentials or on error
      const getLibraryForUser = async (user) => {
        try {
          const mockReq = { appAccountId: accountId }
          const provider = createProvider(user, { decrypt: (t) => decrypt(t, mockReq), req: mockReq })
          if (!provider) {
            // No usable credentials, use cached library (library-email.json)
            heartbeat('getLibraryForUser:no_provider', { userId: user.id })
            return getCachedLibrary(accountId, user) || []
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

          return library || []
        } catch (error) {
          heartbeat('getLibraryForUser:live_fetch_failed', { userId: user.id, message: error.message })
          console.warn(`[ActivityMonitor] Failed to fetch library for user ${user.id}:`, error.message)
          // Fallback to cache if API call fails
          const cachedLibrary = getCachedLibrary(accountId, user)
          return cachedLibrary || []
        }
      }

      // Process metrics for all users
      console.log(`[ActivityMonitor] Starting metrics processing for account ${accountId}, ${users.length} users`)
      heartbeat('processAccountMetrics:before')
      await processAccountMetrics(prisma, accountId, users, getLibraryForUser, new Date())
      heartbeat('processAccountMetrics:after')
      console.log(`[ActivityMonitor] Completed metrics processing for account ${accountId}`)

      // Process watch sessions (track start/end times)
      try {
        heartbeat('processAccountSessions:before')
        await processAccountSessions(prisma, accountId, users, getLibraryForUser, new Date())
        heartbeat('processAccountSessions:after')
      } catch (sessionError) {
        heartbeat('processAccountSessions:error', { message: sessionError.message, stack: sessionError.stack })
        console.warn(`[ActivityMonitor] Error processing sessions:`, sessionError.message)
      }

      // Precompute and cache metrics for all periods (runs every 5 minutes)
      // This ensures fresh data is available for both /users/metrics and /ext/metrics.json
      try {
        const { setCachedMetrics } = require('./metricsCache')
        const { buildMetricsForAccount } = require('./metricsBuilder')
        const periods = ['1h', '12h', '1d', '3d', '7d', '30d', '90d', '1y', 'all']

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

    // Only process Discord notifications if webhook is configured
    if (!webhookUrl) return

    const now = Date.now()
    const cutoffTime = now - CHECK_INTERVAL_MS
    const newActivities = []

    // Initialize notified items set for this account if needed
    if (!notifiedItems.has(accountId)) {
      notifiedItems.set(accountId, new Set())
    }
    const accountNotifiedItems = notifiedItems.get(accountId)

    // Check each user with usable provider credentials for new activity to notify
    const { makeCreateProvider: makeCreateProviderNotify } = require('../providers')
    const { encrypt: encryptNotify } = require('./encryption')
    const createProviderNotify = makeCreateProviderNotify({ prisma, encrypt: encryptNotify })
    const usersWithAuth = users.filter(u => u.stremioAuthKey || (u.nuvioRefreshToken && u.nuvioUserId))

    for (const user of usersWithAuth) {
      try {
        // Create a mock request object for decrypt
        const mockReq = { appAccountId: accountId }
        const provider = createProviderNotify(user, { decrypt: (t) => decrypt(t, mockReq), req: mockReq })
        if (!provider) continue

        const libraryItems = await provider.getLibrary()

        let library = Array.isArray(libraryItems) ? libraryItems : (libraryItems?.result || libraryItems?.library || [])

        // Cache the library data for metrics queries
        if (Array.isArray(library) && library.length > 0) {
          setCachedLibrary(accountId, user, library)
        }

        // Check each item for recent activity
        for (const item of library) {
          const watchDate = getWatchDate(item)
          if (!watchDate || watchDate < cutoffTime) continue // Not recent enough

          // Skip items that weren't actually watched (e.g., just added to library from share)
          if (!isActuallyWatched(item)) continue

          // Create unique item ID (for movies: just _id, for series: _id:season:episode)
          let itemId = item._id || item.id
          if (item.type === 'series' && item.state?.season !== undefined && item.state?.episode !== undefined) {
            itemId = `${item._id}:${item.state.season}:${item.state.episode}`
          }

          // Check if we've already notified about this item
          const notificationKey = `${user.id}:${itemId}`
          if (accountNotifiedItems.has(notificationKey)) continue

          // Extract season/episode from video_id if available
          // Format: "tt8080122:4:6" = season 4, episode 6
          // Format: "tt8080122:6" = episode 6 only (no season or season 0)
          let season = item.state?.season
          let episode = item.state?.episode

          if (item.state?.video_id) {
            const videoId = item.state.video_id
            const videoIdParts = videoId.split(':')

            // Special handling for kitsu ids:
            // - Format: "kitsu:46676:1" -> episode = last segment ("1"), season from Kitsu API title
            if (videoId.startsWith('kitsu:') && videoIdParts.length >= 2) {
              const kitsuId = videoIdParts[1] // e.g., "46676"
              const episodePart = videoIdParts[videoIdParts.length - 1]
              const parsedEpisode = parseInt(episodePart, 10)
              if (!isNaN(parsedEpisode)) {
                episode = parsedEpisode
              }
              // Fetch season from Kitsu API title (e.g., "My Hero Academia Season 3" -> 3)
              const kitsuData = await fetchKitsuMetadata(kitsuId)
              if (kitsuData && kitsuData.season !== null) {
                season = kitsuData.season
              }
            } else {
              // Default handling for normal ids:
              // Format: "tt8080122:4:6" (2 colons = 3 parts)
              if (videoIdParts.length === 3) {
                season = parseInt(videoIdParts[1], 10) || season
                episode = parseInt(videoIdParts[2], 10) || episode
              }
              // Format: "tt8080122:6" (1 colon = 2 parts)
              else if (videoIdParts.length === 2) {
                episode = parseInt(videoIdParts[1], 10) || episode
                // No season specified, keep existing or default to 0
                if (season === undefined) season = 0
              }
            }
          }

          // This is a new activity!
          newActivities.push({
            user: {
              id: user.id,
              username: user.username || user.email,
              email: user.email,
              colorIndex: user.colorIndex || 0
            },
            item: {
              id: itemId,
              _id: item._id || item.id, // Original ID for link generation
              name: item.name,
              type: item.type,
              year: item.year,
              poster: item.poster,
              season: season,
              episode: episode,
              video_id: item.state?.video_id // Keep video_id for reference
            },
            watchDate: watchDate,
            notificationKey: notificationKey
          })

          // Mark as notified
          accountNotifiedItems.add(notificationKey)
        }
      } catch (error) {
        // Skip user if there's an error fetching their library, but log it —
        // silently skipping made a real, persistent failure indistinguishable
        // from "this user has nothing new to report" for weeks.
        console.warn(`[ActivityMonitor] Skipping user ${user.id} due to error:`, error.message)
        continue
      }
    }

    // Note: Discord notifications for watch activity are now handled by sessionTracker.js
    // which sends notifications when a session starts (now playing) using user-level webhooks.
    // The old account-level activity notification has been disabled to avoid duplicate notifications.
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
  heartbeat('checkAllAccounts:start', { INSTANCE_TYPE })
  try {
    if (INSTANCE_TYPE === 'public') {
      // Check all accounts
      const accounts = await prisma.appAccount.findMany({
        select: { id: true }
      })
      for (const account of accounts) {
        await checkActivityForAccount(prisma, account.id, decrypt, getAccountId)
      }
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
  }
}

function scheduleActivityMonitor(prisma, decrypt, getAccountId, INSTANCE_TYPE) {
  heartbeat('scheduleActivityMonitor:init', { INSTANCE_TYPE })
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
  CHECK_INTERVAL_MS
}