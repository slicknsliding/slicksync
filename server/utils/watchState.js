// Watch State exchange with AIOStreams.
//
// AIOStreams can serve a household through Jellyfin apps (Odin, Infuse,
// Swiftfin, its own desktop app), and none of that playback ever reaches a
// Stremio or Nuvio library - which is where SlickSync reads watch history
// from. So a household watching that way was invisible here. AIOStreams' own
// answer is the `watch_state` addon resource: it reports playback to any addon
// that declares it, and reads back what that addon knows. SlickTrax declares
// it on a separate link (routes/traxAddon.js, /aio) so Stremio and Nuvio never
// see it. The protocol is specified in AIOStreams' docs under
// reference/addon-protocol/watch-state; field names below follow it.
//
// Push (AIOStreams -> here) becomes history and watch time. Pull (here ->
// AIOStreams) hands back what this person has watched anywhere, so Continue
// Watching on their Jellyfin app reflects what they watched in Nuvio.
//
// Live Now Playing comes from the playback cursor below, not from
// WatchSession: the native poller closes any session it cannot find in the
// person's provider library within a minute, which is every session that
// started in a Jellyfin app. liveViewings() is what Now Playing reads.

const crypto = require('crypto')
const { recordDiscreteWatch, removeDiscreteWatch, describeTitle } = require('./discreteWatch')
const { getAccountDateString, resolveAccountTimezone } = require('./dateUtils')

const PROFILE_LABEL = 'AIOStreams'

// AIOStreams retries a failed delivery for about a day and keeps delivered
// events for a week; remembering applied ids a little longer than that means
// no retry can ever be applied twice.
const EVENT_MEMORY_DAYS = 8

// Same threshold the library poller uses to decide a stopped-short viewing is
// real rather than a preview: 5% of the runtime, or five minutes when the
// runtime is unknown.
const MIN_PROGRESS_RATIO = 0.05
const MIN_PROGRESS_MS_NO_DURATION = 5 * 60 * 1000

// Only move a title's watched date when this much was actually watched. A
// stop after a few seconds of re-opening something must not re-date a viewing
// that happened days before - the same rule as the library poller.
const MEANINGFUL_SECONDS = 60

// How far past the clock time a position may move in one stretch and still
// count, to absorb rounding between AIOStreams' whole-second timestamps.
const CLOCK_SLACK_MS = 5000

const PUSH_EVENTS = ['start', 'pause', 'stop', 'played', 'unplayed', 'watchlisted', 'unwatchlisted', 'dropped', 'undropped', 'rated', 'unrated']

function manifestBlock() {
  return {
    version: 2,
    // One link serves the household: AIOStreams names the profile on every
    // request, and each profile is matched to a SlickSync user below.
    viewers: true,
    push: { events: PUSH_EVENTS, bulk: true },
    pull: { items: true, watched: true, watchlist: true, ratings: true, ttlSeconds: 300 },
  }
}

// ---------------------------------------------------------------------------
// Viewers

/** AIOStreams' own derivation, so a SlickSync name can be compared with it. */
function viewerSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
}

function readViewerMap(owner) {
  try {
    const parsed = owner.watchStateViewers ? JSON.parse(owner.watchStateViewers) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Which SlickSync user a request is about. No viewer is the owner of the
 * AIOStreams configuration, which is the person whose link it is. A named
 * viewer is whoever it has been linked to; one never linked is matched by
 * name once, and if that is not unambiguous it is recorded as unlinked and
 * refused. Refusing is what the protocol prescribes for an unknown viewer,
 * and it is the right failure: dropped, never filed under somebody else.
 */
async function resolveViewer(prisma, owner, viewer) {
  if (!viewer) return owner.watchStateEnabled ? owner : null

  const id = viewerSlug(viewer)
  if (!id) return null
  const map = readViewerMap(owner)
  let userId = map[id]

  if (userId === undefined) {
    const candidates = await prisma.user.findMany({
      where: { accountId: owner.accountId, isActive: true },
      select: { id: true, username: true },
    })
    const matches = candidates.filter((u) => viewerSlug(u.username) === id)
    userId = matches.length === 1 ? matches[0].id : null
    map[id] = userId
    await prisma.user.update({ where: { id: owner.id }, data: { watchStateViewers: JSON.stringify(map) } })
  }
  // 'skip' is a profile someone chose not to count.
  if (!userId || userId === 'skip') return null

  const user = await prisma.user.findFirst({ where: { id: userId, accountId: owner.accountId } })
  // Each person's own switch is their consent, not just the link owner's.
  return user && user.watchStateEnabled ? user : null
}

// ---------------------------------------------------------------------------
// Push

function toDate(at) {
  const n = Number(at)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date()
}

function itemTypeFor(type, event) {
  if (type === 'series' || event.scope === 'episode' || event.scope === 'series' || event.scope === 'season') return 'series'
  return 'movie'
}

/**
 * SlickSync keys an episode as `{show}:{season}:{episode}` in the show's own
 * id space. A metadata addon may key the episodes in another space - Kitsu
 * episodes under an IMDb show - so those are rebuilt in the show's space
 * whenever the numbers are there to do it.
 */
function seriesVideoId(itemId, video, fallback) {
  const given = video?.videoId || fallback
  if (given && String(given).startsWith(`${itemId}:`)) return given
  if (Number.isInteger(video?.season) && Number.isInteger(video?.episode)) return `${itemId}:${video.season}:${video.episode}`
  return given
}

/** Was a stopped-short viewing real watching, or a preview? */
function meaningfulProgress(event) {
  const pos = Number(event.positionMs)
  const dur = Number(event.durationMs)
  if (!Number.isFinite(pos) || pos <= 0) return false
  if (Number.isFinite(dur) && dur > 0) return pos / dur > MIN_PROGRESS_RATIO
  return pos >= MIN_PROGRESS_MS_NO_DURATION
}

/**
 * Close the stretch of playback that started at the cursor's position, and
 * record the time it really took. The position delta is capped by the clock
 * time between the two reports, so skipping forward never counts as watching.
 */
async function closeStretch(prisma, user, cursor, event, timeZone) {
  if (!cursor || cursor.startAt == null || cursor.startPositionMs == null) return 0
  const pos = Number(event.positionMs)
  if (!Number.isFinite(pos)) return 0
  const endAt = toDate(event.at)
  const wallMs = endAt.getTime() - cursor.startAt.getTime() + CLOCK_SLACK_MS
  let ms = Math.min(pos - cursor.startPositionMs, wallMs)
  const dur = Number(event.durationMs)
  if (Number.isFinite(dur) && dur > 0) ms = Math.min(ms, dur)
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds <= 0) return 0

  // Same day key the library poller writes, so Watch Time adds up across both.
  await prisma.watchActivity.create({
    data: {
      accountId: user.accountId || 'default',
      userId: user.id,
      itemId: cursor.itemId,
      date: new Date(getAccountDateString(endAt, timeZone)),
      watchTimeSeconds: seconds,
      itemType: cursor.itemType,
      videoId: cursor.itemType === 'series' ? cursor.videoId : null,
      profileLabel: PROFILE_LABEL,
    },
  })
  return seconds
}

function emitNowPlaying(accountId) {
  try { require('./liveEvents').emitLive(accountId, 'nowplaying') } catch { /* optional */ }
}

/**
 * After a start: name the title on the cursor for Now Playing, refresh open
 * pages, and for a fresh viewing send the same "started watching" the proxy
 * sends - Discord, phone push and the watch.started automation trigger.
 */
async function announceStart(prisma, user, where, item, fresh) {
  const accountId = user.accountId || 'default'
  const { title, episodeName, poster } = await describeTitle(prisma, accountId, item).catch(() => ({}))
  if (title) {
    await prisma.watchStateCursor.update({ where, data: { itemName: title, poster: poster || null } }).catch(() => {})
  }
  emitNowPlaying(accountId)
  if (!fresh || !title) return

  await require('./startNotifyDedupe').announceViewingStart(prisma, user, { ...item, title, episodeName, poster })
}

// A viewing whose stop never arrives - the app crashed, the phone died - is
// treated as over once its runtime has passed, plus this much grace.
const LIVE_GRACE_MS = 10 * 60 * 1000
// And when the runtime was never reported, after this long.
const LIVE_MAX_NO_DURATION_MS = 4 * 60 * 60 * 1000
// A cursor this old is a viewing that will never finish; it is removed.
const STALE_CURSOR_MS = 2 * 24 * 60 * 60 * 1000

/**
 * What is playing in AIOStreams' apps right now, for Now Playing. Only a
 * viewing between a start and its pause or stop; the position is estimated
 * from where it started and the time since, because AIOStreams reports no
 * progress in between.
 */
async function liveViewings(prisma, accountId, userIds = null) {
  const now = Date.now()
  const rows = await prisma.watchStateCursor.findMany({
    where: { accountId, startAt: { not: null }, ...(userIds ? { userId: { in: userIds } } : {}) },
  })
  const out = []
  for (const c of rows) {
    const startedAt = new Date(c.startAt).getTime()
    const remaining = c.durationMs ? Math.max(0, c.durationMs - (c.startPositionMs || 0)) + LIVE_GRACE_MS : LIVE_MAX_NO_DURATION_MS
    if (now > startedAt + remaining) continue
    let position = (c.startPositionMs || 0) + Math.max(0, now - startedAt)
    if (c.durationMs) position = Math.min(position, c.durationMs)
    out.push({
      userId: c.userId,
      itemId: c.itemId,
      itemType: c.itemType,
      videoId: c.itemType === 'series' ? c.videoId : null,
      itemName: c.itemName || null,
      poster: c.poster || null,
      season: c.season ?? null,
      episode: c.episode ?? null,
      startedAt: new Date(c.createdAt || c.startAt),
      positionMs: position,
      durationMs: c.durationMs || null,
    })
  }
  return out
}

async function applyPlayback(prisma, user, type, pathId, event) {
  const accountId = user.accountId || 'default'
  const itemType = itemTypeFor(type, event)
  const itemId = event.metaId || pathId
  const videoId = itemType === 'series' ? seriesVideoId(itemId, event, pathId) : itemId
  const where = { accountId_userId_videoId: { accountId, userId: user.id, videoId } }
  const timeZone = await resolveAccountTimezone(prisma, accountId)

  if (event.event === 'start') {
    // Playing from here. A resume after a pause keeps what was already counted.
    const before = await prisma.watchStateCursor.findUnique({ where })
    const live = {
      itemId,
      itemType,
      startPositionMs: Math.round(Number(event.positionMs) || 0),
      startAt: toDate(event.at),
      durationMs: Number(event.durationMs) > 0 ? Math.round(Number(event.durationMs)) : before?.durationMs ?? null,
      season: Number.isInteger(event.season) ? event.season : before?.season ?? null,
      episode: Number.isInteger(event.episode) ? event.episode : before?.episode ?? null,
    }
    await prisma.watchStateCursor.upsert({
      where,
      create: { accountId, userId: user.id, videoId, ...live },
      update: live,
    })
    // Naming the title can take a metadata lookup; AIOStreams is not kept
    // waiting for it. A resume after a pause is the same viewing, so only a
    // fresh one is announced.
    setImmediate(() => {
      announceStart(prisma, user, where, { itemId, itemType, videoId, season: live.season, episode: live.episode }, !before)
        .catch((e) => console.warn('[WatchState] start follow-up failed:', e?.message))
    })
    return
  }

  const cursor = await prisma.watchStateCursor.findUnique({ where })

  if (event.event === 'pause') {
    const seconds = await closeStretch(prisma, user, cursor, event, timeZone)
    if (cursor) {
      await prisma.watchStateCursor.update({
        where,
        data: { accumulatedSeconds: cursor.accumulatedSeconds + seconds, startAt: null, startPositionMs: null },
      })
    }
    emitNowPlaying(accountId)
    return
  }

  // stop
  const seconds = await closeStretch(prisma, user, cursor, event, timeZone)
  const watchedSeconds = (cursor?.accumulatedSeconds || 0) + seconds
  if (cursor) await prisma.watchStateCursor.delete({ where }).catch(() => {})
  emitNowPlaying(accountId)

  const finished = event.played === true
  if (!finished && !meaningfulProgress(event)) return

  const result = await recordDiscreteWatch(prisma, {
    accountId,
    userId: user.id,
    itemId,
    itemType,
    videoId: itemType === 'series' ? videoId : undefined,
    season: event.season ?? null,
    episode: event.episode ?? null,
    completed: finished,
    watchedAt: toDate(event.at),
    moveForward: finished || watchedSeconds >= MEANINGFUL_SECONDS,
    durationSeconds: watchedSeconds,
    profileLabel: PROFILE_LABEL,
  })
  // No title anywhere is usually a metadata service being down for a moment.
  // Asking AIOStreams to retry is better than losing the viewing.
  if (!result.ok && result.reason === 'no-title') throw Object.assign(new Error('title not resolvable yet'), { retry: true })
}

async function applyMark(prisma, user, itemType, itemId, video, kind, at) {
  const accountId = user.accountId || 'default'
  if (itemType === 'series') video = { ...video, videoId: seriesVideoId(itemId, video) }
  if (kind === 'unplayed') {
    await removeDiscreteWatch(prisma, { accountId, userId: user.id, itemId, itemType, videoId: video?.videoId })
    return
  }
  await recordDiscreteWatch(prisma, {
    accountId,
    userId: user.id,
    itemId,
    itemType,
    videoId: video?.videoId,
    season: video?.season ?? null,
    episode: video?.episode ?? null,
    completed: true,
    watchedAt: toDate(at),
    // A mark is a statement that it was watched, not a viewing happening now.
    moveForward: false,
    profileLabel: PROFILE_LABEL,
  })
}

async function applyListChange(prisma, user, type, event) {
  const accountId = user.accountId || 'default'
  const itemId = event.metaId
  if (!itemId) return
  const itemType = event.scope === 'series' || type === 'series' ? 'series' : 'movie'

  switch (event.event) {
    case 'watchlisted': {
      // The household watchlist, the same one the Watchlist page shows.
      const { title, poster } = await describeTitle(prisma, accountId, { itemId, itemType })
      if (!title) throw Object.assign(new Error('title not resolvable yet'), { retry: true })
      await prisma.watchlistItem.upsert({
        where: { accountId_itemId: { accountId, itemId } },
        create: { accountId, itemId, itemType, name: title, poster },
        update: {},
      })
      return
    }
    case 'unwatchlisted':
      await prisma.watchlistItem.deleteMany({ where: { accountId, itemId } })
      return
    case 'dropped': {
      // A dropped show is a buried one: out of Continue Watching, in the Graveyard.
      const { dismissContinueWatching } = require('./continueWatching')
      await dismissContinueWatching(prisma, accountId, user.id, itemId)
      return
    }
    case 'undropped': {
      const { unburyShow } = require('./continueWatching')
      await unburyShow(prisma, accountId, user.id, itemId)
      return
    }
  }
}

async function applyRating(prisma, user, type, event) {
  const accountId = user.accountId || 'default'
  const itemId = event.metaId
  if (!itemId) return
  // SlickSync rates films, shows and seasons. An episode rating has nowhere
  // to go, so it is accepted and set aside rather than retried.
  if (event.scope === 'episode') return
  const season = event.scope === 'season' && Number.isInteger(event.season) ? event.season : 0
  const itemType = type === 'series' || event.scope === 'series' || event.scope === 'season' ? 'series' : 'movie'
  const { setRating, clearRating } = require('./titleFeedback')

  if (event.event === 'unrated') {
    await clearRating(prisma, accountId, itemId, season)
    return
  }
  // Ratings arrive on a 0-10 scale with decimals; SlickSync keeps whole 1-10.
  const value = Math.min(10, Math.max(1, Math.round(Number(event.rating))))
  if (!Number.isFinite(value)) return
  const { title, poster } = await describeTitle(prisma, accountId, { itemId, itemType })
  await setRating(prisma, accountId, itemId, itemType, value, season, title, poster)
}

async function applyBulk(prisma, user, type, event) {
  const itemType = 'series'
  const itemId = event.metaId
  for (const video of event.videos || []) {
    try {
      await applyMark(prisma, user, itemType, itemId, video, event.event, event.at)
    } catch (e) {
      console.warn('[WatchState] bulk mark skipped one video:', e?.message)
    }
  }
}

/**
 * Apply one pushed event. Returns an HTTP status for AIOStreams: 2xx delivered,
 * 503 retry later, other 4xx drop it.
 */
// Someone whose own login IS an AIOStreams media server is read straight
// from that server every minute (providers/jellyfin.js): its resume points
// and played marks are already their record. Recording the same viewing from
// Watch State too would count it twice, so playback and played marks are
// accepted and left to the library read. Watchlist, ratings and drops have
// no other way in and are still applied.
function playbackComesFromServer(user) {
  return user?.providerType === 'jellyfin' && user?.jellyfinServerKind === 'aiostreams'
}

async function handlePush(prisma, user, type, pathId, event) {
  if (!event || typeof event !== 'object' || !event.id || !event.event) return 400
  if (playbackComesFromServer(user) && ['start', 'pause', 'stop', 'played', 'unplayed'].includes(event.event)) return 200
  const accountId = user.accountId || 'default'
  // A viewing whose stop never came, days ago, is over.
  prisma.watchStateCursor.deleteMany({ where: { userId: user.id, updatedAt: { lt: new Date(Date.now() - STALE_CURSOR_MS) } } }).catch(() => {})

  // Applied already? A retried delivery, or a client reporting one stop twice.
  try {
    await prisma.watchStateEvent.create({ data: { accountId, userId: user.id, eventId: String(event.id).slice(0, 300) } })
  } catch (e) {
    if (e?.code === 'P2002') return 200
    throw e
  }

  const forget = () => prisma.watchStateEvent.deleteMany({ where: { accountId, userId: user.id, eventId: String(event.id).slice(0, 300) } }).catch(() => {})

  try {
    const bulk = (event.event === 'played' || event.event === 'unplayed') && (event.scope === 'series' || event.scope === 'season')
    if (bulk) {
      // A whole show or season can be hundreds of episodes. The protocol asks
      // for the request to be accepted at once and written after; a failure on
      // one episode is not a reason to make AIOStreams send them all again.
      setImmediate(() => { applyBulk(prisma, user, type, event).catch((e) => console.warn('[WatchState] bulk mark failed:', e?.message)) })
      return 200
    }

    switch (event.event) {
      case 'start':
      case 'pause':
      case 'stop':
        await applyPlayback(prisma, user, type, pathId, event)
        return 200
      case 'played':
      case 'unplayed': {
        const itemType = itemTypeFor(type, event)
        const itemId = event.metaId || pathId
        await applyMark(prisma, user, itemType, itemId, { videoId: itemType === 'series' ? (event.videoId || pathId) : undefined, season: event.season, episode: event.episode }, event.event, event.at)
        return 200
      }
      case 'watchlisted':
      case 'unwatchlisted':
      case 'dropped':
      case 'undropped':
        await applyListChange(prisma, user, type, event)
        return 200
      case 'rated':
      case 'unrated':
        await applyRating(prisma, user, type, event)
        return 200
      default:
        // An event this version does not know. Accepted, so it is not retried.
        return 200
    }
  } catch (e) {
    await forget()
    if (e?.retry) return 503
    console.error('[WatchState] push failed:', e?.message)
    return 503
  }
}

// ---------------------------------------------------------------------------
// Pull

function unix(date) {
  return Math.floor(new Date(date).getTime() / 1000)
}

// Ids AIOStreams can match against its own library. SlickSync also holds ids
// only it understands - IPTV channels, addon-private ids - which would only
// be noise in an answer that is matched as given.
const PUBLIC_ID = /^(tt\d+|(kitsu|tmdb|tvdb|mal|anilist|anidb):)/

function isPublicId(id) {
  return typeof id === 'string' && PUBLIC_ID.test(id)
}

function hashOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/**
 * What this person has watched, for AIOStreams to read. `items` is what is in
 * progress, `watched` the finished library, `watchlist` and `ratings` the
 * household's lists. `watched` is left out entirely if it could not be read:
 * per the protocol an empty one would tell AIOStreams nothing has ever been
 * watched and erase what it imported before.
 */
async function buildPull(prisma, user, since) {
  const accountId = user.accountId || 'default'
  const out = { version: null, items: [] }

  // In progress: positions SlickSync already knows from the person's other
  // apps. Bounded and newest first, as the protocol asks. Past the account's
  // finished line it is watched, not in progress.
  const finishedRatio = (await require('./watchSettings').getWatchSettings(prisma, accountId)).finishedPercent / 100
  try {
    const sessions = await prisma.watchSession.findMany({
      where: { accountId, userId: user.id, lastPosition: { gt: 0 }, totalDuration: { gt: 0 } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    for (const s of sessions) {
      const ratio = s.lastPosition / s.totalDuration
      if (!(ratio > MIN_PROGRESS_RATIO && ratio < finishedRatio)) continue
      const isSeries = s.itemType === 'series'
      if (isSeries && !s.videoId) continue
      if (!isPublicId(s.itemId)) continue
      out.items.push({
        type: isSeries ? 'series' : 'movie',
        metaId: s.itemId,
        videoId: isSeries ? s.videoId : s.itemId,
        ...(isSeries ? { season: s.season ?? null, episode: s.episode ?? null } : {}),
        positionMs: s.lastPosition,
        durationMs: s.totalDuration,
        progressPercent: Math.round(ratio * 1000) / 10,
        played: false,
        at: unix(s.updatedAt),
      })
    }
  } catch (e) {
    console.warn('[WatchState] pull: in-progress read failed:', e?.message)
  }

  try {
    // A stopped-short viewing is recorded with completed = false. Anything
    // else - finished, or an older record with no verdict either way - counts
    // as watched, which is how the Activity page treats it too.
    const [movies, episodes, buried] = await Promise.all([
      prisma.movieWatchHistory.findMany({
        where: { accountId, userId: user.id, NOT: { completed: false } },
        select: { itemId: true },
      }),
      prisma.episodeWatchHistory.findMany({
        where: { accountId, userId: user.id, NOT: { completed: false } },
        select: { showId: true, videoId: true, season: true, episode: true, watchedAt: true },
        orderBy: { watchedAt: 'desc' },
      }),
      prisma.dismissedContinueWatching.findMany({
        where: { accountId, userId: user.id, wipedAt: null },
        select: { showId: true },
      }),
    ])

    const movieIds = [...new Set(movies.map((m) => m.itemId).filter(isPublicId))].sort()
    const episodeIds = [...new Set(episodes.filter((e) => isPublicId(e.showId)).map((e) => e.videoId))].sort()
    const dropped = [...new Set(buried.map((b) => b.showId).filter(isPublicId))].sort()

    // The version is derived from the answer itself, so it changes exactly
    // when the answer does - including a drop or undrop, which the protocol
    // requires - and never just because time passed.
    out.version = hashOf([movieIds, episodeIds, dropped])

    if (since !== out.version) {
      const droppedSet = new Set(dropped)
      const latestPerShow = new Map()
      for (const e of episodes) {
        if (isPublicId(e.showId) && !latestPerShow.has(e.showId)) latestPerShow.set(e.showId, e)
      }
      const nextUp = [...latestPerShow.values()]
        .filter((e) => !droppedSet.has(e.showId))
        .map((e) => ({ type: 'series', metaId: e.showId, videoId: e.videoId, season: e.season ?? null, episode: e.episode ?? null, at: unix(e.watchedAt) }))

      out.watched = { movies: movieIds, episodes: episodeIds, nextUp, dropped }
    }
  } catch (e) {
    console.warn('[WatchState] pull: watched read failed, leaving it out:', e?.message)
    delete out.watched
    out.version = out.version || 'unavailable'
  }

  try {
    const list = await prisma.watchlistItem.findMany({ where: { accountId }, select: { itemId: true, itemType: true, addedAt: true } })
    out.watchlist = list.filter((w) => isPublicId(w.itemId)).map((w) => ({ type: w.itemType === 'series' ? 'series' : 'movie', metaId: w.itemId, at: unix(w.addedAt) }))
  } catch (e) {
    console.warn('[WatchState] pull: watchlist read failed, leaving it out:', e?.message)
  }

  try {
    const ratings = await prisma.titleRating.findMany({ where: { accountId }, select: { itemId: true, itemType: true, season: true, rating: true, updatedAt: true } })
    out.ratings = ratings
      .filter((r) => r.rating >= 0 && r.rating <= 10 && isPublicId(r.itemId))
      .map((r) => ({
        type: r.itemType === 'series' ? 'series' : 'movie',
        metaId: r.itemId,
        ...(r.season > 0 ? { season: r.season } : {}),
        rating: r.rating,
        at: unix(r.updatedAt),
      }))
  } catch (e) {
    console.warn('[WatchState] pull: ratings read failed, leaving it out:', e?.message)
  }

  // Forget applied event ids once AIOStreams can no longer resend them. Done
  // here because a pull happens every half hour or so per person anyway.
  prisma.watchStateEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - EVENT_MEMORY_DAYS * 24 * 60 * 60 * 1000) } },
  }).catch(() => {})
  prisma.watchStateCursor.deleteMany({
    where: { updatedAt: { lt: new Date(Date.now() - STALE_CURSOR_MS) } },
  }).catch(() => {})

  return out
}

module.exports = {
  liveViewings,
  manifestBlock,
  viewerSlug,
  readViewerMap,
  resolveViewer,
  handlePush,
  buildPull,
  PROFILE_LABEL,
}
