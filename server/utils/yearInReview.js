// Year in Review (roadmap #8): a read-only, "Wrapped"-style yearly summary
// built by aggregating the metrics tables that already exist. Deliberately its
// own module (not folded into metricsBuilder.js) and read-only - it computes,
// never writes, so it carries none of the watch-time-inflation risk that
// surrounds the write path.
//
// Year/month bucketing is done in the account timezone (never UTC) - same rule
// as the rest of the codebase. We read the tz-local year and month via
// Intl.formatToParts rather than string-slicing getAccountDateString: that
// helper's formatted string is locale-order-dependent (en-CA yields
// YYYY-MM-DD, but a runtime whose ICU falls back to en-US yields MM/DD/YYYY),
// so slicing by position is not portable. formatToParts reads the named parts
// regardless of order.
const { resolveAccountTimezone } = require('./dateUtils')

async function buildYearInReview(prisma, accountId, year, users = []) {
  const accountIdValue = accountId || 'default'
  const tz = await resolveAccountTimezone(prisma, accountIdValue)
  const y = Number(year) || new Date().getFullYear()

  const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
  const ymOf = (d) => {
    const parts = partsFmt.formatToParts(new Date(d))
    const yr = Number(parts.find((p) => p.type === 'year')?.value)
    const mo = Number(parts.find((p) => p.type === 'month')?.value) - 1 // 0-11
    return { yr, mo }
  }

  // A generous UTC window around the target year: a timezone offset can push a
  // local calendar day into an adjacent UTC day, so we over-fetch by a day on
  // each side and then filter precisely by the account-timezone year below.
  const start = new Date(Date.UTC(y - 1, 11, 30))
  const end = new Date(Date.UTC(y + 1, 0, 2))
  const inYear = (d) => d && ymOf(d).yr === y
  const monthOf = (d) => ymOf(d).mo

  const [activity, movies, episodes] = await Promise.all([
    prisma.watchActivity.findMany({
      where: { accountId: accountIdValue, date: { gte: start, lte: end } },
      select: { userId: true, itemType: true, watchTimeSeconds: true, date: true },
    }),
    prisma.movieWatchHistory.findMany({
      where: { accountId: accountIdValue, watchedAt: { gte: start, lte: end } },
      select: { userId: true, itemId: true, itemName: true, poster: true, completed: true, rewatchCount: true, watchedAt: true },
    }),
    prisma.episodeWatchHistory.findMany({
      where: { accountId: accountIdValue, watchedAt: { gte: start, lte: end } },
      select: { userId: true, showId: true, showName: true, poster: true, watchedAt: true },
    }),
  ])

  const userMap = new Map(users.map((u) => [u.id, u]))
  const displayName = (id) => { const u = userMap.get(id); return u ? (u.username || u.email || id) : id }

  // Watch time (the one true duration source is WatchActivity's deltas).
  let totalSeconds = 0
  let movieSeconds = 0
  let seriesSeconds = 0
  const byMonth = Array.from({ length: 12 }, () => 0)
  const perUser = new Map()
  for (const a of activity) {
    if (!inYear(a.date)) continue
    const s = a.watchTimeSeconds || 0
    totalSeconds += s
    byMonth[monthOf(a.date)] += s
    perUser.set(a.userId, (perUser.get(a.userId) || 0) + s)
    if (a.itemType === 'movie') movieSeconds += s
    else seriesSeconds += s
  }

  // Movies.
  const yearMovies = movies.filter((m) => inYear(m.watchedAt))
  const distinctMovies = new Set(yearMovies.map((m) => m.itemId))
  const completedMovies = yearMovies.filter((m) => m.completed === true).length
  const mostRewatched = yearMovies
    .filter((m) => (m.rewatchCount || 0) > 0)
    .sort((a, b) => (b.rewatchCount || 0) - (a.rewatchCount || 0))
    .slice(0, 5)
    .map((m) => ({ id: m.itemId, name: m.itemName, poster: m.poster || null, type: 'movie', rewatchCount: m.rewatchCount || 0 }))

  // Episodes / shows.
  const yearEpisodes = episodes.filter((e) => inYear(e.watchedAt))
  const showCounts = new Map()
  for (const e of yearEpisodes) {
    if (!showCounts.has(e.showId)) showCounts.set(e.showId, { id: e.showId, name: e.showName || 'Unknown', poster: e.poster || null, type: 'series', episodeCount: 0 })
    showCounts.get(e.showId).episodeCount++
  }
  const topShows = [...showCounts.values()].sort((a, b) => b.episodeCount - a.episodeCount).slice(0, 5)

  const perUserArr = [...perUser.entries()]
    .map(([id, seconds]) => ({ userId: id, username: displayName(id), seconds }))
    .sort((a, b) => b.seconds - a.seconds)
  const busiestMonth = byMonth.reduce((best, s, i) => (s > byMonth[best] ? i : best), 0)

  return {
    year: y,
    totalWatchTimeSeconds: totalSeconds,
    movieWatchTimeSeconds: movieSeconds,
    seriesWatchTimeSeconds: seriesSeconds,
    moviesWatched: distinctMovies.size,
    completedMovies,
    episodesWatched: yearEpisodes.length,
    showsWatched: showCounts.size,
    byMonth,
    busiestMonth,
    topShows,
    mostRewatched,
    perUser: perUserArr,
    hasData: totalSeconds > 0 || distinctMovies.size > 0 || yearEpisodes.length > 0,
  }
}

module.exports = { buildYearInReview }
