/**
 * New-episode alerts: for every show someone on this instance is actively
 * watching (has an EpisodeWatchHistory row in the recent window), watch
 * Cinemeta's episode list for newly-RELEASED episodes and alert when one
 * appears - Discord (via the account's existing webhook) plus an
 * EpisodeAlert row the notification bell reads.
 *
 * "New" is defined against a stored per-show baseline (ShowEpisodeAlertState),
 * not against what the user has watched - a person 3 episodes behind
 * shouldn't get re-alerted about episodes that were already out when this
 * feature first saw the show. The first poll for a show only records the
 * baseline; alerts start from the second poll onward.
 *
 * Cinemeta's episode lists include FUTURE episodes with future `released`
 * dates (that's how it renders upcoming-episode placeholders), so the
 * baseline/comparison only ever considers episodes whose released date is in
 * the past - otherwise a whole announced-but-unaired season would "alert"
 * the moment Cinemeta lists it.
 */

const { fetchMetadata, postDiscord } = require('./notify')

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h - episode drops are a daily-scale event
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000 // let boot-time work settle first
const RECENT_WATCH_WINDOW_DAYS = 120 // same "actively watching" window Continue Watching uses

function episodeOrder(season, episode) {
  return season * 10000 + episode
}

/** Latest episode in the list whose released date is in the past. */
function latestReleasedEpisode(allEpisodes) {
  const now = Date.now()
  let latest = null
  for (const ep of allEpisodes) {
    if (!ep.released) continue
    const releasedTs = new Date(ep.released).getTime()
    if (!Number.isFinite(releasedTs) || releasedTs > now) continue
    if (!latest || episodeOrder(ep.season, ep.episode) > episodeOrder(latest.season, latest.episode)) {
      latest = ep
    }
  }
  return latest
}

/** Soonest episode whose released date is still in the future (by air date). */
function nextUpcomingEpisode(allEpisodes) {
  const now = Date.now()
  let next = null
  let nextTs = Infinity
  for (const ep of allEpisodes) {
    if (!ep.released) continue
    const ts = new Date(ep.released).getTime()
    if (!Number.isFinite(ts) || ts <= now) continue
    if (ts < nextTs) { next = ep; nextTs = ts }
  }
  return next
}

/**
 * The Dashboard "Coming up" calendar: the next upcoming episode for every show
 * someone here is mid-season on. Reads the fields the poller stores on
 * ShowEpisodeAlertState — no Cinemeta call on page load. Keeps rows whose air
 * date is today or later (a small back-buffer so "airs today" stays visible
 * between the 6h polls that would otherwise roll it forward).
 */
async function getUpcomingEpisodes(prisma, accountId, limit = 24) {
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000)
  const rows = await prisma.showEpisodeAlertState.findMany({
    where: { accountId, nextAirDate: { gte: cutoff } },
    orderBy: { nextAirDate: 'asc' },
    take: limit,
  })
  const candidates = rows.filter((r) => r.nextSeason != null && r.nextEpisode != null && r.nextAirDate)

  // Filter out dismissed episodes — the (season, episode) tuple is intentional,
  // so once the poller advances the show to a NEW next episode, that new one
  // isn't in the dismiss list and re-appears without any manual reset.
  let dismissed = new Set()
  try {
    const rowsD = await prisma.dismissedUpcomingEpisode.findMany({
      where: { accountId, showId: { in: candidates.map((r) => r.showId) } },
      select: { showId: true, season: true, episode: true },
    })
    dismissed = new Set(rowsD.map((r) => `${r.showId}::${r.season}::${r.episode}`))
  } catch {} // Table may not exist yet on a very-first boot before db push runs.

  return candidates
    .filter((r) => !dismissed.has(`${r.showId}::${r.nextSeason}::${r.nextEpisode}`))
    .map((r) => ({
      showId: r.showId,
      showName: r.showName || null,
      poster: r.poster || null,
      season: r.nextSeason,
      episode: r.nextEpisode,
      title: r.nextTitle || null,
      airDate: r.nextAirDate,
    }))
}

/**
 * Hide an upcoming episode from the "Coming up" panel. Persisted server-side
 * so a dismissal from one browser/device carries across the account.
 */
async function dismissUpcomingEpisode(prisma, accountId, showId, season, episode) {
  const accountIdValue = accountId || 'default'
  await prisma.dismissedUpcomingEpisode.upsert({
    where: { accountId_showId_season_episode: { accountId: accountIdValue, showId, season, episode } },
    create: { accountId: accountIdValue, showId, season, episode },
    update: {},
  })
}

async function getNotifyTarget(prisma, accountId) {
  try {
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    // Rides the existing activity toggle rather than adding a new settings
    // field - "a new episode of something you watch is out" is activity-
    // adjacent, and the Settings UI stays untouched.
    return {
      enabled: cfg?.notifyOnActivity === true,
      webhookUrl: cfg?.webhookUrl || null,
    }
  } catch {
    return { enabled: false, webhookUrl: null }
  }
}

async function checkForNewEpisodes(prisma) {
  const since = new Date(Date.now() - RECENT_WATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Every show with recent watch history, across all accounts (private mode
  // has exactly one). Track each show's watchers so the alert can say who's
  // behind.
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { watchedAt: { gte: since } },
    select: { accountId: true, userId: true, showId: true, showName: true, poster: true, season: true, episode: true, videoId: true, watchedAt: true },
    orderBy: { watchedAt: 'desc' },
  })

  // (accountId, showId) -> { showName, poster, videoId, watchers: Map<userId, latest {season, episode}> }
  const shows = new Map()
  for (const row of rows) {
    const key = `${row.accountId}::${row.showId}`
    if (!shows.has(key)) {
      shows.set(key, { accountId: row.accountId, showId: row.showId, showName: row.showName, poster: row.poster, videoId: row.videoId, watchers: new Map() })
    }
    const show = shows.get(key)
    // rows are newest-first, so first sighting per user IS their latest episode
    if (!show.watchers.has(row.userId) && row.season != null && row.episode != null) {
      show.watchers.set(row.userId, { season: row.season, episode: row.episode })
    }
  }

  let alertsFired = 0
  for (const show of shows.values()) {
    try {
      const metadata = await fetchMetadata(show.showId, 'series', show.videoId)
      if (!metadata?.allEpisodes?.length) continue

      const latest = latestReleasedEpisode(metadata.allEpisodes)
      if (!latest) continue

      // Upcoming-episode + display fields for the "Coming up" calendar, kept
      // fresh on every poll independently of the alert baseline below.
      const next = nextUpcomingEpisode(metadata.allEpisodes)
      const nextFields = {
        showName: metadata.title || show.showName || null,
        poster: metadata.poster || show.poster || null,
        nextSeason: next ? next.season : null,
        nextEpisode: next ? next.episode : null,
        nextTitle: next ? (next.title || null) : null,
        nextAirDate: next ? new Date(next.released) : null,
      }

      const state = await prisma.showEpisodeAlertState.findUnique({
        where: { accountId_showId: { accountId: show.accountId, showId: show.showId } },
      })

      if (!state) {
        // First sighting: record the baseline, never alert - see module comment.
        await prisma.showEpisodeAlertState.create({
          data: { accountId: show.accountId, showId: show.showId, lastSeason: latest.season, lastEpisode: latest.episode, ...nextFields },
        })
        continue
      }

      // Refresh the upcoming/display fields every poll (air dates approach; a
      // show can gain or lose an announced next episode). Baseline untouched.
      await prisma.showEpisodeAlertState.update({
        where: { accountId_showId: { accountId: show.accountId, showId: show.showId } },
        data: nextFields,
      }).catch(() => {})

      if (episodeOrder(latest.season, latest.episode) <= episodeOrder(state.lastSeason, state.lastEpisode)) {
        continue // nothing new
      }

      // Advance the baseline FIRST - if the notification below throws, the
      // next poll must not re-alert the same episode (create() below would
      // also catch that via its unique constraint, but belt and suspenders).
      await prisma.showEpisodeAlertState.update({
        where: { accountId_showId: { accountId: show.accountId, showId: show.showId } },
        data: { lastSeason: latest.season, lastEpisode: latest.episode },
      })

      // Only the LATEST new episode alerts, even if several dropped between
      // polls (e.g. a full-season drop) - one "S05E09 is out" beats ten
      // rapid-fire pings, and the show page has the rest anyway.
      try {
        await prisma.episodeAlert.create({
          data: {
            accountId: show.accountId,
            showId: show.showId,
            showName: metadata.title || show.showName,
            season: latest.season,
            episode: latest.episode,
            title: latest.title || null,
            poster: metadata.poster || show.poster || null,
          },
        })
      } catch (e) {
        // Unique-constraint hit = already alerted (shouldn't happen given the
        // baseline check, but restarts/races are cheap to be safe against).
        continue
      }
      alertsFired++

      const epLabel = `S${String(latest.season).padStart(2, '0')}E${String(latest.episode).padStart(2, '0')}`

      // Native web-push to any PWA-installed device that opted in - fires even
      // when SlickSync isn't open. Best-effort; failures never block the rest.
      try {
        const { sendPushToAccount } = require('./pushNotifications')
        await sendPushToAccount(prisma, show.accountId, {
          title: `New episode: ${metadata.title || show.showName}`,
          body: `${epLabel}${latest.title ? ` · ${latest.title}` : ''} is out`,
          icon: metadata.poster || show.poster || '/android-chrome-192x192.png',
          url: '/activity',
        })
      } catch {}

      const target = await getNotifyTarget(prisma, show.accountId)
      if (target.enabled && target.webhookUrl) {
        // "Who's behind" flavor - a watcher already past the new episode
        // (rewatch scenarios) is skipped.
        const behind = [...show.watchers.entries()]
          .filter(([, w]) => episodeOrder(w.season, w.episode) < episodeOrder(latest.season, latest.episode))
        let behindLine = ''
        if (behind.length > 0) {
          const userRows = await prisma.user.findMany({
            where: { id: { in: behind.map(([userId]) => userId) } },
            select: { id: true, username: true, email: true },
          })
          const nameById = new Map(userRows.map((u) => [u.id, u.username || u.email || 'someone']))
          behindLine = '\n' + behind
            .map(([userId, w]) => `${nameById.get(userId) || 'someone'} is on S${String(w.season).padStart(2, '0')}E${String(w.episode).padStart(2, '0')}`)
            .join(' · ')
        }
        await postDiscord(
          target.webhookUrl,
          `**New episode: ${metadata.title || show.showName} ${epLabel}${latest.title ? ` · ${latest.title}` : ''}**${behindLine}`
        ).catch(() => {})
      }
    } catch (e) {
      console.warn(`[EpisodeAlerts] Failed to check ${show.showId}:`, e?.message)
    }
  }

  if (alertsFired > 0) {
    console.log(`[EpisodeAlerts] Fired ${alertsFired} new-episode alert${alertsFired !== 1 ? 's' : ''}`)
  }
  return alertsFired
}

function scheduleEpisodeAlerts(prisma) {
  const run = () => checkForNewEpisodes(prisma).catch((e) => console.warn('[EpisodeAlerts] Poll failed:', e?.message))
  setTimeout(run, FIRST_RUN_DELAY_MS)
  setInterval(run, POLL_INTERVAL_MS)
}

module.exports = { scheduleEpisodeAlerts, checkForNewEpisodes, getUpcomingEpisodes, dismissUpcomingEpisode }
