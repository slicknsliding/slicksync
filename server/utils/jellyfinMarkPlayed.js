// What someone finishes anywhere else - Stremio, Nuvio, AIOStreams - marked
// played on their real Jellyfin server too, so its Next Up and resume points
// stay right.
//
// Who: everyone with a sign-in to a real Jellyfin server, their own or one
// merged into them (UserProviderCredential). AIOStreams already learns what
// was watched through its watch-history link; AIOMetadata keeps no played
// state of its own, so this is for real Jellyfin servers.
//
// How: every 10 minutes, the finished movies and episodes recorded for the
// person since the last pass are looked up on the server, and each one the
// server doesn't already have as played is marked played. Something watched
// on the server itself is already played there, so nothing is written for
// it; imported history is older than the first pass and never pushed.
//
// Titles part-way through elsewhere get the same resume point on the server,
// so they pick up where they left off in a Jellyfin app - only when that
// viewing is newer than what the server last saw, so a later spot reached on
// the server itself is never pulled back.
//
// On for everyone, switchable per person: sync.jellyfinMarkPlayed[personId]
// === false turns it off. Where each person is up to lives in
// sync.jellyfinMarkPlayedCursor.

const { jfRequest, deviceIdFor } = require('../providers/jellyfinAuth')
const { stremioIdFromProviderIds } = require('../providers/jellyfin')
const { hasReachedEnd } = require('./sessionTracker')

const INTERVAL_MS = 10 * 60 * 1000
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000
// History rows can land a little after the viewing they record.
const OVERLAP_MS = 15 * 60 * 1000

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/** Change only the given keys of the account's settings, on a fresh read. */
async function patchSync(prisma, accountId, patch) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const next = { ...cfg }
  for (const [key, value] of Object.entries(patch)) next[key] = { ...(cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {}), ...value }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
}

const isRealJellyfin = (kind) => !kind || kind === 'jellyfin'

/** Every real-Jellyfin sign-in on this account, with the person it belongs to. */
async function signInsFor(prisma, accountId) {
  const people = await prisma.user.findMany({
    where: { accountId, isActive: true },
    select: { id: true, username: true, providerType: true, jellyfinServerKind: true, jellyfinServerUrl: true, jellyfinUserId: true, jellyfinToken: true },
  })
  const byId = new Map(people.map((p) => [p.id, p]))
  const out = []
  for (const p of people) {
    if (p.providerType === 'jellyfin' && isRealJellyfin(p.jellyfinServerKind) && p.jellyfinToken && p.jellyfinServerUrl && p.jellyfinUserId) {
      out.push({ person: p, serverUrl: p.jellyfinServerUrl, jellyfinUserId: p.jellyfinUserId, token: p.jellyfinToken })
    }
  }
  const merged = await prisma.userProviderCredential.findMany({
    where: { userId: { in: people.map((p) => p.id) }, providerType: 'jellyfin' },
    select: { userId: true, jellyfinServerKind: true, jellyfinServerUrl: true, jellyfinUserId: true, jellyfinToken: true },
  }).catch(() => [])
  for (const c of merged) {
    const person = byId.get(c.userId)
    if (!person || !isRealJellyfin(c.jellyfinServerKind) || !c.jellyfinToken || !c.jellyfinServerUrl || !c.jellyfinUserId) continue
    out.push({ person, serverUrl: c.jellyfinServerUrl, jellyfinUserId: c.jellyfinUserId, token: c.jellyfinToken })
  }
  return out
}

async function items(call, params) {
  const data = await call(`/Items?${new URLSearchParams(params)}`)
  return Array.isArray(data?.Items) ? data.Items : []
}

/**
 * Bring one sign-in's server up to date with what was watched elsewhere since
 * `since`: finished titles marked played, and titles part-way through given
 * the same resume point - but only when that viewing is newer than anything
 * the server itself saw, so it never pulls someone back from a later spot.
 * Returns { marked, resumed }.
 */
async function markFor(prisma, accountId, signIn, token, since) {
  const userId = signIn.person.id
  const jfUser = signIn.jellyfinUserId
  const deviceId = deviceIdFor(signIn.serverUrl, jfUser)
  const call = (path, opts = {}) => jfRequest(signIn.serverUrl, path, { token, deviceId, ...opts })
  const markPlayed = (itemId) => call(`/UserPlayedItems/${itemId}?${new URLSearchParams({ userId: jfUser })}`, { method: 'POST' })
  const setResume = async (itemId, positionMs, at) => {
    const body = { PlaybackPositionTicks: Math.round(positionMs) * 10000, LastPlayedDate: new Date(at).toISOString() }
    try {
      await call(`/UserItems/${itemId}/UserData?${new URLSearchParams({ userId: jfUser })}`, { method: 'POST', body })
    } catch (e) {
      // Servers older than 10.9 only know the per-user path.
      if (e?.status !== 404) throw e
      await call(`/Users/${jfUser}/Items/${itemId}/UserData`, { method: 'POST', body })
    }
  }

  const [movies, episodes, sessions] = await Promise.all([
    prisma.movieWatchHistory.findMany({ where: { accountId, userId, completed: true, watchedAt: { gt: since } }, select: { itemId: true } }),
    prisma.episodeWatchHistory.findMany({ where: { accountId, userId, completed: true, watchedAt: { gt: since }, season: { not: null }, episode: { not: null } }, select: { showId: true, season: true, episode: true } }),
    prisma.watchSession.findMany({
      where: { accountId, userId, updatedAt: { gt: since }, lastPosition: { gt: 0 } },
      select: { itemId: true, itemType: true, season: true, episode: true, lastPosition: true, totalDuration: true, updatedAt: true },
    }),
  ])
  const inProgress = sessions.filter((s) => /^tt\d+$/.test(s.itemId) && !hasReachedEnd(s.lastPosition, s.totalDuration))
  let marked = 0
  let resumed = 0

  // A resume point is written when it is newer than what the server last
  // saw and more than a minute away from where the server already has it.
  const maybeResume = async (item, s) => {
    const ud = item.UserData || {}
    const serverAt = ud.LastPlayedDate ? new Date(ud.LastPlayedDate).getTime() : 0
    if (serverAt >= new Date(s.updatedAt).getTime()) return
    const serverMs = Math.round((Number(ud.PlaybackPositionTicks) || 0) / 10000)
    if (Math.abs(serverMs - s.lastPosition) < 60 * 1000) return
    await setResume(item.Id, s.lastPosition, s.updatedAt)
    resumed++
  }

  const movieSessions = inProgress.filter((s) => s.itemType === 'movie')
  if (movies.length || movieSessions.length) {
    const finished = new Set(movies.map((m) => m.itemId).filter((id) => /^tt\d+$/.test(id)))
    const partway = new Map(movieSessions.map((s) => [s.itemId, s]))
    const all = await items(call, { userId: jfUser, Recursive: 'true', IncludeItemTypes: 'Movie', Fields: 'ProviderIds', EnableUserData: 'true', Limit: '20000' })
    for (const it of all) {
      const id = stremioIdFromProviderIds(it.ProviderIds)
      if (!id) continue
      if (finished.has(id)) {
        if (!it.UserData?.Played) { await markPlayed(it.Id); marked++ }
      } else if (partway.has(id)) {
        await maybeResume(it, partway.get(id))
      }
    }
  }

  const episodeSessions = inProgress.filter((s) => s.itemType === 'series' && Number.isInteger(s.season) && Number.isInteger(s.episode))
  const byShow = new Map()
  const addTo = (showId, entry) => {
    if (!/^tt\d+$/.test(showId)) return
    if (!byShow.has(showId)) byShow.set(showId, [])
    byShow.get(showId).push(entry)
  }
  for (const e of episodes) addTo(e.showId, { season: e.season, episode: e.episode, finished: true })
  for (const s of episodeSessions) addTo(s.itemId, { season: s.season, episode: s.episode, session: s })
  if (byShow.size) {
    const series = await items(call, { userId: jfUser, Recursive: 'true', IncludeItemTypes: 'Series', Fields: 'ProviderIds', Limit: '20000' })
    for (const show of series) {
      const id = stremioIdFromProviderIds(show.ProviderIds)
      const rows = id ? byShow.get(id) : null
      if (!rows) continue
      const data = await call(`/Shows/${show.Id}/Episodes?${new URLSearchParams({ userId: jfUser, EnableUserData: 'true' })}`)
      const eps = Array.isArray(data?.Items) ? data.Items : []
      const finishedHere = new Set(rows.filter((r) => r.finished).map((r) => `${r.season}:${r.episode}`))
      for (const row of rows) {
        const ep = eps.find((x) => x.IndexNumber === row.episode && x.ParentIndexNumber === row.season)
        if (!ep) continue
        if (row.finished) {
          if (!ep.UserData?.Played) { await markPlayed(ep.Id); marked++ }
        } else if (!finishedHere.has(`${row.season}:${row.episode}`)) {
          await maybeResume(ep, row.session)
        }
      }
    }
  }
  return { marked, resumed }
}

async function runAccount(prisma, decrypt, accountId) {
  const signIns = await signInsFor(prisma, accountId)
  if (!signIns.length) return
  const { cfg } = await readSync(prisma, accountId)
  const off = cfg.jellyfinMarkPlayed && typeof cfg.jellyfinMarkPlayed === 'object' ? cfg.jellyfinMarkPlayed : {}
  const cursors = cfg.jellyfinMarkPlayedCursor && typeof cfg.jellyfinMarkPlayedCursor === 'object' ? cfg.jellyfinMarkPlayedCursor : {}
  const nextCursors = {}
  const startedAt = new Date()
  for (const signIn of signIns) {
    if (off[signIn.person.id] === false) continue
    const key = `${signIn.person.id}|${signIn.serverUrl}|${signIn.jellyfinUserId}`
    const since = cursors[key] ? new Date(new Date(cursors[key]).getTime() - OVERLAP_MS) : new Date(startedAt.getTime() - FIRST_LOOKBACK_MS)
    try {
      const token = decrypt(signIn.token, { appAccountId: accountId })
      const { marked, resumed } = await markFor(prisma, accountId, signIn, token, since)
      if (marked || resumed) console.log(`[JellyfinMarkPlayed] ${signIn.person.username}: ${marked} marked played, ${resumed} resume point(s) set`)
      nextCursors[key] = startedAt.toISOString()
    } catch (e) {
      // Left where it was, so the next pass tries the same stretch again.
      console.warn(`[JellyfinMarkPlayed] ${signIn.person.username}:`, e?.message)
    }
  }
  if (Object.keys(nextCursors).length) await patchSync(prisma, accountId, { jellyfinMarkPlayedCursor: nextCursors })
}

async function runAll(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true } })
  for (const acc of accounts) {
    try { await runAccount(prisma, decrypt, acc.id) }
    catch (e) { console.warn('[JellyfinMarkPlayed] account failed:', e?.message) }
  }
}

let timer = null
function scheduleMarkPlayed(prisma, decrypt) {
  if (timer) clearInterval(timer)
  const run = () => runAll(prisma, decrypt).catch((e) => console.warn('[JellyfinMarkPlayed] pass failed:', e?.message))
  setTimeout(run, 4 * 60 * 1000)
  timer = setInterval(run, INTERVAL_MS)
}

/** For the person's page: whether this applies to them, and whether it's on. */
async function statusFor(prisma, accountId, userId) {
  const available = (await signInsFor(prisma, accountId)).some((s) => s.person.id === userId)
  const { cfg } = await readSync(prisma, accountId)
  return { available, enabled: cfg.jellyfinMarkPlayed?.[userId] !== false }
}

async function setEnabled(prisma, accountId, userId, enabled) {
  await patchSync(prisma, accountId, { jellyfinMarkPlayed: { [userId]: enabled === true } })
}

module.exports = { scheduleMarkPlayed, runAccount, markFor, signInsFor, statusFor, setEnabled }
