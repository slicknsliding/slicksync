// Writes history for a single, explicit watch event - "this was played", "this
// was finished", "this was cleared" - as opposed to the library polling in
// metricsProcessor.js, which has to infer from repeated, possibly stale
// position snapshots whether something was really watched. Two callers send
// discrete events: the Trakt-compatible scrobble API (routes/scrobble.js) and
// the Watch State exchange with AIOStreams (utils/watchState.js). They share
// this writer so the two cannot drift apart in how a watch is recorded.
//
// The rules it keeps are the same ones the polling writer keeps, because each
// fixed a real reported problem there:
//   - completion only ever moves forward: once finished, a later partial
//     viewing of the same title never marks it unfinished again;
//   - a stored duration is merged with max(), never added to, so a later,
//     smaller reading can never shrink what was already recorded;
//   - the watched date only moves when the caller says this event was real
//     new viewing, so glancing at something days later does not re-date a
//     viewing that happened before.

const { fetchMetadata } = require('./notify')
const { resolveSinglePoster } = require('./libraryHelpers')
const { resolveOmdbKeyForAccount } = require('./listImport')

/**
 * Title, episode name and poster for an id, looked up once. Returns a null
 * title when nothing knows the id, which callers treat as "do not write" -
 * a history row with no real title is worse than no row.
 */
async function describeTitle(prisma, accountId, { itemId, itemType, videoId, title }) {
  const omdbApiKey = await resolveOmdbKeyForAccount(prisma, accountId).catch(() => null)
  let name = title || null
  let episodeName = null
  if (!name || (itemType === 'series' && videoId)) {
    const meta = await fetchMetadata(itemId, itemType === 'series' ? 'series' : 'movie', itemType === 'series' ? videoId : null, omdbApiKey).catch(() => null)
    name = name || meta?.title || null
    episodeName = meta?.episode?.title || null
  }
  const poster = name ? await resolveSinglePoster(itemId, itemType === 'series' ? 'series' : 'movie', null).catch(() => null) : null
  return { title: name, episodeName, poster }
}

/**
 * Record one watch. Returns { ok: true, created } or { ok: false, reason }.
 *
 * @param {object} w
 * @param {string} w.accountId
 * @param {string} w.userId
 * @param {string} w.itemId       the film's id, or the show's for an episode
 * @param {'movie'|'series'} w.itemType
 * @param {string} [w.videoId]    the episode's own id (series only)
 * @param {number|null} [w.season]
 * @param {number|null} [w.episode]
 * @param {string|null} [w.title] skips the lookup when the caller already knows it
 * @param {string|null} [w.episodeName] with title, skips the episode lookup too
 * @param {string|null} [w.poster] used when the lookup is skipped
 * @param {boolean|null} w.completed  true finished, false stopped short, null unknown
 * @param {Date} w.watchedAt
 * @param {boolean} w.moveForward  this event is real new viewing, so the date may move
 * @param {number} [w.durationSeconds]  time spent watching, merged with max()
 * @param {string} w.profileLabel  where the watch came from, shown in Activity
 */
async function recordDiscreteWatch(prisma, w) {
  const accountId = w.accountId || 'default'
  const isSeries = w.itemType === 'series'
  const videoId = isSeries ? (w.videoId || (w.season != null && w.episode != null ? `${w.itemId}:${w.season}:${w.episode}` : null)) : null
  if (isSeries && !videoId) return { ok: false, reason: 'no-episode' }

  const existing = isSeries
    ? await prisma.episodeWatchHistory.findUnique({
        where: { accountId_userId_videoId: { accountId, userId: w.userId, videoId } },
        select: { completed: true, durationSeconds: true, watchedAt: true, episodeName: true, showName: true, poster: true },
      })
    : await prisma.movieWatchHistory.findUnique({
        where: { accountId_userId_itemId: { accountId, userId: w.userId, itemId: w.itemId } },
        select: { completed: true, durationSeconds: true, watchedAt: true, itemName: true, poster: true },
      })

  // A row that already has its title, episode name and poster needs no lookup.
  const known = existing && (isSeries ? existing.showName && existing.episodeName : existing.itemName)
  // A caller marking a run of episodes already knows each one's name and the
  // show's poster (w.episodeName, w.poster) - no lookup per episode.
  const given = w.title && (!isSeries || w.episodeName !== undefined)
    ? { title: w.title, episodeName: w.episodeName || null, poster: w.poster || null }
    : null
  const described = known
    ? { title: isSeries ? existing.showName : existing.itemName, episodeName: existing.episodeName || null, poster: existing.poster || null }
    : given || await describeTitle(prisma, accountId, { itemId: w.itemId, itemType: w.itemType, videoId, title: w.title })
  if (!described.title) return { ok: false, reason: 'no-title' }

  const completed = existing?.completed === true ? true : (w.completed ?? existing?.completed ?? null)
  const durationSeconds = Math.max(existing?.durationSeconds || 0, Math.round(w.durationSeconds || 0)) || null
  const watchedAt = !existing || w.moveForward ? w.watchedAt : existing.watchedAt

  if (isSeries) {
    await prisma.episodeWatchHistory.upsert({
      where: { accountId_userId_videoId: { accountId, userId: w.userId, videoId } },
      create: {
        accountId, userId: w.userId, showId: w.itemId, showName: described.title, videoId,
        season: w.season ?? null, episode: w.episode ?? null, episodeName: described.episodeName,
        poster: described.poster, profileLabel: w.profileLabel, completed, watchedAt,
        durationSeconds: durationSeconds || undefined,
      },
      update: {
        showName: described.title,
        ...(described.episodeName ? { episodeName: described.episodeName } : {}),
        ...(described.poster ? { poster: described.poster } : {}),
        ...(completed !== null ? { completed } : {}),
        ...(durationSeconds ? { durationSeconds } : {}),
        watchedAt,
      },
    })
  } else {
    await prisma.movieWatchHistory.upsert({
      where: { accountId_userId_itemId: { accountId, userId: w.userId, itemId: w.itemId } },
      create: {
        accountId, userId: w.userId, itemId: w.itemId, itemName: described.title,
        poster: described.poster, profileLabel: w.profileLabel, completed, watchedAt,
        durationSeconds: durationSeconds || undefined,
      },
      update: {
        itemName: described.title,
        ...(described.poster ? { poster: described.poster } : {}),
        ...(completed !== null ? { completed } : {}),
        ...(durationSeconds ? { durationSeconds } : {}),
        watchedAt,
      },
    })
  }
  return { ok: true, created: !existing }
}

/**
 * Undo a "watched" mark: the history row goes. Time already spent watching
 * (WatchActivity) is left alone - it was really spent, and clearing a mark is
 * a statement about the title, not a claim that the evening never happened.
 */
async function removeDiscreteWatch(prisma, { accountId, userId, itemId, itemType, videoId }) {
  const accountIdValue = accountId || 'default'
  if (itemType === 'series') {
    if (!videoId) return
    await prisma.episodeWatchHistory.deleteMany({ where: { accountId: accountIdValue, userId, videoId } })
  } else {
    await prisma.movieWatchHistory.deleteMany({ where: { accountId: accountIdValue, userId, itemId } })
  }
}

module.exports = { recordDiscreteWatch, removeDiscreteWatch, describeTitle }
