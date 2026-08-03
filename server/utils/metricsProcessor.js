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
const { findDebridServiceForWatch, hasConfirmedProxyPlayback } = require('./debridDetection')
const { postDiscord } = require('./notify')
const { getUserAvatarUrl } = require('./avatarUtils')
const { notifyPushForType } = require('./pushNotifications')

// Real completion for a library item: did playback reach (near) the end?
// From the item's own position vs runtime (state.timeOffset / state.duration),
// the same fields the duration logic reads. Returns true (finished), false
// (real position but well short), or null (no position/runtime data to judge).
// Unlike duration-crediting, this is safe to read at any single point - a
// position near the end IS "finished" regardless of when it got there, so no
// first-observation caveat applies here. 90% threshold accounts for end
// credits / a few unwatched trailing seconds.
const COMPLETE_RATIO = 0.9
function computeCompleted(state) {
  const pos = Number(state?.timeOffset ?? NaN)
  const dur = Number(state?.duration ?? NaN)
  if (Number.isNaN(pos) || Number.isNaN(dur) || dur <= 0 || pos <= 0) return null
  return pos / dur >= COMPLETE_RATIO
}

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
// When a library item has no duration to compute a real percentage against,
// this is the minimum absolute progress required to still count as watched.
// Deliberately generous (5 real minutes) so a legitimately short watch of
// something whose provider never reports a duration still counts - this
// exists to reject near-zero/placeholder progress, not to raise the bar for
// genuine short watches.
const MIN_PROGRESS_MS_NO_DURATION = 5 * 60 * 1000

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

  // No duration to compute a ratio against - require real minimum progress
  // instead of merely "video_id is present". Confirmed real case
  // 2026-07-30: ~800 bulk-imported "mark as watched" library entries (a
  // real video_id, backdated lastWatched, some small/placeholder
  // overallTimeWatched, but no duration ever recorded) sailed through this
  // fallback as if they were genuine watches - state.video_id being
  // non-empty is true for essentially every real library item, so it was
  // never actually filtering anything.
  return progressMs >= MIN_PROGRESS_MS_NO_DURATION
}

// Fires a "watched X" notification (Discord + push) for a brand-new
// watch-history row that the proxy pipeline never had a chance to notify
// about — content that never routed through the monitored AIOStreams proxy
// at all (usenet via newznab is the confirmed real case; see this repo's
// CLAUDE.md on the two watch-tracking pipelines). The proxy's own instant
// "started watching" ping (proxyStreamMonitor.js -> sessionTracker.js's
// sendSessionStartNotification) already covers everything that DOES route
// through it, so callers only invoke this when there's no WatchSession row
// for the item at all — otherwise proxy-tracked watches would get notified
// twice: once live, and again once native catches up ~1min later.
// Deliberately worded "watched," not "started watching" - by the time
// native's poll notices a new row, playback may already be well underway or
// finished, so "started" would be misleading here in a way it isn't for the
// proxy's real-time signal.
async function notifyNativeWatchDetected(prisma, accountId, { title, poster, itemType, season, episode, userId, users = [] }) {
  try {
    const accountIdValue = accountId || 'default'
    const account = await prisma.appAccount.findUnique({ where: { id: accountIdValue }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (!cfg || typeof cfg !== 'object' || cfg.notifyOnActivity !== true) return

    const user = users.find((u) => u.id === userId)
    // Per-user opt-out: this specific user's watch activity doesn't notify
    // at all, regardless of the account-level toggle above.
    if (user && user.notifyOnWatch === false) return

    const whoName = user?.username || user?.email || 'Someone'
    const epLabel = (itemType === 'series' && season != null && episode != null)
      ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : ''

    // A user's own personal webhook (Settings, in their self-service panel)
    // takes over from the shared account webhook for their own activity —
    // lets each household member route their own pings to their own
    // channel/DM instead of (or as well as) the shared family one.
    const targetWebhookUrl = user?.discordWebhookUrl || cfg.webhookUrl
    if (targetWebhookUrl) {
      const avatarUrl = user ? await getUserAvatarUrl(user.username, user.email, user.colorIndex) : null
      const embed = {
        title: `${title}${epLabel}`,
        author: { name: `${whoName} watched`, icon_url: avatarUrl || undefined },
        color: 0x8b7ec8,
        timestamp: new Date().toISOString(),
      }
      if (poster) embed.thumbnail = { url: poster }
      let appVersion = process.env.NEXT_PUBLIC_APP_VERSION || process.env.APP_VERSION || ''
      if (!appVersion) { try { appVersion = require('../../package.json')?.version || '' } catch {} }
      if (appVersion) embed.footer = { text: `SlickSync v${appVersion}` }
      await postDiscord(targetWebhookUrl, null, {
        embeds: [embed],
        avatar_url: 'https://raw.githubusercontent.com/iamneur0/slicksync/refs/heads/main/client/public/logo-black.png',
      })
    }

    await notifyPushForType(prisma, accountIdValue, 'notifyOnActivity', {
      title: `${whoName} watched`,
      body: `${title}${epLabel}`,
      icon: poster || '/android-chrome-192x192.png',
      url: '/activity',
    })
  } catch (error) {
    console.warn('[MetricsProcessor] Failed to send native watch-detected notification:', error.message)
  }
}

/**
 * Record episode watch in history (for series items)
 */
async function recordEpisodeWatch(prisma, accountId, userId, item, users = []) {
  try {
    // Only process series items with a video_id
    if (item.type !== 'series' || !item.state?.video_id) return
    // No title at all from the provider's own library (see sessionTracker.js's
    // matching guard) - nothing accurate to record, skip rather than write a
    // literal "Unknown Show" history row.
    if (!item.name || !String(item.name).trim()) return

    const videoId = item.state.video_id
    const showId = item._id || item.id
    const showName = item.name
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

    // See recordMovieWatch's matching comment - isActuallyWatched()'s
    // 5%-of-runtime threshold has a false negative on short-but-real
    // debrid/torrent watches (a movie/episode stopped a few minutes into a
    // long runtime never crosses 5%). hasConfirmedProxyPlayback rescues
    // that case using independent proof from the proxy pipeline.
    if (!isActuallyWatched(item)) {
      const confirmedByProxy = await hasConfirmedProxyPlayback(prisma, {
        accountId: accountIdValue, userId, title: showName, watchedAt, users
      })
      if (!confirmedByProxy) return
    }

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
        select: { durationSeconds: true, debridService: true, episodeName: true, completed: true }
      }),
      prisma.watchSession.findUnique({
        where: { accountId_userId_itemId: { accountId: accountIdValue, userId, itemId: showId } },
        select: { videoId: true, durationSeconds: true }
      })
    ])
    const sessionDuration = session?.videoId === videoId ? (session.durationSeconds || 0) : 0
    const durationSeconds = Math.max(existing?.durationSeconds || 0, sessionDuration) || undefined

    // Only run the correlation lookup if this row doesn't already have a
    // confirmed label - once found, a debrid service never changes for a
    // given episode, and re-querying ProxyStreamSession on every poll for
    // already-labeled rows would be pure waste.
    const debridService = existing?.debridService
      || await findDebridServiceForWatch(prisma, { accountId: accountIdValue, userId, title: showName, watchedAt, users })

    // Episode title, fetched once per episode (never re-fetched once known -
    // a title never changes) via the same Cinemeta lookup already used for
    // Discord "started watching" embeds. Activity's History view previously
    // had no way to show this at all - it renders straight from this table,
    // unlike Continue Watching (which reads live provider metadata directly
    // and could always show it). Best-effort: a lookup failure just leaves
    // it null, same as debridService above, never blocks the actual watch
    // record from being written.
    let episodeName = existing?.episodeName || null
    if (!episodeName) {
      try {
        const { fetchMetadata } = require('./notify')
        const meta = await fetchMetadata(showId, 'series', videoId)
        episodeName = meta?.episode?.title || null
      } catch {}
    }

    // Real completion - once true, stays true (same as recordMovieWatch).
    const computedCompleted = computeCompleted(item.state)
    const completed = existing?.completed === true ? true : computedCompleted

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
        episodeName,
        poster,
        profileLabel,
        watchedAt,
        durationSeconds,
        debridService,
        completed
      },
      update: {
        watchedAt, // Update watch time if re-watching
        showName, // Update in case show name changed
        poster, // Update in case poster changed
        profileLabel,
        durationSeconds,
        // Only overwrite if we found something this time - never blank out
        // an already-confirmed label just because a later poll's window no
        // longer catches the original proxy session.
        ...(debridService ? { debridService } : {}),
        ...(episodeName ? { episodeName } : {}),
        ...(completed !== null && completed !== undefined ? { completed } : {})
      }
    })

    // Brand-new row (never seen this episode before) with no WatchSession
    // at all for the show - the proxy never had a chance to notify. See
    // notifyNativeWatchDetected's comment for why session (not
    // sessionDuration/videoId-matched) is the right check here.
    if (!existing && !session) {
      notifyNativeWatchDetected(prisma, accountIdValue, {
        title: showName, poster, itemType: 'series', season, episode, userId, users,
      })
    }

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
async function recordMovieWatch(prisma, accountId, userId, item, users = []) {
  try {
    if (item.type !== 'movie') return false

    const itemId = item._id || item.id
    if (!itemId) return false
    // No title at all from the provider's own library - see the matching
    // guard in sessionTracker.js/recordEpisodeWatch above.
    if (!item.name || !String(item.name).trim()) return false

    const itemName = item.name
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

    // Only process movies with real watch progress - a bare library bookmark
    // (no video_id, no position) was previously sailing through here
    // unconditionally, since the only check was item.type === 'movie'. But
    // isActuallyWatched()'s 5%-of-runtime threshold has its own false
    // negative: a movie stopped a few minutes into a 2h+ runtime never
    // crosses 5%, so a genuinely-watched debrid/torrent stream silently
    // never became a MovieWatchHistory row at all (confirmed real case -
    // proxy clearly saw an 8-12min connection, isActuallyWatched's ratio
    // landed at 4.76%, just under the threshold). hasConfirmedProxyPlayback
    // rescues that case: if the proxy independently confirms a real,
    // sustained connection existed for this title, that's stronger evidence
    // of real playback than the ratio heuristic (which exists only to catch
    // preview/hover-autoplay noise the proxy never sees in the first place).
    if (!isActuallyWatched(item)) {
      const confirmedByProxy = await hasConfirmedProxyPlayback(prisma, {
        accountId: accountIdValue, userId, title: itemName, watchedAt, users
      })
      if (!confirmedByProxy) return false
    }

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
        select: { durationSeconds: true, debridService: true, completed: true }
      }),
      prisma.watchSession.findUnique({
        where: { accountId_userId_itemId: { accountId: accountIdValue, userId, itemId } },
        select: { durationSeconds: true }
      })
    ])
    const durationSeconds = Math.max(existing?.durationSeconds || 0, session?.durationSeconds || 0) || undefined

    // Real completion - once true, stays true (finishing can't un-finish; a
    // later partial re-watch of the same title mustn't flip it back).
    const computedCompleted = computeCompleted(item.state)
    const completed = existing?.completed === true ? true : computedCompleted

    // See recordEpisodeWatch's matching comment - only look up if not
    // already confirmed.
    const debridService = existing?.debridService
      || await findDebridServiceForWatch(prisma, { accountId: accountIdValue, userId, title: itemName, watchedAt, users })

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
        durationSeconds,
        debridService,
        completed
      },
      update: {
        watchedAt, // Update watch time if re-watching
        itemName, // Update in case name changed
        poster, // Update in case poster changed
        profileLabel,
        durationSeconds,
        ...(debridService ? { debridService } : {}),
        // Only write when we have a verdict, and never downgrade a prior true.
        ...(completed !== null && completed !== undefined ? { completed } : {})
      }
    })

    // Brand-new row with no WatchSession at all for this item - the proxy
    // never had a chance to notify. See notifyNativeWatchDetected's comment.
    if (!existing && !session) {
      notifyNativeWatchDetected(prisma, accountIdValue, {
        title: itemName, poster, itemType: 'movie', season: null, episode: null, userId, users,
      })
    }

    return true
  } catch (error) {
    // Silently fail - movie history is optional
    if (error.code !== 'P2002') { // Ignore unique constraint errors
      console.warn(`[MetricsProcessor] Error recording movie watch:`, error.message)
    }
    return false
  }
}

// Ratio of runtime a movie's position must drop below to count as "restarted".
const REWATCH_ARM_RATIO = 0.15

/**
 * Rewatch detection for MOVIES. A small, deliberately isolated state machine
 * that only ever writes rewatchCount / rewatchArmed on MovieWatchHistory -
 * never any watch-time, delta, snapshot, or activity field - so it physically
 * cannot inflate Watch Time (the recurring failure mode this codebase guards
 * against everywhere else).
 *
 * How it works, using the live playback position (state.timeOffset) against
 * the movie's runtime (state.duration):
 *   - Only a movie that has ALREADY been completed once can be rewatched, so
 *     we do nothing until completed === true.
 *   - "arm" when a finished movie's position dips back near the start
 *     (<= REWATCH_ARM_RATIO of runtime): the viewer started it over. This runs
 *     from processLibraryItem, which sees every library item every poll (no
 *     isActuallyWatched gate), so the low-position moment is observable even
 *     though recordMovieWatch would early-return on it.
 *   - "count" when an armed movie's position reaches the end again
 *     (>= COMPLETE_RATIO): increment rewatchCount and disarm. One increment per
 *     dip-then-finish cycle - the persistent rewatchArmed flag is what makes it
 *     edge-triggered rather than firing every poll while near the end.
 * Series are intentionally out of scope: their timeOffset is per-episode, so a
 * reset is just the next episode starting, not a rewatch.
 */
async function detectMovieRewatch(prisma, accountId, userId, item) {
  try {
    if (item.type !== 'movie') return
    const itemId = item._id || item.id
    if (!itemId) return
    const dur = Number(item.state?.duration || 0)
    const off = Number(item.state?.timeOffset || 0)
    if (!(dur > 0) || !(off >= 0)) return
    const ratio = off / dur

    const row = await prisma.movieWatchHistory.findUnique({
      where: { accountId_userId_itemId: { accountId: accountId || 'default', userId, itemId } },
      select: { completed: true, rewatchArmed: true }
    })
    // Only a previously-finished movie can be rewatched; if there's no row yet
    // (or it was never completed) there's nothing to detect.
    if (!row || row.completed !== true) return

    if (!row.rewatchArmed && ratio <= REWATCH_ARM_RATIO) {
      await prisma.movieWatchHistory.update({
        where: { accountId_userId_itemId: { accountId: accountId || 'default', userId, itemId } },
        data: { rewatchArmed: true }
      })
    } else if (row.rewatchArmed && ratio >= COMPLETE_RATIO) {
      await prisma.movieWatchHistory.update({
        where: { accountId_userId_itemId: { accountId: accountId || 'default', userId, itemId } },
        data: { rewatchArmed: false, rewatchCount: { increment: 1 } }
      })
    }
  } catch (error) {
    // Best-effort only - rewatch tracking must never block metrics processing.
    if (error?.code !== 'P2002') {
      console.warn(`[MetricsProcessor] Rewatch detection failed for ${userId}/${item?._id || item?.id}:`, error.message)
    }
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
async function getMaxOverallTimeWatched(prisma, accountId, userId, itemId, videoId = null) {
  try {
    const snapshots = await prisma.watchSnapshot.findMany({
      // Scoped to the same episode (videoId) when known - a series' overallTimeWatched
      // is only genuinely monotonic WITHIN one episode (see the episode-change
      // handling in processLibraryItem for why mixing episodes here reintroduces
      // the exact bug this function was built to prevent, just from the other
      // direction). videoId is null for movies, where this scoping is a no-op.
      where: { accountId: accountId || 'default', userId, itemId, videoId },
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
async function processLibraryItem(prisma, accountId, userId, item, today, users = []) {
  try {
    const itemId = item._id || item.id
    if (!itemId || !item.type) return { snapshotCreated: false, activityCreated: false }
    // No title at all from the provider's own library (confirmed real case:
    // a raw/direct stream with no proper Cinemeta-backed catalog entry lands
    // in Stremio/Nuvio's library nameless) - skip snapshot/WatchActivity/
    // history entirely rather than count a placeholder toward Watch Time
    // Today with nothing real to show for it. Same guard as
    // sessionTracker.js's own library loop.
    if (!item.name || !String(item.name).trim()) return { snapshotCreated: false, activityCreated: false }

    const accountIdValue = accountId || 'default'
    const timeZone = await resolveAccountTimezone(prisma, accountIdValue)
    const todayDate = getAccountDateString(today, timeZone)

    // Get previous snapshot (for baseline comparison)
    const previous = await getPreviousSnapshot(prisma, accountIdValue, userId, itemId, today, timeZone)

    // Current state
    const current = {
      overallTimeWatched: item.state?.overallTimeWatched ? String(item.state.overallTimeWatched) : null,
      timeOffset: item.state?.timeOffset ? String(item.state.timeOffset) : null,
      // Which episode this poll's overallTimeWatched/timeOffset actually
      // describes. For a series, item is one row per SHOW (itemId stays
      // constant across episodes) - video_id is what actually changes.
      videoId: item.state?.video_id || null,
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

    // A series' overallTimeWatched is only monotonic WITHIN one episode -
    // Nuvio's own position for the show resets to a small value every time
    // the viewer advances to a new episode (confirmed: nuvio.js maps a
    // series' progress row to overallTimeWatched = p.position, the same
    // per-episode value as timeOffset, not a true lifetime counter the way
    // Stremio's is - see CLAUDE.md's Watch tracking notes). Without this
    // check, the code below treated that legitimate reset as either a
    // regression to reject (silently dropping the new episode's watch time
    // entirely, since it never exceeds the old episode's higher max) or a
    // multi-profile-merge glitch to clamp back up (see the clamp comment
    // further down) - both wrong here. video_id changing between polls for
    // the same itemId (itemId stays the show's base ID for series, per
    // getBaseItemId's own comment) is what actually distinguishes a real
    // episode change from either of those.
    const previousVideoId = latestSnapshot?.videoId || null
    const episodeChanged = !!(current.videoId && previousVideoId && current.videoId !== previousVideoId)

    let snapshotCreated = false
    let activityCreated = false

    // Check if current library value differs from latest snapshot
    const snapshotChanged = !latestSnapshot ||
      !latestSnapshot.overallTimeWatched ||
      BigInt(latestSnapshot.overallTimeWatched) !== BigInt(current.overallTimeWatched || '0')

    // Decide whether to record an activity delta - this part is pure
    // decision-making (reads only), the actual writes happen atomically
    // below.
    // Highest overallTimeWatched ever recorded for this (user,item) across all
    // days - the monotonic high-water-mark. Computed once and reused for BOTH
    // the delta baseline below AND clamping the snapshot write further down, so
    // the snapshot can never regress it (see the clamp comment at the write).
    // Scoped to the current episode (videoId) - see getMaxOverallTimeWatched's
    // own comment for why mixing episodes here would reintroduce this same
    // class of bug from the other direction.
    let maxSeenBig = null
    if (current.overallTimeWatched) {
      try { maxSeenBig = await getMaxOverallTimeWatched(prisma, accountIdValue, userId, itemId, current.videoId) } catch {}
    }

    let activityDeltaSeconds = null
    if (current.overallTimeWatched && snapshotChanged) {
      let totalDeltaSeconds = 0

      if (oldSnapshotValue && !episodeChanged) {
        // Existing item: calculate delta from the highest overallTimeWatched
        // ever recorded for this item, not just the single most recent
        // snapshot - see getMaxOverallTimeWatched's comment for why. Falls
        // back to the plain prior-snapshot comparison only in the
        // practically-unreachable case where the max lookup itself fails.
        const deltaBaseline = maxSeenBig !== null ? maxSeenBig : BigInt(oldSnapshotValue)
        const currOverall = BigInt(current.overallTimeWatched)
        const totalDeltaMs = currOverall - deltaBaseline

        // Only create activity if delta is significant (> 60 seconds) and positive
        if (totalDeltaMs > 0) {
          totalDeltaSeconds = Number(totalDeltaMs / 1000n)
        }
      } else {
        // Either first-time ever seeing this item (no prior snapshot exists),
        // or a new episode just started (episodeChanged) - either way,
        // oldSnapshotValue isn't a valid baseline for THIS observation's
        // delta. overallTimeWatched can represent CUMULATIVE watch time
        // across many past sessions/episodes, not "new today" - treating the
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
        // Clamp the stored overallTimeWatched to the monotonic high-water-mark:
        // never let a snapshot regress below the max ever seen for THIS episode
        // (maxSeenBig is scoped by videoId above). WITHIN one episode,
        // overallTimeWatched only ever grows in reality, so a same-episode drop
        // is always a data artifact - specifically Nuvio's multi-profile merge
        // transiently dropping a profile's progress (documented in CLAUDE.md).
        // Before this clamp, that drop overwrote the snapshot LOWER, which erased
        // the high-water-mark getMaxOverallTimeWatched relies on - so when the
        // value recovered, the recovery re-registered as a fresh delta, over and
        // over (confirmed real case 2026-07-30: the identical 19104-second delta
        // recorded 8x in one day for one series, inflating Watch Time Today by
        // 5+ hours). Keeping overallTimeWatched monotonic per-episode makes a
        // drop-then-recover a no-op by construction, while a genuine episode
        // change (different videoId) naturally clamps against nothing (no prior
        // snapshot exists yet for the new episode) and stores the new value as
        //-is. timeOffset / lastWatched / mtime still reflect current (those
        // legitimately move).
        const currOverallBig = BigInt(current.overallTimeWatched)
        const overallToStore = (maxSeenBig !== null && maxSeenBig > currOverallBig)
          ? maxSeenBig.toString()
          : current.overallTimeWatched
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
            overallTimeWatched: overallToStore,
            timeOffset: current.timeOffset,
            videoId: current.videoId,
            lastWatched: current.lastWatched,
            mtime: current.mtime
          },
          update: {
            overallTimeWatched: overallToStore,
            timeOffset: current.timeOffset,
            videoId: current.videoId,
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
      await recordEpisodeWatch(prisma, accountIdValue, userId, item, users)
    } else if (item.type === 'movie') {
      await recordMovieWatch(prisma, accountIdValue, userId, item, users)
      await detectMovieRewatch(prisma, accountIdValue, userId, item)
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
async function processUserLibrary(prisma, accountId, userId, library, today = new Date(), users = []) {
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
      const result = await processLibraryItem(prisma, accountId, userId, item, today, users)
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
        const result = await processUserLibrary(prisma, accountIdValue, user.id, library, today, users)
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

