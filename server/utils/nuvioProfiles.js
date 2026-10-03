// Nuvio profiles and the people they count for.
//
// One Nuvio login can hold several profiles, like Netflix. Every person here
// on the same Nuvio account shares that one login, and the history poller
// reads the account once per person. Which profile's viewing belongs to whom
// is decided here, in one place, so the poller, the library pages and the
// Profiles card can never disagree.
//
// The default needs no setup: a profile with its own person here counts for
// them, and every other profile counts for the account's main person - the
// one on the lowest profile, normally profile 1. A NuvioProfileRoute row says
// otherwise: another person on the same Nuvio account, or nobody at all.
//
// Before this existed every person read every profile, so a household that
// gave each profile its own person had everyone's viewing on everyone.

const fs = require('fs')
const path = require('path')
const { migrateTable, runLongTransaction, NATURAL_KEY } = require('./userMerge')

const PERSON_SELECT = {
  id: true, username: true, email: true, nuvioProfileId: true, isActive: true,
  colorIndex: true, avatarUrl: true, useGravatar: true, accountId: true,
}

function profileOf(user) {
  const n = Number(user?.nuvioProfileId)
  return Number.isInteger(n) && n > 0 ? n : 1
}

/** Everyone here on one Nuvio account, main profile first. */
async function loadSiblings(prisma, accountId, nuvioUserId) {
  if (!nuvioUserId) return []
  const rows = await prisma.user.findMany({
    where: { accountId, providerType: 'nuvio', nuvioUserId },
    select: { ...PERSON_SELECT, createdAt: true },
  })
  return rows.sort((a, b) => profileOf(a) - profileOf(b) || new Date(a.createdAt) - new Date(b.createdAt))
}

async function loadRoutes(prisma, accountId, nuvioUserId) {
  const rows = await prisma.nuvioProfileRoute.findMany({ where: { accountId, nuvioUserId } })
  return new Map(rows.map((r) => [r.profileIndex, r]))
}

/**
 * Whose viewing a profile is: a person's id, or null when it is not counted.
 * A profile's own person always wins, so a stale route can never take a
 * profile away from the person made for it.
 */
function ownerOf(profileIndex, siblings, routes) {
  const own = siblings.find((s) => profileOf(s) === profileIndex)
  if (own) return own.id
  const route = routes.get(profileIndex)
  if (route?.skip) return null
  if (route?.targetUserId && siblings.some((s) => s.id === route.targetUserId)) return route.targetUserId
  return siblings[0]?.id || null
}

/**
 * Of a Nuvio account's profiles, the ones this person records. Anyone who is
 * not a Nuvio person here - a Stremio user holding a merged-in Nuvio login,
 * say - keeps reading every profile, exactly as before.
 */
async function ownedProfileIndexes(prisma, userId, allIndexes) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, accountId: true, providerType: true, nuvioUserId: true },
  })
  if (!user || user.providerType !== 'nuvio' || !user.nuvioUserId) return allIndexes
  const accountId = user.accountId || 'default'
  const [siblings, routes] = await Promise.all([
    loadSiblings(prisma, accountId, user.nuvioUserId),
    loadRoutes(prisma, accountId, user.nuvioUserId),
  ])
  if (!siblings.some((s) => s.id === user.id)) return allIndexes
  return allIndexes.filter((index) => ownerOf(index, siblings, routes) === user.id)
}

// ---------------------------------------------------------------------------
// Moving a profile's history between people

function laterOf(a, b) {
  return new Date(Math.max(new Date(a).getTime(), new Date(b).getTime()))
}

/** One title, two people's rows: the strongest facts of both survive. */
function combineHistory(kept, incoming, isMovie) {
  const data = {
    completed: kept.completed === true || incoming.completed === true ? true : (kept.completed ?? incoming.completed ?? null),
    durationSeconds: Math.max(kept.durationSeconds || 0, incoming.durationSeconds || 0) || null,
    watchedAt: laterOf(kept.watchedAt, incoming.watchedAt),
  }
  if (isMovie) data.rewatchCount = Math.max(kept.rewatchCount || 0, incoming.rewatchCount || 0)
  return data
}

/**
 * Move one profile's history from one person to another. History rows carry
 * the profile they were watched under, so they move exactly. Watch time only
 * carries it from this version on; an older row moves when the title it is
 * for left the person entirely with this move, which means it can only have
 * come from that profile.
 */
async function moveProfileHistory(tx, { accountId, fromUserId, toUserId, profileLabel, since = null, moveActivity = true }) {
  const counts = { movies: 0, episodes: 0, activity: 0 }
  if (!profileLabel || !fromUserId || !toUserId || fromUserId === toUserId) return counts
  const watchedSince = since ? { watchedAt: { gte: since } } : {}

  const movedMovieIds = []
  const movies = await tx.movieWatchHistory.findMany({ where: { accountId, userId: fromUserId, profileLabel, ...watchedSince } })
  for (const row of movies) {
    const existing = await tx.movieWatchHistory.findFirst({ where: { accountId, userId: toUserId, itemId: row.itemId } })
    if (existing) {
      await tx.movieWatchHistory.update({ where: { id: existing.id }, data: combineHistory(existing, row, true) })
      await tx.movieWatchHistory.delete({ where: { id: row.id } })
    } else {
      await tx.movieWatchHistory.update({ where: { id: row.id }, data: { userId: toUserId } })
    }
    movedMovieIds.push(row.itemId)
    counts.movies++
  }

  const movedVideoIds = []
  const episodes = await tx.episodeWatchHistory.findMany({ where: { accountId, userId: fromUserId, profileLabel, ...watchedSince } })
  for (const row of episodes) {
    const existing = await tx.episodeWatchHistory.findFirst({ where: { accountId, userId: toUserId, videoId: row.videoId } })
    if (existing) {
      await tx.episodeWatchHistory.update({ where: { id: existing.id }, data: combineHistory(existing, row, false) })
      await tx.episodeWatchHistory.delete({ where: { id: row.id } })
    } else {
      await tx.episodeWatchHistory.update({ where: { id: row.id }, data: { userId: toUserId } })
    }
    movedVideoIds.push(row.videoId)
    counts.episodes++
  }

  if (!moveActivity) return counts

  const createdSince = since ? { createdAt: { gte: since } } : {}
  const labelled = await tx.watchActivity.updateMany({
    where: { accountId, userId: fromUserId, profileLabel, ...createdSince },
    data: { userId: toUserId },
  })
  counts.activity += labelled.count

  if (!since) {
    const unlabelled = []
    if (movedMovieIds.length) unlabelled.push({ itemType: 'movie', itemId: { in: movedMovieIds } })
    if (movedVideoIds.length) unlabelled.push({ videoId: { in: movedVideoIds } })
    if (unlabelled.length) {
      const old = await tx.watchActivity.updateMany({
        where: { accountId, userId: fromUserId, profileLabel: null, OR: unlabelled },
        data: { userId: toUserId, profileLabel },
      })
      counts.activity += old.count
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// Merging a profile's own person into another person, and separating them

function archiveDir(dataDir) {
  return path.join(dataDir, 'backup', 'merges')
}

/** Point any AIOStreams profile linked to one person at another instead. */
async function repointViewerLinks(tx, accountId, fromUserId, toUserId) {
  const changed = {}
  const owners = await tx.user.findMany({
    where: { accountId, watchStateViewers: { contains: fromUserId } },
    select: { id: true, watchStateViewers: true },
  })
  for (const owner of owners) {
    let map = {}
    try { map = JSON.parse(owner.watchStateViewers || '{}') || {} } catch { map = {} }
    const viewers = Object.keys(map).filter((v) => map[v] === fromUserId)
    if (!viewers.length) continue
    for (const v of viewers) map[v] = toUserId
    await tx.user.update({ where: { id: owner.id }, data: { watchStateViewers: JSON.stringify(map) } })
    changed[owner.id] = viewers
  }
  return changed
}

/**
 * Merge a profile's own person into another person on the same Nuvio
 * account: everything they recorded moves across, the profile counts for the
 * survivor from now on, and the donor leaves the Users list. Same collision
 * rules and the same archive-for-undo as merging two providers' accounts.
 */
async function mergeProfilePerson(prisma, { accountId, survivorId, donorId, profileName = null, dataDir = path.join(process.cwd(), 'data') }) {
  if (survivorId === donorId) throw new Error('That is the same person')
  const [survivor, donorFull] = await Promise.all([
    prisma.user.findFirst({ where: { id: survivorId, accountId } }),
    prisma.user.findFirst({ where: { id: donorId, accountId } }),
  ])
  if (!survivor || !donorFull) throw new Error('Person not found')
  if (survivor.providerType !== 'nuvio' || donorFull.providerType !== 'nuvio' || !donorFull.nuvioUserId || survivor.nuvioUserId !== donorFull.nuvioUserId) {
    throw new Error('Both people must be on the same Nuvio account')
  }
  const profileIndex = profileOf(donorFull)

  fs.mkdirSync(archiveDir(dataDir), { recursive: true })
  const archiveFilename = `profile-${donorId}-${Date.now()}.json`
  const archive = { donorRows: {}, overwrittenSurvivorRows: {}, donorGroupIds: [], viewerLinks: {}, routeBefore: null }

  await runLongTransaction(prisma, async (tx) => {
    const key = { accountId_nuvioUserId_profileIndex: { accountId, nuvioUserId: donorFull.nuvioUserId, profileIndex } }
    archive.routeBefore = await tx.nuvioProfileRoute.findUnique({ where: key })
    await tx.nuvioProfileRoute.upsert({
      where: key,
      create: { accountId, nuvioUserId: donorFull.nuvioUserId, profileIndex, targetUserId: survivorId, skip: false },
      update: { targetUserId: survivorId, skip: false },
    })

    const activity = await tx.watchActivity.findMany({ where: { userId: donorId } })
    archive.donorRows.watchActivity = activity
    await tx.watchActivity.updateMany({ where: { userId: donorId }, data: { userId: survivorId } })

    await migrateTable(tx, 'movieWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({ userId: survivorId, accountId: row.accountId, itemId: row.itemId }), { archive })
    await migrateTable(tx, 'episodeWatchHistory', survivorId, donorId, 'watchedAt', (row) => ({ userId: survivorId, accountId: row.accountId, videoId: row.videoId }), { archive })
    await migrateTable(tx, 'watchSnapshot', survivorId, donorId, 'date', (row) => ({ userId: survivorId, accountId: row.accountId, itemId: row.itemId, date: row.date }), { archive })
    await migrateTable(tx, 'watchSession', survivorId, donorId, 'startTime', (row) => ({ userId: survivorId, accountId: row.accountId, itemId: row.itemId }), { archive, preferActive: true })

    const dismissed = await tx.dismissedContinueWatching.findMany({ where: { userId: donorId } })
    archive.donorRows.dismissedContinueWatching = dismissed
    for (const row of dismissed) {
      const existing = await tx.dismissedContinueWatching.findFirst({ where: { userId: survivorId, accountId: row.accountId, showId: row.showId } })
      if (existing) await tx.dismissedContinueWatching.delete({ where: { id: row.id } })
      else await tx.dismissedContinueWatching.update({ where: { id: row.id }, data: { userId: survivorId } })
    }

    // Half-finished AIOStreams viewings are only live state; nothing to keep.
    await tx.watchStateCursor.deleteMany({ where: { userId: donorId } })
    await tx.watchStateEvent.deleteMany({ where: { userId: donorId } })
    archive.viewerLinks = await repointViewerLinks(tx, accountId, donorId, survivorId)

    const groups = await tx.group.findMany({ where: { accountId, userIds: { contains: donorId } } })
    archive.donorGroupIds = groups.map((g) => g.id)
    for (const group of groups) {
      let ids = []
      try { ids = JSON.parse(group.userIds || '[]') } catch { ids = [] }
      const next = ids.filter((id) => id !== donorId)
      if (next.length !== ids.length) await tx.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(next) } })
    }

    await tx.user.delete({ where: { id: donorId } })
    await tx.profileMerge.create({
      data: {
        accountId, nuvioUserId: donorFull.nuvioUserId, profileIndex, profileName,
        survivorId, donorId, donorUsername: donorFull.username, archivePath: archiveFilename,
      },
    })
  })

  fs.writeFileSync(path.join(archiveDir(dataDir), archiveFilename), JSON.stringify({
    kind: 'profile-merge', mergedAt: new Date().toISOString(), survivorId, donorId, donor: donorFull, ...archive,
  }, null, 2))

  return { survivorId, donorId, donorUsername: donorFull.username, profileIndex }
}

/**
 * Separate a merged profile person again: the original person comes back
 * with the same id, groups and history, and so does anything watched on that
 * profile while it was merged.
 */
async function unmergeProfilePerson(prisma, { accountId, mergeId, dataDir = path.join(process.cwd(), 'data') }) {
  const record = await prisma.profileMerge.findFirst({ where: { id: mergeId, accountId, undoneAt: null } })
  if (!record) throw new Error('Nothing to separate')
  const archivePath = path.join(archiveDir(dataDir), record.archivePath)
  if (!fs.existsSync(archivePath)) throw new Error('The record of this merge is missing on disk, so it cannot be separated safely')
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'))
  const { donorId, donor, donorRows = {}, overwrittenSurvivorRows = {}, donorGroupIds = [], viewerLinks = {}, mergedAt } = archive
  if (donorId !== record.donorId) throw new Error('The merge record does not match this profile')
  if (await prisma.user.findUnique({ where: { id: donorId } })) throw new Error('That person already exists again')
  const survivorId = record.survivorId

  let carried = { movies: 0, episodes: 0, activity: 0 }
  await runLongTransaction(prisma, async (tx) => {
    const { id: _id, ...fields } = donor
    await tx.user.create({ data: { id: donorId, ...fields } })

    // Checked first rather than caught: on Postgres a failed write inside a
    // transaction aborts the whole transaction, caught or not.
    for (const modelName of Object.keys(NATURAL_KEY)) {
      for (const row of donorRows[modelName] || []) {
        const live = await tx[modelName].findUnique({ where: { id: row.id } })
        if (live) {
          await tx[modelName].update({ where: { id: row.id }, data: { userId: donorId } })
          continue
        }
        const restored = { ...row, userId: donorId }
        if (await tx[modelName].findFirst({ where: NATURAL_KEY[modelName](restored) })) continue
        await tx[modelName].create({ data: restored })
      }
    }
    for (const modelName of Object.keys(overwrittenSurvivorRows)) {
      if (!NATURAL_KEY[modelName]) continue
      for (const row of overwrittenSurvivorRows[modelName]) {
        if (await tx[modelName].findUnique({ where: { id: row.id } })) continue
        // The survivor may have watched the same title since; theirs stays.
        if (await tx[modelName].findFirst({ where: NATURAL_KEY[modelName](row) })) continue
        await tx[modelName].create({ data: row })
      }
    }
    for (const row of donorRows.watchActivity || []) {
      await tx.watchActivity.updateMany({ where: { id: row.id }, data: { userId: donorId } })
    }

    // Whatever was watched on this profile while it was merged goes back too.
    carried = await moveProfileHistory(tx, {
      accountId, fromUserId: survivorId, toUserId: donorId, profileLabel: record.profileName,
      since: mergedAt ? new Date(mergedAt) : record.createdAt,
    })

    if (donorGroupIds.length) {
      const groups = await tx.group.findMany({ where: { id: { in: donorGroupIds } } })
      for (const group of groups) {
        let ids = []
        try { ids = JSON.parse(group.userIds || '[]') } catch { ids = [] }
        if (!ids.includes(donorId)) await tx.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify([...ids, donorId]) } })
      }
    }
    for (const [ownerId, viewers] of Object.entries(viewerLinks)) {
      const owner = await tx.user.findUnique({ where: { id: ownerId }, select: { watchStateViewers: true } })
      if (!owner) continue
      let map = {}
      try { map = JSON.parse(owner.watchStateViewers || '{}') || {} } catch { map = {} }
      for (const v of viewers) if (map[v] === survivorId) map[v] = donorId
      await tx.user.update({ where: { id: ownerId }, data: { watchStateViewers: JSON.stringify(map) } })
    }

    // The person is back, and a profile's own person always counts for it.
    await tx.nuvioProfileRoute.deleteMany({ where: { accountId, nuvioUserId: record.nuvioUserId, profileIndex: record.profileIndex } })
    await tx.profileMerge.update({ where: { id: record.id }, data: { undoneAt: new Date() } })
  })

  try { fs.renameSync(archivePath, `${archivePath}.undone`) } catch { /* already separated; the file name is only a guard */ }
  return { donorId, donorUsername: record.donorUsername, carried }
}

// ---------------------------------------------------------------------------
// History recorded on the wrong person by versions before this one

/** Profile name -> index, from the live profile list. */
function indexByName(profiles) {
  const map = new Map()
  for (const p of profiles || []) {
    const index = Number(p.profile_index ?? p.profileIndex)
    if (p.name && Number.isInteger(index)) map.set(p.name, index)
  }
  return map
}

/**
 * Rows a person holds for a profile that is not theirs. Before profiles were
 * scoped, every person on a Nuvio account recorded every profile, so these
 * are copies of what the right person also has, or viewing that belongs to
 * them.
 */
async function findMisplaced(prisma, accountId, siblings, routes, profiles) {
  const byName = indexByName(profiles)
  const out = []
  if (siblings.length < 2) return out
  for (const person of siblings) {
    const labels = new Set()
    const [m, e] = await Promise.all([
      prisma.movieWatchHistory.findMany({ where: { accountId, userId: person.id, profileLabel: { not: null } }, select: { profileLabel: true }, distinct: ['profileLabel'] }),
      prisma.episodeWatchHistory.findMany({ where: { accountId, userId: person.id, profileLabel: { not: null } }, select: { profileLabel: true }, distinct: ['profileLabel'] }),
    ])
    for (const r of [...m, ...e]) labels.add(r.profileLabel)
    for (const label of labels) {
      const index = byName.get(label)
      if (index === undefined) continue
      const owner = ownerOf(index, siblings, routes)
      if (!owner || owner === person.id) continue
      const [movies, episodes] = await Promise.all([
        prisma.movieWatchHistory.count({ where: { accountId, userId: person.id, profileLabel: label } }),
        prisma.episodeWatchHistory.count({ where: { accountId, userId: person.id, profileLabel: label } }),
      ])
      if (movies + episodes > 0) out.push({ fromUserId: person.id, toUserId: owner, profileLabel: label, movies, episodes })
    }
  }
  return out
}

/** Give each misplaced row to the person whose profile it is. */
async function tidyMisplaced(prisma, accountId, misplaced) {
  const total = { movies: 0, episodes: 0 }
  for (const m of misplaced) {
    await runLongTransaction(prisma, async (tx) => {
      // Watch time stays where it is: the older copies on each person were
      // identical, and the household totals already count them once.
      const moved = await moveProfileHistory(tx, { accountId, fromUserId: m.fromUserId, toUserId: m.toUserId, profileLabel: m.profileLabel, moveActivity: false })
      total.movies += moved.movies
      total.episodes += moved.episodes
    })
  }
  return total
}

module.exports = {
  profileOf,
  loadSiblings,
  loadRoutes,
  ownerOf,
  ownedProfileIndexes,
  moveProfileHistory,
  mergeProfilePerson,
  unmergeProfilePerson,
  findMisplaced,
  tidyMisplaced,
  indexByName,
}
