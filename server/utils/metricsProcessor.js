/**
 * Metrics Processor - Computes and stores watch snapshots and deltas
 *
 * This module processes library items to:
 * 1. Store daily snapshots (only when values change)
 * 2. Compute deltas (watch time changes) for accurate daily/weekly stats
 * 3. Store watch activity events
 * 4. Track episode-level watch history for series
 */

const { resolveSinglePoster } = require('./libraryHelpers')
const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')

/**
 * Extract season/episode from video_id
 * Handles various formats:
 * - "tt8080122:4:6" -> season 4, episode 6
 * - "kitsu:46676:1" -> season 1 (default), episode 1
 * - "tt8080122:6" -> episode 6 (no season)
 */
function extractSeasonEpisode(videoId) {
  if (!videoId) return { season: null, episode: null }

  const parts = videoId.split(':')

  // Kitsu format: "kitsu:46676:1"
  if (videoId.startsWith('kitsu:') && parts.length >= 3) {
    const episodePart = parts[parts.length - 1]
    const parsedEpisode = parseInt(episodePart, 10)
    return {
      season: 1, // Default to season 1 for anime
      episode: !isNaN(parsedEpisode) ? parsedEpisode : null
    }
  }

  // IMDb format: "tt8080122:4:6" (season:episode)
  if (parts.length >= 3 && parts[0].startsWith('tt')) {
    return {
      season: parseInt(parts[1], 10) || null,
      episode: parseInt(parts[2], 10) || null
    }
  }

  // IMDb format: "tt8080122:6" (episode only)
  if (parts.length === 2 && parts[0].startsWith('tt')) {
    return {
      season: null,
      episode: parseInt(parts[1], 10) || null
    }
  }

  return { season: null, episode: null }
}

/**
 * Check if an item was actually watched vs just bookmarked/previewed.
 * Nonzero position alone isn't reliable - Nuvio records some position for
 * brief preview/hover autoplay, and a pure library bookmark has no position
 * at all but would otherwise sail through with no gate whatsoever. Require
 * either real timeWatched, or progress that's a meaningful fraction (5%,
 * same threshold used by AIOManager) of the item's actual runtime.
 */
function isActuallyWatched(item) {
  const state = item.state || {}
  const timeWatched = Number(state.timeWatched || 0)
  if (timeWatched > 0) return true

  const progressMs = Math.max(Number(state.timeOffset || 0), Number(state.overallTimeWatched || 0))
  if (progressMs <= 0) return false

  const duration = Number(state.duration || 0)
  if (duration > 0) {
    return (progressMs / duration) > 0.05
  }

  return !!(state.video_id && state.video_id.trim() !== '')
}

/**
 * Record episode watch in history (for series items)
 */
async function recordEpisodeWatch(prisma, accountId, userId, item) {
  try {
    // Only process series items with video_id and real watch progress
    if (item.type !== 'series' || !item.state?.video_id || !isActuallyWatched(item)) return

    const videoId = item.state.video_id
    const showId = item._id || item.id
    const showName = item.name || 'Unknown Show'
    const poster = await resolveSinglePoster(showId, 'series', item.poster || null)
    const profileLabel = item.state?.nuvioProfile || null
    const { season, episode } = extractSeasonEpisode(videoId)

    // Get watch date from item
    // IMPORTANT: Only use state.lastWatched - this is the actual watch timestamp
    // Do NOT use _mtime - that's just when the library item was modified (e.g., added to library)
    let watchedAt = new Date()
    if (item.state?.lastWatched) {
      const d = new Date(item.state.lastWatched)
      if (!isNaN(d.getTime())) watchedAt = d
    }

    const accountIdValue = accountId || 'default'

    // durationSeconds was previously never written here at all - it only ever
    // got "backfilled" in-memory for the Activity feed's API response
    // (metricsBuilder.js's mergeCrossPipelineDuplicates), never persisted to
    // this row. WatchSession has the real duration but tracks one row per
    // (user, show) - itemId is the show's own base ID, not per-episode - so
    // it only reflects THIS episode's duration while it's the one
    // currently/most-recently playing. Confirm videoId still matches before
    // trusting it, so backfilling S1E2's history row doesn't grab S1E3's
    // duration once the session has moved on to the next episode. max()
    // against the row's own existing value for the same reason every other
    // duration merge in this codebase does - never let a later, possibly
    // stale/lower reading regress an already-recorded higher one.
    const [existing, session] = await Promise.all([
      prisma.episodeWatchHistory.findUnique({
        where: { accountId_userId_videoId: { accountId: accountIdValue, userId, videoId } },
        select: { durationSeconds: true }
      }),
      prisma.watchSession.findUnique({
        where: { accountId_userId_itemId: { accountId: accountIdValue, userId, itemId: showId } },
        select: { videoId: true, durationSeconds: true }
      })
    ])
    const sessionDuration = session?.videoId === videoId ? (session.durationSeconds || 0) : 0
    const durationSeconds = Math.max(existing?.durationSeconds || 0, sessionDuration) || undefined

    // Upsert the episode watch (updates watchedAt if already exists)
    await prisma.episodeWatchHistory.upsert({
      where: {
        accountId_userId_videoId: {
          accountId: accountIdValue,
          userId,
          videoId
        }
      },
      create: {
        accountId: accountIdValue,
        userId,
        showId,
        showName,
        videoId,
        season,
        episode,
        poster,
        profileLabel,
        watchedAt,
        durationSeconds
      },
      update: {
        watchedAt, // Update watch time if re-watching
        showName, // Update in case show name changed
        poster, // Update in case poster changed
        profileLabel,
        durationSeconds
      }
    })

    return true
  } catch (error) {
    // Silently fail - episode history is optional
    if (error.code !== 'P2002') { // Ignore unique constraint errors
      console.warn(`[MetricsProcessor] Error recording episode watch:`, error.message)
    }
    return false
  }
}

/**
 * Record movie watch in history (for movie items) — the movie equivalent
 * of recordEpisodeWatch above. WatchActivity records that a movie was
 * watched for aggregate counts, but has no title/poster to display; this
 * captures that metadata the same way EpisodeWatchHistory does for series.
 */
async function recordMovieWatch(prisma, accountId, userId, item) {
  try {
    // Only process movie items with real watch progress - a bare library
    // bookmark (no video_id, no position) was previously sailing through
    // here unconditionally, since the only check was item.type === 'movie'
    if (item.type !== 'movie' || !isActuallyWatched(item)) return false

    const itemId = item._id || item.id
    if (!itemId) return false

    const itemName = item.name || 'Unknown Movie'
    const poster = await resolveSinglePoster(itemId, 'movie', item.poster || null)
    const profileLabel = item.state?.nuvioProfile || null

    // Get watch date from item
    // IMPORTANT: Only use state.lastWatched - this is the actual watch timestamp
    let watchedAt = new Date()
    if (item.state?.lastWatched) {
      const d = new Date(item.state.lastWatched)
      if (!isNaN(d.getTime())) watchedAt = d
    }

    const accountIdValue = accountId || 'default'

    // durationSeconds was previously never written here at all - it only ever
    // got "backfilled" in-memory for the Activity feed's API response
    // (metricsBuilder.js's mergeCrossPipelineDuplicates), never persisted to
    // this row. WatchSession has the real duration, keyed the same way for
    // movies (one row per (user, item)). max() against the row's own
    // existing value for the same reason every other duration merge in this
    // codebase does - never let a later, possibly stale/lower reading
    // regress an already-recorded higher one.
    const [existing, session] = await Promise.all([
      prisma.movieWatchHistory.findUnique({
        where: { accountId_userId_itemId: { accountId: accountIdValue, userId, itemId } },
        select: { durationSeconds: true }
      }),
      prisma.watchSession.findUnique({
        where: { accountId_userId_itemId: { accountId: accountIdValue, userId, itemId } },
        select: { durationSeconds: true }
      })
    ])
    const durationSeconds = Math.max(existing?.durationSeconds || 0, session?.durationSeconds || 0) || undefined

    // Upsert the movie watch (updates watchedAt if already exists)
    await prisma.movieWatchHistory.upsert({
      where: {
        accountId_userId_itemId: {
          accountId: accountIdValue,
          userId,
          itemId
        }
      },
      create: {
        accountId: accountIdValue,
        userId,
        itemId,
        itemName,
        poster,
        profileLabel,
        watchedAt,
        durationSeconds
      },
      update: {
        watchedAt, // Update watch time if re-watching
        itemName, // Update in case name changed
        poster, // Update in case poster changed
        profileLabel,
        durationSeconds
      }
    })

    return true
  } catch (error) {
    // Silently fail - movie history is optional
    if (error.code !== 'P2002') { // Ignore unique constraint errors
      console.warn(`[MetricsProcessor] Error recording movie watch:`, error.message)
    }
    return false
  }
}

/**
 * Get the most recent snapshot for an item on or before today.
 * This lets us compute deltas within the same day as well as across days.
 */
async function getPreviousSnapshot(prisma, accountId, userId, itemId, today, timeZone) {
  const todayDate = getAccountDateString(today, timeZone)

  try {
    const snapshot = await prisma.watchSnapshot.findFirst({
      where: {
        accountId: accountId || 'default',
        userId,
        itemId,
        date: {
          lte: new Date(todayDate)
        }
      },
      orderBy: {
        date: 'desc'
      }
    })
    return snapshot
  } catch (error) {
    console.warn(
      `[MetricsProcessor] Error fetching previous snapshot for ${userId}/${itemId}:`,
      error.message
    )
    return null
  }
}

/**
 * Highest overallTimeWatched ever recorded for this (user, item), across all
 * history - not just the single most recent snapshot. Nuvio's multi-profile
 * merge (server/providers/nuvio.js) falls back to an empty progress array
 * for a profile whose sync_pull_watch_progress call fails transiently on a
 * given poll; if a second, unrelated profile happens to have watched the
 * same item long ago and is fetched successfully that same poll, its old,
 * frozen reading can briefly become the only available data for that item -
 * a real regression that self-corrects the moment the active profile's next
 * poll succeeds. Comparing against the single prior snapshot treats that
 * recovery-back-up-to-an-old-value as new watching (confirmed real case:
 * a snapshot dropped from 6543120 to 909494 across two profile-fetch
 * failures, then "recovered" to exactly 6389553 - a value already recorded
 * six days earlier - producing a bogus 5480-second delta). Comparing
 * against the running max instead means recovering to a previously-seen
 * value can never register as progress, since the max already accounts for
 * it. This can only ever reduce a delta relative to the old single-snapshot
 * comparison, never inflate one - a real rewatch that resets progress to
 * near-zero and climbs back up would also be suppressed, which is an
 * accepted tradeoff consistent with this app's existing "one History row
 * per title, a rewatch moves the card rather than duplicating it" design.
 */
async function getMaxOverallTimeWatched(prisma, accountId, userId, itemId) {
  try {
    const snapshots = await prisma.watchSnapshot.findMany({
      where: { accountId: accountId || 'default', userId, itemId },
      select: { overallTimeWatched: true }
    })
    let max = null
    for (const s of snapshots) {
      if (!s.overallTimeWatched) continue
      const value = BigInt(s.overallTimeWatched)
      if (max === null || value > max) max = value
    }
    return max
  } catch (error) {
    console.warn(
      `[MetricsProcessor] Error fetching max snapshot for ${userId}/${itemId}:`,
      error.message
    )
    return null
  }
}

/**
 * Check if snapshot values have changed
 */
function hasChanged(previous, current) {
  if (!previous) return true // First time seeing this item

  const prevOverall = previous.overallTimeWatched ? BigInt(previous.overallTimeWatched) : 0n
  const currOverall = current.overallTimeWatched ? BigInt(current.overallTimeWatched) : 0n

  const prevOffset = previous.timeOffset ? BigInt(previous.timeOffset) : 0n
  const currOffset = current.timeOffset ? BigInt(current.timeOffset) : 0n

  // Changed if overallTimeWatched or timeOffset changed
  return prevOverall !== currOverall || prevOffset !== currOffset
}

/**
 * Process a single library item and store snapshot/delta
 */
async function processLibraryItem(prisma, accountId, userId, item, today) {
  try {
    const itemId = item._id || item.id
    if (!itemId || !item.type) return { snapshotCreated: false, activityCreated: false }

    const accountIdValue = accountId || 'default'
    const timeZone = await resolveAccountTimezone(prisma, accountIdValue)
    const todayDate = getAccountDateString(today, timeZone)

    // Get previous snapshot (for baseline comparison)
    const previous = await getPreviousSnapshot(prisma, accountIdValue, userId, itemId, today, timeZone)

    // Current state
    const current = {
      overallTimeWatched: item.state?.overallTimeWatched ? String(item.state.overallTimeWatched) : null,
      timeOffset: item.state?.timeOffset ? String(item.state.timeOffset) : null,
      lastWatched: item.state?.lastWatched ? new Date(item.state.lastWatched) : null,
      mtime: item._mtime ? new Date(item._mtime) : null
    }

    // Always fetch the latest snapshot for today (if it exists)
    let latestSnapshot = await prisma.watchSnapshot.findFirst({
      where: {
        accountId: accountIdValue,
        userId,
        itemId,
        date: new Date(todayDate)
      }
    })

    // If no snapshot for today exists, use previous (from yesterday or earlier)
    if (!latestSnapshot) {
      latestSnapshot = previous
    }

    // Store the old snapshot value for delta calculation
    const oldSnapshotValue = latestSnapshot?.overallTimeWatched || null

    let snapshotCreated = false
    let activityCreated = false

    // Check if current library value differs from latest snapshot
    const snapshotChanged = !latestSnapshot || 
      !latestSnapshot.overallTimeWatched || 
      BigInt(latestSnapshot.overallTimeWatched) !== BigInt(current.overallTimeWatched || '0')

    // Decide whether to record an activity delta - this part is pure
    // decision-making (reads only), the actual writes happen atomically
    // below.
    let activityDeltaSeconds = null
    if (current.overallTimeWatched && snapshotChanged) {
      let totalDeltaSeconds = 0

      if (oldSnapshotValue) {
        // Existing item: calculate delta from the highest overallTimeWatched
        // ever recorded for this item, not just the single most recent
        // snapshot - see getMaxOverallTimeWatched's comment for why. Falls
        // back to the plain prior-snapshot comparison only in the
        // practically-unreachable case where the max lookup itself fails.
        const maxSeen = await getMaxOverallTimeWatched(prisma, accountIdValue, userId, itemId)
        const deltaBaseline = maxSeen !== null ? maxSeen : BigInt(oldSnapshotValue)
        const currOverall = BigInt(current.overallTimeWatched)
        const totalDeltaMs = currOverall - deltaBaseline

        // Only create activity if delta is significant (> 60 seconds) and positive
        if (totalDeltaMs > 0) {
          totalDeltaSeconds = Number(totalDeltaMs / 1000n)
        }
      } else {
        // First-time ever seeing this item (no prior snapshot exists): we
        // have no real baseline to compute an incremental delta against.
        // overallTimeWatched can represent CUMULATIVE watch time across
        // many past sessions/episodes, not "new today" - treating the
        // whole absolute value as today's delta produced wildly inflated
        // one-time entries (confirmed: a 16.5-hour single entry for one
        // series, created in a single instant). Just establish the
        // baseline with zero delta here; real incremental watching gets
        // captured correctly starting from the next observation onward.
        totalDeltaSeconds = 0
      }

      // Get the most recent activity for this item to see when we last recorded
      // We only want to subtract activities that were recorded AFTER the snapshot baseline was set
      const mostRecentActivity = await prisma.watchActivity.findFirst({
        where: {
          accountId: accountIdValue,
          userId,
          itemId,
          date: new Date(todayDate)
        },
        orderBy: {
          createdAt: 'desc'
        }
      })

      // If we have a recent activity, check if it was created very recently (within last 30 seconds)
      // This prevents double-counting if we just created an activity in a previous processing cycle
      let shouldSubtractRecent = false
      let recentRecordedSeconds = 0

      if (mostRecentActivity) {
        const secondsSinceLastActivity = (new Date() - mostRecentActivity.createdAt) / 1000
        // Only subtract if activity was created in the last 30 seconds (very recent, might be duplicate)
        if (secondsSinceLastActivity < 30) {
          shouldSubtractRecent = true
          recentRecordedSeconds = mostRecentActivity.watchTimeSeconds
        }
      }

      // Calculate remaining delta: total delta minus what we've very recently recorded (if any)
      const remainingDeltaSeconds = totalDeltaSeconds - recentRecordedSeconds

      // Record the remaining delta (if >= 60 seconds)
      // Note: We record the FULL delta, not just remaining, because:
      // 1. The snapshot represents the baseline we've accounted for
      // 2. When snapshot updates, it means library increased, so we should record that increase
      // 3. The only exception is if we JUST created an activity (within 30 seconds), then we skip to avoid duplicates
      if (remainingDeltaSeconds >= 60 && !shouldSubtractRecent) {
        activityDeltaSeconds = totalDeltaSeconds
      } else if (shouldSubtractRecent) {
        // Log when we skip creating activity due to very recent activity
        console.log(`[MetricsProcessor] Skipping activity creation for ${userId}/${itemId}: recent activity created ${Math.floor((new Date() - mostRecentActivity.createdAt) / 1000)}s ago`)
      }
    }

    // Record the activity delta (if any) and advance the snapshot baseline
    // together in one transaction. These used to be two separate writes -
    // if the process was interrupted between them (e.g. a container
    // restart landing mid-cycle, which the activity monitor's immediate
    // on-boot poll makes a real possibility whenever a deploy happens
    // while a previous cycle's snapshot write hadn't committed yet), the
    // activity got recorded but the baseline never advanced - so the next
    // poll recomputed and recorded the EXACT SAME delta again. Confirmed
    // with real data: the same item's delta appearing 2-3 times
    // identically within one day, wildly inflating Watch Time Today.
    // Wrapping both writes atomically means either both land or neither
    // does, so a mid-cycle interruption can no longer leave the delta
    // recorded without the baseline that's supposed to prevent recording
    // it again.
    if (activityDeltaSeconds !== null || (snapshotChanged && current.overallTimeWatched)) {
      const ops = []
      if (activityDeltaSeconds !== null) {
        ops.push(prisma.watchActivity.create({
          data: {
            accountId: accountIdValue,
            userId,
            itemId,
            date: new Date(todayDate),
            watchTimeSeconds: activityDeltaSeconds,
            itemType: item.type
          }
        }))
      }
      if (snapshotChanged && current.overallTimeWatched) {
        ops.push(prisma.watchSnapshot.upsert({
          where: {
            accountId_userId_itemId_date: {
              accountId: accountIdValue,
              userId,
              itemId,
              date: new Date(todayDate)
            }
          },
          create: {
            accountId: accountIdValue,
            userId,
            itemId,
            date: new Date(todayDate),
            overallTimeWatched: current.overallTimeWatched,
            timeOffset: current.timeOffset,
            lastWatched: current.lastWatched,
            mtime: current.mtime
          },
          update: {
            overallTimeWatched: current.overallTimeWatched,
            timeOffset: current.timeOffset,
            lastWatched: current.lastWatched,
            mtime: current.mtime
          }
        }))
      }

      try {
        await prisma.$transaction(ops)
        if (activityDeltaSeconds !== null) activityCreated = true
        if (snapshotChanged && current.overallTimeWatched) {
          snapshotCreated = true
          // Debug: Log snapshot updates for items with significant changes
          if (latestSnapshot && latestSnapshot.overallTimeWatched) {
            const deltaMs = BigInt(current.overallTimeWatched) - BigInt(latestSnapshot.overallTimeWatched)
            const deltaSeconds = Number(deltaMs / 1000n)
            if (deltaSeconds >= 60) {
              console.log(`[MetricsProcessor] Updated snapshot for ${userId}/${itemId}: ${latestSnapshot.overallTimeWatched} -> ${current.overallTimeWatched} (delta: ${deltaSeconds}s, activity created: ${activityCreated})`)
            }
          }
        }
      } catch (error) {
        // Ignore duplicate key errors (idempotent)
        if (!error.message.includes('Unique constraint')) {
          console.warn(`[MetricsProcessor] Error recording activity/snapshot for ${userId}/${itemId}:`, error.message)
          console.warn(`[MetricsProcessor] Error stack:`, error.stack)
        }
      }
    }

    // Record episode watch history for series items, or movie watch history
    // for movies. This runs regardless of whether snapshot changed, to
    // capture all watched items.
    if (item.type === 'series' && item.state?.video_id) {
      await recordEpisodeWatch(prisma, accountIdValue, userId, item)
    } else if (item.type === 'movie') {
      await recordMovieWatch(prisma, accountIdValue, userId, item)
    }

    return { snapshotCreated, activityCreated }
  } catch (error) {
    console.warn(`[MetricsProcessor] Error processing item ${item._id || item.id} for user ${userId}:`, error.message)
    return { snapshotCreated: false, activityCreated: false }
  }
}

/**
 * Process all library items for a user
 */
async function processUserLibrary(prisma, accountId, userId, library, today = new Date()) {
  if (!library || !Array.isArray(library) || library.length === 0) {
    console.log(`[MetricsProcessor] No library items for user ${userId}`)
    return { snapshotsCreated: 0, activitiesCreated: 0 }
  }

  let processed = 0
  let errors = 0
  let snapshotsCreated = 0
  let activitiesCreated = 0

  for (const item of library) {
    try {
      const result = await processLibraryItem(prisma, accountId, userId, item, today)
      processed++
      if (result?.snapshotCreated) snapshotsCreated++
      if (result?.activityCreated) activitiesCreated++
    } catch (error) {
      errors++
      console.warn(`[MetricsProcessor] Error processing item ${item._id || item.id} for user ${userId}:`, error.message)
    }
  }

  if (processed > 0 || errors > 0) {
    console.log(`[MetricsProcessor] User ${userId}: Processed ${processed} items, ${snapshotsCreated} snapshots, ${activitiesCreated} activities (${errors} errors)`)
  }

  return { snapshotsCreated, activitiesCreated }
}

/**
 * Process metrics for all users in an account
 */
async function processAccountMetrics(prisma, accountId, users, getLibraryForUser, today = new Date()) {
  const accountIdValue = accountId || 'default'
  let totalProcessed = 0
  let totalErrors = 0
  let totalSnapshots = 0
  let totalActivities = 0

  console.log(`[MetricsProcessor] Processing metrics for account ${accountIdValue}, ${users.length} users`)

  for (const user of users) {
    try {
      const library = await getLibraryForUser(user)
      if (library && Array.isArray(library) && library.length > 0) {
        console.log(`[MetricsProcessor] Processing ${library.length} items for user ${user.id}`)
        const result = await processUserLibrary(prisma, accountIdValue, user.id, library, today)
        totalProcessed += library.length
        if (result) {
          totalSnapshots += result.snapshotsCreated || 0
          totalActivities += result.activitiesCreated || 0
        }
      } else {
        console.log(`[MetricsProcessor] No library items for user ${user.id}`)
      }
    } catch (error) {
      totalErrors++
      console.error(`[MetricsProcessor] Error processing user ${user.id}:`, error.message)
      console.error(`[MetricsProcessor] Error stack:`, error.stack)
    }
  }

  console.log(`[MetricsProcessor] Account ${accountIdValue}: Processed ${totalProcessed} items across ${users.length} users, ${totalSnapshots} snapshots, ${totalActivities} activities (${totalErrors} errors)`)
}

module.exports = {
  processLibraryItem,
  processUserLibrary,
  processAccountMetrics,
  getPreviousSnapshot
}

