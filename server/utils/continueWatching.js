/**
 * Continue Watching - for each show a user has partway watched, finds the
 * next unwatched episode using Cinemeta's full episode list, and builds a
 * deep link to resume it in the provider app.
 *
 * Stremio has a well-established deep-link URL scheme (stremio:///detail/...)
 * that opens the app directly to a specific episode, with a web.stremio.com
 * fallback for anyone without the app installed.
 *
 * Nuvio's own format was confirmed by reading NuvioMedia/NuvioDesktop's
 * source directly (composeApp/src/commonMain/kotlin/com/nuvio/app/core/
 * deeplink/AppUrlBridge.kt, buildMetaDeepLinkUrl) rather than guessed at -
 * the app registers nuvio:// on Windows (Nuvio Desktop 0.1.11-alpha+) and
 * its parser accepts nuvio://meta?type={movie|series}&id={imdbId}. Unlike
 * Stremio's link, that format has no season/episode parameter at all, so it
 * can only open the show's own page, not a specific episode - still a real
 * improvement over the IMDb-only fallback used before this was confirmed.
 */

const { fetchMetadata } = require('./notify')
const { buildStremioLinks, buildNuvioAppUrl } = require('./appLinks')

/**
 * Given the season/episode of the last-watched episode and the show's full
 * sorted episode list, finds the next one in watch order. Returns null if
 * the last watched episode IS the last known episode (caught up / waiting
 * on the next season).
 */
function findNextEpisode(allEpisodes, lastSeason, lastEpisode) {
  if (!Array.isArray(allEpisodes) || allEpisodes.length === 0) return null

  const lastIndex = allEpisodes.findIndex((e) => e.season === lastSeason && e.episode === lastEpisode)
  if (lastIndex === -1 || lastIndex === allEpisodes.length - 1) return null

  return allEpisodes[lastIndex + 1]
}

// Minimum position (2 min in) and completion ceiling (92%) for a session to
// count as "partway through" - below the floor is a barely-started click
// that would be noise to resume, above the ceiling is close enough to done
// that the next episode is what the person actually wants (the same ballpark
// thresholds streaming apps themselves use for their own resume rows).
// lastPosition/totalDuration come from WatchSession, which records them from
// state.timeOffset/state.duration only - the position field that's bounded
// by the item's own runtime and safe to read at a point in time (see
// CLAUDE.md on timeOffset vs overallTimeWatched; overallTimeWatched is
// never used here).
const RESUME_MIN_POSITION_MS = 2 * 60 * 1000
const RESUME_MAX_RATIO = 0.92

/**
 * Places an episode number that the show's episode list doesn't contain.
 *
 * Anime is the reason this exists. Players, addons and release groups very
 * often count anime by ABSOLUTE episode number - episode 137 - while
 * Cinemeta lists the same show in seasons, where that episode is S7E12. The
 * watched pair then matches nothing in allEpisodes, findNextEpisode gives
 * up, and the show silently disappears out of Continue Watching. Someone
 * mid-way through a long-running anime just stops seeing it, with nothing
 * to explain why.
 *
 * The conversion is arithmetic on the show's OWN episode list: absolute
 * episode N is the Nth episode in broadcast order, which is exactly what
 * that list is once specials (season 0) are excluded - fetchMetadata
 * already drops those. AniList was the obvious source here and is wrong for
 * it: utils/anilist.js can only walk one hop of the prequel/sequel graph
 * from whichever entry a title search matched, so its chain is partial and
 * its season NUMBERS are positions in that partial chain - measured live,
 * absolute 30 of Attack on Titan came back as S3E3 when the honest answer
 * is S2E5. A wrong season here would resume someone on an episode they
 * have not reached, which is worse than the show being missing.
 *
 * The gate is deliberately narrow, because a pair missing from the list can
 * also just be bad data on a normal show, and shifting THAT onto some other
 * episode would be its own bug:
 *   - the record says season 1, which is how absolute numbering always
 *     arrives (nothing reports "season 4, episode 137"),
 *   - the show is animation, per its own genres,
 *   - it has more than one season, and the number is past the end of the
 *     first one - below that, absolute and per-season numbering agree and
 *     there is nothing to convert,
 *   - the number is within the total episode count.
 * Anything else returns null and the show stays out of the row.
 */
function placeAbsoluteEpisode(metadata, season, episode) {
  const abs = Number(episode)
  if (season !== 1 || !Number.isInteger(abs) || abs < 1) return null

  const genres = Array.isArray(metadata?.genres) ? metadata.genres : []
  if (!genres.some((g) => String(g).toLowerCase() === 'animation')) return null

  const ordered = [...(metadata?.allEpisodes || [])]
    .filter((e) => Number.isInteger(e?.season) && Number.isInteger(e?.episode) && e.season > 0)
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
  if (ordered.length === 0 || abs > ordered.length) return null

  const seasons = new Set(ordered.map((e) => e.season))
  if (seasons.size < 2) return null
  const firstSeasonCount = ordered.filter((e) => e.season === ordered[0].season).length
  if (abs <= firstSeasonCount) return null

  const placed = ordered[abs - 1]
  return placed ? { season: placed.season, episode: placed.episode } : null
}

/**
 * Reads how far through an item's most recent viewing the user got, from
 * that item's WatchSession row. Returns { inProgress, progressPercent } -
 * inProgress false when there's no session, no usable position data, or the
 * position falls outside the resume window above. For series, the session
 * must be for the SAME episode as `videoId` (WatchSession is one reused row
 * per show, so its lastPosition belongs to whatever episode videoId says).
 */
async function getResumeState(prisma, accountId, userId, itemId, videoId) {
  let session = null
  try {
    session = await prisma.watchSession.findUnique({
      where: { accountId_userId_itemId: { accountId, userId, itemId } },
      select: { videoId: true, lastPosition: true, totalDuration: true }
    })
  } catch {}

  if (!session || !session.lastPosition || !session.totalDuration) {
    return { inProgress: false, progressPercent: null }
  }
  if (videoId && session.videoId !== videoId) {
    return { inProgress: false, progressPercent: null }
  }

  const ratio = session.lastPosition / session.totalDuration
  const inProgress = session.lastPosition >= RESUME_MIN_POSITION_MS && ratio < RESUME_MAX_RATIO
  return { inProgress, progressPercent: Math.round(ratio * 100) }
}

/**
 * Builds the Continue Watching list for an account: one entry per show with
 * a computable next episode, most-recently-watched shows first, capped to
 * `limit`.
 */
async function getContinueWatching(prisma, accountId, limit = 8) {
  const accountIdValue = accountId || 'default'
  const { resolveOmdbKeyForAccount } = require('./listImport')
  const omdbApiKey = await resolveOmdbKeyForAccount(prisma, accountIdValue)

  // Most recently watched episode per (userId, showId) - fetch a reasonable
  // recent window and reduce in JS rather than fighting SQLite/Prisma
  // groupBy for "latest row per group with full columns".
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) // 120 days
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId: accountIdValue, watchedAt: { gte: since } },
    orderBy: { watchedAt: 'desc' }
  })

  const latestPerShow = new Map()
  for (const row of rows) {
    const key = `${row.userId}:${row.showId}`
    if (!latestPerShow.has(key)) latestPerShow.set(key, row)
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
    select: { id: true, username: true, providerType: true }
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  const dismissed = await prisma.dismissedContinueWatching.findMany({
    where: { accountId: accountIdValue },
    select: { userId: true, showId: true }
  })
  const dismissedKeys = new Set(dismissed.map((d) => `${d.userId}:${d.showId}`))

  const candidates = Array.from(latestPerShow.values())
    .filter((row) => !dismissedKeys.has(`${row.userId}:${row.showId}`))
    .sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime())
    .slice(0, limit * 2) // fetch extra since some won't have a computable next episode

  const results = []
  for (const row of candidates) {
    if (results.length >= limit) break

    const user = userMap.get(row.userId)
    if (!user) continue

    const metadata = await fetchMetadata(row.showId, 'series', row.videoId, omdbApiKey)
    if (!metadata || !metadata.allEpisodes) continue

    // If the last-watched episode itself is still partway through, resume
    // THAT episode - jumping to the next one mid-episode was the reported
    // bug this exists to fix. Only when it's finished (or there's no
    // position data to judge by) does the card advance to the next episode.
    const resumeState = await getResumeState(prisma, accountIdValue, row.userId, row.showId, row.videoId)

    // Everything below works from the watched episode as CINEMETA numbers
    // it, which is not always how it was recorded - see
    // placeAbsoluteEpisode.
    let watchedSeason = row.season
    let watchedEpisode = row.episode
    const inList = metadata.allEpisodes.some((e) => e.season === watchedSeason && e.episode === watchedEpisode)
    if (!inList) {
      const placed = placeAbsoluteEpisode(metadata, watchedSeason, watchedEpisode)
      if (placed) {
        watchedSeason = placed.season
        watchedEpisode = placed.episode
      }
    }

    let target
    let isResume = false
    if (resumeState.inProgress && watchedSeason != null && watchedEpisode != null) {
      const current = metadata.allEpisodes.find((e) => e.season === watchedSeason && e.episode === watchedEpisode)
      target = {
        season: watchedSeason,
        episode: watchedEpisode,
        title: current?.title ?? null,
        thumbnail: current?.thumbnail ?? null
      }
      isResume = true
    } else {
      const next = findNextEpisode(metadata.allEpisodes, watchedSeason, watchedEpisode)
      if (!next) continue
      target = {
        season: next.season,
        episode: next.episode,
        title: next.title,
        thumbnail: next.thumbnail
      }
    }

    const entry = {
      userId: user.id,
      username: user.username,
      providerType: user.providerType,
      contentType: 'series',
      showId: row.showId,
      showName: metadata.title || row.showName,
      poster: metadata.poster || row.poster,
      // Landscape backdrop - the card renders in a 16:9 frame, so this fills
      // it cleanly. The portrait `poster` only gets used as a last resort,
      // where it has to crop hard (the "zoomed in" look).
      background: metadata.background || null,
      lastWatched: { season: watchedSeason, episode: watchedEpisode },
      // Field name kept for client compatibility - when resume=true this is
      // the in-progress episode itself, not actually the "next" one.
      nextEpisode: target,
      resume: isResume,
      progressPercent: isResume ? resumeState.progressPercent : null,
      lastWatchedAt: row.watchedAt,
      imdbRating: metadata.imdbRating || null,
      rottenTomatoes: metadata.rottenTomatoes || null,
      metacritic: metadata.metacritic || null
    }

    if (metadata.imdb_id) {
      // Both branches use a plain native <a href> on the client with no JS
      // in the way (see ContinueWatchingCard in page.tsx) - a prior attempt
      // at JS-driven fallback logic (intercept the click, set location.href
      // programmatically, time a fallback) broke the Stremio link that
      // already worked, because browsers handle a direct anchor click far
      // more reliably than scripted navigation for custom URL schemes. That
      // means neither link can "detect and fall back" if the app isn't
      // installed - same known tradeoff Stremio's link already had, applied
      // symmetrically now that Nuvio has a real scheme to offer too.
      // For a resume entry the link targets the in-progress episode -
      // Stremio itself owns the saved playback position, so opening that
      // episode resumes from where they left off.
      if (user.providerType === 'stremio') {
        const links = buildStremioLinks(metadata.imdb_id, 'series', target.season, target.episode)
        entry.appUrl = links.appUrl
        entry.webUrl = links.webUrl
      } else {
        entry.appUrl = buildNuvioAppUrl('series', metadata.imdb_id)
        entry.webUrl = `https://www.imdb.com/title/${metadata.imdb_id}`
      }
    }

    results.push(entry)
  }

  // In-progress MOVIES - previously absent entirely (only episodeWatchHistory
  // was read, so a movie stopped halfway never appeared anywhere). A movie
  // only qualifies while its WatchSession says it's partway through; finished
  // movies have nothing to continue.
  const movieRows = await prisma.movieWatchHistory.findMany({
    where: { accountId: accountIdValue, watchedAt: { gte: since } },
    orderBy: { watchedAt: 'desc' }
  })
  const latestPerMovie = new Map()
  for (const row of movieRows) {
    const key = `${row.userId}:${row.itemId}`
    if (!latestPerMovie.has(key)) latestPerMovie.set(key, row)
  }

  const movieUsers = await prisma.user.findMany({
    where: { id: { in: [...new Set(movieRows.map((r) => r.userId))] } },
    select: { id: true, username: true, providerType: true }
  })
  for (const u of movieUsers) userMap.set(u.id, u)

  const movieEntries = []
  for (const row of latestPerMovie.values()) {
    // Dismissals reuse the showId column with the movie's own id.
    if (dismissedKeys.has(`${row.userId}:${row.itemId}`)) continue

    const user = userMap.get(row.userId)
    if (!user) continue

    const resumeState = await getResumeState(prisma, accountIdValue, row.userId, row.itemId, null)
    if (!resumeState.inProgress) continue

    const metadata = await fetchMetadata(row.itemId, 'movie', null, omdbApiKey)

    const entry = {
      userId: user.id,
      username: user.username,
      providerType: user.providerType,
      contentType: 'movie',
      showId: row.itemId,
      showName: metadata?.title || row.itemName,
      poster: metadata?.poster || row.poster,
      background: metadata?.background || null,
      lastWatched: null,
      nextEpisode: null,
      resume: true,
      progressPercent: resumeState.progressPercent,
      lastWatchedAt: row.watchedAt,
      imdbRating: metadata?.imdbRating || null,
      rottenTomatoes: metadata?.rottenTomatoes || null,
      metacritic: metadata?.metacritic || null
    }

    const imdbId = metadata?.imdb_id || (row.itemId.startsWith('tt') ? row.itemId : null)
    if (imdbId) {
      if (user.providerType === 'stremio') {
        const links = buildStremioLinks(imdbId, 'movie')
        entry.appUrl = links.appUrl
        entry.webUrl = links.webUrl
      } else {
        entry.appUrl = buildNuvioAppUrl('movie', imdbId)
        entry.webUrl = `https://www.imdb.com/title/${imdbId}`
      }
    }

    movieEntries.push(entry)
  }

  // Merge, most recently watched first, and re-cap - movies compete for the
  // same row as shows rather than getting bolted onto the end.
  return [...results, ...movieEntries]
    .sort((a, b) => new Date(b.lastWatchedAt).getTime() - new Date(a.lastWatchedAt).getTime())
    .slice(0, limit)
}

/**
 * Removes a show from the account's Continue Watching row. Persisted
 * server-side (not localStorage) so a dismissal made from one browser or
 * device stays dismissed everywhere.
 */
async function dismissContinueWatching(prisma, accountId, userId, showId) {
  const accountIdValue = accountId || 'default'
  await prisma.dismissedContinueWatching.upsert({
    where: { accountId_userId_showId: { accountId: accountIdValue, userId, showId } },
    create: { accountId: accountIdValue, userId, showId },
    update: {}
  })
}


// The inverse of getContinueWatching: shows someone genuinely started and
// then stopped watching, long enough ago that they are not "in progress" in
// any honest sense.
//
// Continue Watching deliberately looks at a 120-day window, so anything
// older silently vanishes from the app entirely - it is neither resumable
// nor acknowledged, it is just gone. This surfaces exactly that population
// so it can be dealt with: pick it back up, or bury it and stop thinking
// about it.
//
// Reuses DismissedContinueWatching for burying rather than adding a second
// dismissal table - "I am done with this show" is the same statement in
// both places, and a show buried here should equally never resurface in
// Continue Watching if it somehow became recent again.
const ABANDONED_AFTER_DAYS = 45

async function getAbandonedShows(prisma, accountId, limit = 20) {
  const accountIdValue = accountId || 'default'
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_DAYS * 24 * 60 * 60 * 1000)

  // Every episode row for this account, newest first, so the first row seen
  // per (user, show) is that pairing's most recent watch - same reduce-in-JS
  // approach getContinueWatching uses and for the same reason.
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId: accountIdValue },
    orderBy: { watchedAt: 'desc' },
    select: {
      userId: true, showId: true, showName: true, season: true, episode: true,
      poster: true, watchedAt: true, completed: true,
    },
  })

  const latestPerShow = new Map()
  const episodeCounts = new Map()
  for (const row of rows) {
    const key = `${row.userId}:${row.showId}`
    episodeCounts.set(key, (episodeCounts.get(key) || 0) + 1)
    if (!latestPerShow.has(key)) latestPerShow.set(key, row)
  }

  const dismissed = await prisma.dismissedContinueWatching.findMany({
    where: { accountId: accountIdValue },
    select: { userId: true, showId: true },
  })
  const dismissedKeys = new Set(dismissed.map((d) => `${d.userId}:${d.showId}`))

  const candidates = []
  for (const [key, row] of latestPerShow) {
    if (dismissedKeys.has(key)) continue
    if (new Date(row.watchedAt) > cutoff) continue
    // A show whose most recent watched episode is marked completed was
    // finished, not abandoned - that is a different thing entirely and does
    // not belong in a "you never finished these" list.
    if (row.completed === true) continue
    candidates.push({ key, row, episodesWatched: episodeCounts.get(key) || 1 })
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(candidates.map((c) => c.row.userId))] } },
    select: { id: true, username: true, providerType: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  return candidates
    // Longest-abandoned first: the ones most likely to be a genuine "no, I am
    // never going back to this" and quickest to clear out.
    .sort((a, b) => new Date(a.row.watchedAt) - new Date(b.row.watchedAt))
    .slice(0, limit)
    .map(({ row, episodesWatched }) => ({
      userId: row.userId,
      username: userMap.get(row.userId)?.username || 'Unknown',
      providerType: userMap.get(row.userId)?.providerType || null,
      showId: row.showId,
      showName: row.showName,
      poster: row.poster,
      lastSeason: row.season,
      lastEpisode: row.episode,
      episodesWatched,
      lastWatchedAt: row.watchedAt,
      daysSince: Math.floor((Date.now() - new Date(row.watchedAt).getTime()) / (24 * 60 * 60 * 1000)),
    }))
}

// The Graveyard proper: what burying actually produced. Burying reuses the
// Continue Watching dismissal (see the comment above getAbandonedShows), so
// this lists that table - which means a show dismissed from Continue
// Watching rests here too. That is correct, not incidental: both gestures
// say "done with this", and a graveyard that silently omitted half its
// occupants would be the old vanishing problem all over again.
async function getBuriedShows(prisma, accountId) {
  const accountIdValue = accountId || 'default'
  const dismissed = await prisma.dismissedContinueWatching.findMany({
    // Tombstones (wiped shows) stay out of the graveyard - they exist only
    // to keep Continue Watching from resurfacing what was erased.
    where: { accountId: accountIdValue, wipedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (dismissed.length === 0) return []

  // Enrich from watch history - the dismissal row itself stores only ids.
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId: accountIdValue, showId: { in: [...new Set(dismissed.map((d) => d.showId))] } },
    orderBy: { watchedAt: 'desc' },
    select: { userId: true, showId: true, showName: true, season: true, episode: true, poster: true, watchedAt: true },
  })
  const latest = new Map()
  const counts = new Map()
  for (const r of rows) {
    const key = `${r.userId}:${r.showId}`
    counts.set(key, (counts.get(key) || 0) + 1)
    if (!latest.has(key)) latest.set(key, r)
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(dismissed.map((d) => d.userId))] } },
    select: { id: true, username: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u.username]))

  // Movie burials have no episode rows - name and poster come from the
  // movie history instead (a buried movie used to list as its bare tt id).
  const movieRows = await prisma.movieWatchHistory.findMany({
    where: { accountId: accountIdValue, itemId: { in: [...new Set(dismissed.map((d) => d.showId))] } },
    select: { userId: true, itemId: true, itemName: true, poster: true, watchedAt: true },
  }).catch(() => [])
  const movieByKey = new Map(movieRows.map((m) => [`${m.userId}:${m.itemId}`, m]))

  return dismissed.map((d) => {
    const hist = latest.get(`${d.userId}:${d.showId}`) || null
    const movie = movieByKey.get(`${d.userId}:${d.showId}`) || null
    return {
      userId: d.userId,
      username: userMap.get(d.userId) || 'Unknown',
      showId: d.showId,
      showName: hist?.showName || movie?.itemName || d.showId,
      poster: hist?.poster || movie?.poster || null,
      lastSeason: hist?.season ?? null,
      lastEpisode: hist?.episode ?? null,
      lastWatchedAt: hist?.watchedAt || movie?.watchedAt || null,
      episodesWatched: counts.get(`${d.userId}:${d.showId}`) || 0,
      buriedAt: d.createdAt,
    }
  })
}

/** Dig a show back up: the dismissal is removed, so it reappears in
 * Continue Watching (if recent) or the abandoned list (if not). */
async function unburyShow(prisma, accountId, userId, showId) {
  await prisma.dismissedContinueWatching.deleteMany({
    where: { accountId: accountId || 'default', userId, showId },
  })
}

/**
 * The permanent exit: erase a buried title's watch history entirely - every
 * episode row for that user+show, AND its movie history (a buried movie has
 * no episode rows at all; the first version deleted only episodes, so a
 * wiped movie kept its history). The dismissal is NOT deleted: it becomes a
 * tombstone (wipedAt set). The provider's own library still remembers the
 * title's progress, and the native poller re-writes history rows from it -
 * without the tombstone, a wiped title resurfaced in Continue Watching
 * within minutes (confirmed live 2026-09-03, twice).
 */
async function wipeBuriedShow(prisma, accountId, userId, showId) {
  const accountIdValue = accountId || 'default'
  const [episodes, movies] = await prisma.$transaction([
    prisma.episodeWatchHistory.deleteMany({ where: { accountId: accountIdValue, userId, showId } }),
    prisma.movieWatchHistory.deleteMany({ where: { accountId: accountIdValue, userId, itemId: showId } }),
  ])
  // Upsert, not update: this also repairs a title whose dismissal was
  // deleted by the pre-tombstone wipe.
  await prisma.dismissedContinueWatching.upsert({
    where: { accountId_userId_showId: { accountId: accountIdValue, userId, showId } },
    create: { accountId: accountIdValue, userId, showId, wipedAt: new Date() },
    update: { wipedAt: new Date() },
  })
  return { episodesDeleted: episodes.count, moviesDeleted: movies.count }
}

module.exports = { getContinueWatching, dismissContinueWatching, getAbandonedShows, getBuriedShows, unburyShow, wipeBuriedShow, ABANDONED_AFTER_DAYS, placeAbsoluteEpisode }
