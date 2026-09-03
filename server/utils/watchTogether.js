// Watch-ahead protection - "we're watching this together".
//
// The problem is social, not technical: two people watching a show together,
// one of them quietly two episodes ahead by Thursday. No tracker prevents
// this because no tracker KNOWS the show is shared - SlickSync does, the
// moment a pact is declared: a show plus the set of people watching it
// together.
//
// The shared frontier is the furthest episode EVERYONE in the pact has seen
// (the minimum of the members' individual furthest points). When a pact
// member starts an episode past what another member has seen, the household
// gets told - by name, with the episode - the moment the watch is first
// recorded. Detection rides the existing watch pipeline (metricsProcessor
// calls checkWatchAhead on each NEW episode record), so there is no poller
// and nothing to schedule.
//
// This never blocks playback - SlickSync doesn't sit in the play path and
// wouldn't want to. It makes the betrayal visible while there's still time
// to grab the remote, which is the most a sync manager can honestly offer.

function epNum(season, episode) {
  return Number.isFinite(season) && Number.isFinite(episode) ? season * 10000 + episode : null
}

function parseUserIds(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Each member's furthest-watched episode of a show: Map(userId -> {num, season, episode}). */
async function furthestByUser(prisma, accountId, showId, userIds) {
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId, showId, userId: { in: userIds } },
    select: { userId: true, season: true, episode: true },
  })
  const best = new Map()
  for (const r of rows) {
    const num = epNum(r.season, r.episode)
    if (num === null) continue
    const cur = best.get(r.userId)
    if (!cur || num > cur.num) best.set(r.userId, { num, season: r.season, episode: r.episode })
  }
  return best
}

/** Pacts with members, per-member progress, and the shared frontier. */
async function listPacts(prisma, accountId) {
  const accountIdValue = accountId || 'default'
  const pacts = await prisma.watchTogetherShow.findMany({
    where: { accountId: accountIdValue },
    orderBy: { createdAt: 'desc' },
  })
  const out = []
  for (const pact of pacts) {
    const userIds = parseUserIds(pact.userIds)
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, accountId: accountIdValue },
      select: { id: true, username: true, colorIndex: true, avatarUrl: true },
    })
    const progress = await furthestByUser(prisma, accountIdValue, pact.showId, userIds)
    const members = userIds
      .map((id) => users.find((u) => u.id === id))
      .filter(Boolean)
      .map((u) => {
        const p = progress.get(u.id) || null
        return { userId: u.id, username: u.username, colorIndex: u.colorIndex, avatarUrl: u.avatarUrl, furthest: p ? { season: p.season, episode: p.episode } : null }
      })
    // Frontier = the slowest member's furthest point. A member who has not
    // started yet pins it at "nothing yet" - which is true: any episode is
    // ahead of them.
    let frontier = null
    let frontierNum = Infinity
    let everyoneStarted = true
    for (const m of members) {
      const num = m.furthest ? epNum(m.furthest.season, m.furthest.episode) : null
      if (num === null) { everyoneStarted = false; frontierNum = -1; continue }
      if (num < frontierNum) { frontierNum = num; frontier = m.furthest }
    }
    if (!everyoneStarted) frontier = null
    const waitingOn = members
      .filter((m) => {
        const num = m.furthest ? epNum(m.furthest.season, m.furthest.episode) : -1
        return num <= (everyoneStarted ? frontierNum : -1)
      })
      .map((m) => m.username)
    out.push({
      showId: pact.showId,
      showName: pact.showName,
      members,
      frontier, // null until everyone has started
      waitingOn,
      createdAt: pact.createdAt,
    })
  }
  return out
}

async function upsertPact(prisma, accountId, { showId, showName, userIds }) {
  const accountIdValue = accountId || 'default'
  const ids = Array.isArray(userIds) ? [...new Set(userIds.filter((x) => typeof x === 'string' && x))] : []
  if (!showId || typeof showId !== 'string') throw new Error('showId is required')
  if (ids.length < 2) throw new Error('Watching together takes at least two people')
  const found = await prisma.user.count({ where: { id: { in: ids }, accountId: accountIdValue } })
  if (found !== ids.length) throw new Error('One of those users does not exist on this account')
  return prisma.watchTogetherShow.upsert({
    where: { accountId_showId: { accountId: accountIdValue, showId } },
    create: { accountId: accountIdValue, showId, showName: showName || showId, userIds: JSON.stringify(ids) },
    update: { showName: showName || showId, userIds: JSON.stringify(ids) },
  })
}

async function deletePact(prisma, accountId, showId) {
  await prisma.watchTogetherShow.deleteMany({ where: { accountId: accountId || 'default', showId } })
}

/**
 * Called by the watch pipeline on each NEW episode record. Quiet unless the
 * show has a pact, the watcher is in it, and the episode is past what some
 * other member has seen - then one alert (bell always, push when configured,
 * automation event for custom rules), deduped per watcher+episode.
 */
async function checkWatchAhead(prisma, accountId, { userId, showId, showName, season, episode, videoId }) {
  const accountIdValue = accountId || 'default'
  const watched = epNum(season, episode)
  if (watched === null) return null

  const pact = await prisma.watchTogetherShow.findUnique({
    where: { accountId_showId: { accountId: accountIdValue, showId } },
  }).catch(() => null)
  if (!pact) return null

  // Feature switch (Settings -> SlickTrax): off means no alerts fire even
  // for standing pacts - checked only after a pact matched, so the common
  // no-pact case costs nothing extra.
  try {
    const acc = await prisma.appAccount.findUnique({ where: { id: accountIdValue }, select: { sync: true } })
    let cfg = acc?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    if (cfg && cfg.enableWatchTogether === false) return null
  } catch {}

  const userIds = parseUserIds(pact.userIds)
  if (!userIds.includes(userId)) return null
  const others = userIds.filter((id) => id !== userId)
  if (others.length === 0) return null

  const progress = await furthestByUser(prisma, accountIdValue, showId, others)
  const behindIds = others.filter((id) => (progress.get(id)?.num ?? -1) < watched)
  if (behindIds.length === 0) return null

  const users = await prisma.user.findMany({
    where: { id: { in: [userId, ...behindIds] } },
    select: { id: true, username: true },
  })
  const nameOf = (id) => users.find((u) => u.id === id)?.username || 'Someone'
  const watcherName = nameOf(userId)
  const behindNames = behindIds.map(nameOf)
  const behindList = behindNames.length === 1
    ? behindNames[0]
    : `${behindNames.slice(0, -1).join(', ')} and ${behindNames[behindNames.length - 1]}`

  const title = `${watcherName} is watching ahead on ${pact.showName || showName}`
  const body = `S${season}E${episode} just started - ${behindList} ${behindNames.length === 1 ? 'has' : 'have'} not seen it yet. You said you were watching this together.`

  try {
    const { createNotification } = require('./notificationStore')
    await createNotification(prisma, accountIdValue, {
      type: 'activity',
      title,
      body,
      url: '/activity',
      // One alert per watcher per episode - a pause/resume of the same
      // episode must not nag twice, and dedupe survives restarts.
      dedupeKey: `watchahead-${userId}-${videoId || `${season}x${episode}`}`,
    })
  } catch (e) {
    console.warn('[WatchTogether] bell dispatch failed:', e?.message)
  }
  try {
    const { isPushEnabled, sendPushToAccount } = require('./pushNotifications')
    if (isPushEnabled()) {
      await sendPushToAccount(prisma, accountIdValue, { title, body, url: '/activity' })
    }
  } catch (e) {
    console.warn('[WatchTogether] push dispatch failed:', e?.message)
  }
  try {
    const { emitAutomationEvent } = require('./automation/engine')
    await emitAutomationEvent(prisma, accountIdValue, 'watch.ahead', {
      username: watcherName,
      userId,
      itemName: pact.showName || showName,
      showId,
      season,
      episode,
      behindUsernames: behindList,
    })
  } catch { /* emit never throws; guards the require itself */ }

  return { behind: behindNames }
}

module.exports = { listPacts, upsertPact, deletePact, checkWatchAhead, furthestByUser, epNum }
