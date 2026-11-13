// Stremio's own playback and library events, received by SlickTrax
// (utils/stremioAddonEvents.js, routes/traxAddon.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

// A viewing is named by a metadata lookup that would go to the network.
// watchState takes describeTitle when it loads, so it is replaced first.
const discrete = require('../server/utils/discreteWatch')
discrete.describeTitle = async (prisma, accountId, { itemId }) => ({ title: itemId === 'tt0113277' ? 'Heat' : 'Some Show', episodeName: null, poster: 'https://img.example/p.jpg' })

// The notifications a start would send, counted instead of sent.
const push = require('../server/utils/pushNotifications')
const automation = require('../server/utils/automation/engine')
const sent = { push: 0, automation: 0 }
push.notifyPushForType = async () => { sent.push += 1 }
automation.emitAutomationEvent = async () => { sent.automation += 1 }

const watchState = require('../server/utils/watchState')
const events = require('../server/utils/stremioAddonEvents')
const dedupe = require('../server/utils/startNotifyDedupe')
const traxAddon = require('../server/routes/traxAddon')
const activityMonitor = require('../server/utils/activityMonitor')
const { pathIsAllowlisted } = require('../server/utils/auth')

const TOKEN = 'ab'.repeat(16)
const MIN = 60 * 1000
const ACCOUNT = 'default'

const heat = 'tt0113277'
const show = 'tt0903747'

// The tables the new code is allowed to touch are real enough to read back;
// the ones that hold the RECORD are watched, and any use of them is a failure.
const RECORD_TABLES = ['watchSession', 'watchActivity', 'movieWatchHistory', 'episodeWatchHistory']

function fakeWorld({ users, cfg = { notifyOnActivity: true } } = {}) {
  const people = users || [{ id: 'u1', accountId: ACCOUNT, username: 'Mia', traxToken: TOKEN, traxAddonEnabled: true }]
  const cursors = new Map()
  const touched = []
  const key = (w) => `${w.accountId}|${w.userId}|${w.videoId}`
  const now = () => new Date()
  const cursorTable = {
    findUnique: async ({ where }) => cursors.get(key(where.accountId_userId_videoId)) || null,
    upsert: async ({ where, create, update }) => {
      const k = key(where.accountId_userId_videoId)
      const row = cursors.has(k)
        ? { ...cursors.get(k), ...update, updatedAt: now() }
        : { id: k, accumulatedSeconds: 0, itemName: null, poster: null, createdAt: now(), updatedAt: now(), ...create }
      cursors.set(k, row)
      return row
    },
    update: async ({ where, data }) => {
      const k = key(where.accountId_userId_videoId)
      if (!cursors.has(k)) throw new Error('missing')
      cursors.set(k, { ...cursors.get(k), ...data })
    },
    delete: async ({ where }) => { cursors.delete(key(where.accountId_userId_videoId)) },
    deleteMany: async ({ where }) => {
      for (const [k, c] of cursors) if (where.userId === c.userId && c.updatedAt < where.updatedAt.lt) cursors.delete(k)
    },
    findMany: async ({ where }) => [...cursors.values()].filter((c) => c.accountId === where.accountId && (!where.userId?.in || where.userId.in.includes(c.userId))),
  }
  const base = {
    watchStateCursor: cursorTable,
    user: {
      findFirst: async ({ where }) => people.find((u) => u.traxToken === where.traxToken && u.traxAddonEnabled === where.traxAddonEnabled) || null,
      findMany: async () => people,
    },
    appAccount: { findFirst: async () => ({ sync: JSON.stringify(cfg) }), findUnique: async () => ({ sync: JSON.stringify(cfg) }) },
  }
  const prisma = new Proxy(base, {
    get(target, name) {
      if (RECORD_TABLES.includes(name)) {
        // Any use at all, of any method, is recorded.
        return new Proxy({}, { get: (_, method) => async () => { touched.push(`${name}.${String(method)}`); return [] } })
      }
      if (name in target) return target[name]
      return new Proxy({}, { get: () => async () => [] })
    },
  })
  return { prisma, cursors, touched, people }
}

async function serve(t, prisma) {
  const app = express()
  app.use('/trax', traxAddon({ prisma }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  return (path) => fetch(`${base}${path}`)
}

const player = (type, videoId, action, time, duration) =>
  `/trax/${TOKEN}/player/${type}/${encodeURIComponent(videoId)}/${encodeURIComponent(`action=${action}&currentTime=${time}&duration=${duration}`)}.json`
const library = (type, id, extra) => `/trax/${TOKEN}/library/${type}/${id}/${encodeURIComponent(extra)}.json`

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

test.beforeEach(() => {
  events._resetForTests()
  sent.push = 0
  sent.automation = 0
  dedupe.forgetClaimsForTests()
})

// ---------------------------------------------------------------------------

test('manifest: player and library are declared as full resources, the catalog stays as it was', () => {
  const m = traxAddon.buildTraxManifest({ id: 'u1', username: 'Mia' }, [])
  assert.equal(m.resources[0], 'catalog')
  const byName = Object.fromEntries(m.resources.filter((r) => typeof r === 'object').map((r) => [r.name, r]))
  for (const name of ['player', 'library']) {
    assert.deepEqual(byName[name], { name, types: ['movie', 'series'], idPrefixes: ['tt'] })
  }
  assert.equal(m.resources.length, 3)
  assert.deepEqual(m.types, ['movie', 'series'])
  assert.ok(m.catalogs.length > 0)
})

test('manifest: the version moved, so the address in the account moves with it and sync replaces the stored copy', () => {
  assert.equal(traxAddon.TRAX_MANIFEST_VERSION, '1.8.0')
  assert.equal(traxAddon.traxPathVersion({ traxRowsJson: null }), '1.8.0')
})

test('the routes sit under /trax/, which the login gate lets through', () => {
  assert.equal(pathIsAllowlisted(`/trax/${TOKEN}/player/series/tt1%3A1%3A2/x.json`), true)
  assert.equal(pathIsAllowlisted(`/trax/${TOKEN}/v1.8.0/library/series/tt1/x.json`), true)
})

test('parsing: the action and the times, in milliseconds', () => {
  assert.deepEqual(events.parseExtra('action=start&currentTime=61000&duration=5400000'), { action: 'start', currentTime: 61000, duration: 5400000, videoIds: [] })
  assert.equal(events.parseExtra('action=pause&currentTime=0&duration=0').currentTime, 0)
  assert.equal(events.parseExtra('action=stop&currentTime=abc').currentTime, 0)
  assert.equal(events.parseExtra('action=start&currentTime=99999999999999').currentTime, 2147483647)
  assert.deepEqual(events.parseExtra('action=watched&videoId=tt1:1:2,tt1:1:3').videoIds, ['tt1:1:2', 'tt1:1:3'])
  assert.equal(events.parseLibraryAction('action=libraryAdd'), 'libraryAdd')
  for (const a of ['libraryAdd', 'libraryRemove', 'watched', 'unwatched']) assert.equal(events.parseLibraryAction(`action=${a}`), a)
  assert.equal(events.parseLibraryAction('action=start'), null)
  assert.equal(events.parseLibraryAction(''), null)
})

test('parsing: the path id is the video id - a film, or an episode of a show; anything else is set aside', () => {
  assert.deepEqual(events.parseVideo('movie', heat), { itemId: heat, itemType: 'movie', videoId: heat, season: null, episode: null })
  assert.deepEqual(events.parseVideo('series', `${show}:2:5`), { itemId: show, itemType: 'series', videoId: `${show}:2:5`, season: 2, episode: 5 })
  assert.equal(events.parseVideo('series', show), null)
  assert.equal(events.parseVideo('series', 'kitsu:1:2'), null)
  assert.equal(events.parseVideo('channel', heat), null)
  assert.equal(events.parseVideo('movie', 'tmdb:12'), null)
})

test('a start becomes a live viewing at the player\'s real position and length', async (t) => {
  const { prisma, touched } = fakeWorld()
  const get = await serve(t, prisma)
  const res = await get(player('movie', heat, 'start', 600000, 7200000))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {})
  assert.equal(res.headers.get('cache-control'), 'no-store')

  const [v] = await watchState.liveViewings(prisma, ACCOUNT)
  assert.equal(v.userId, 'u1')
  assert.equal(v.itemId, heat)
  assert.equal(v.itemType, 'movie')
  assert.equal(v.durationMs, 7200000)
  assert.ok(v.positionMs >= 600000 && v.positionMs < 600000 + 5000, `position ${v.positionMs}`)
  assert.equal(v.paused, undefined)
  assert.ok(v.playingUntil > Date.now())
  assert.equal(events.stremioMark('u1', heat), 'live')
  assert.deepEqual(touched, [])
})

test('an episode keeps its season and episode, and a versioned address works like the plain one', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)
  const path = player('series', `${show}:2:5`, 'start', 1000, 3000000).replace(`/trax/${TOKEN}/`, `/trax/${TOKEN}/v1.8.0/`)
  assert.equal((await get(path)).status, 200)
  const [v] = await watchState.liveViewings(prisma, ACCOUNT)
  assert.equal(v.itemId, show)
  assert.equal(v.videoId, `${show}:2:5`)
  assert.equal(v.season, 2)
  assert.equal(v.episode, 5)
})

test('a pause keeps the position and shows as paused; a start after it plays again', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)
  await get(player('movie', heat, 'start', 0, 7200000))
  await get(player('movie', heat, 'pause', 1800000, 7200000))

  let [v] = await watchState.liveViewings(prisma, ACCOUNT)
  assert.equal(v.paused, true)
  assert.equal(v.positionMs, 1800000)
  assert.equal(v.durationMs, 7200000)

  await get(player('movie', heat, 'start', 1800000, 7200000))
  ;[v] = await watchState.liveViewings(prisma, ACCOUNT)
  assert.equal(v.paused, undefined)
  assert.ok(v.positionMs >= 1800000 && v.positionMs < 1800000 + 5000)
})

test('a stop removes the viewing', async (t) => {
  const { prisma, cursors } = fakeWorld()
  const get = await serve(t, prisma)
  await get(player('movie', heat, 'start', 0, 7200000))
  assert.equal(cursors.size, 1)
  const res = await get(player('movie', heat, 'stop', 7000000, 7200000))
  assert.equal(res.status, 200)
  assert.equal(cursors.size, 0)
  assert.deepEqual(await watchState.liveViewings(prisma, ACCOUNT), [])
  assert.equal(events.stremioMark('u1', heat), 'ended')
})

test('an unknown token is a 404 on both routes, and so is a person whose SlickTrax is off', async (t) => {
  const { prisma, cursors } = fakeWorld({ users: [
    { id: 'u1', accountId: ACCOUNT, username: 'Mia', traxToken: TOKEN, traxAddonEnabled: true },
    { id: 'u2', accountId: ACCOUNT, username: 'Leo', traxToken: 'cd'.repeat(16), traxAddonEnabled: false },
    { id: 'u3', accountId: ACCOUNT, username: 'Ava', traxToken: '12'.repeat(16), traxAddonEnabled: true, isActive: false },
  ] })
  const get = await serve(t, prisma)
  const other = (path) => path.replace(TOKEN, 'ef'.repeat(16))
  assert.equal((await get(other(player('movie', heat, 'start', 0, 1)))).status, 404)
  assert.equal((await get(other(library('movie', heat, 'action=watched')))).status, 404)
  const off = (path) => path.replace(TOKEN, 'cd'.repeat(16))
  assert.equal((await get(off(player('movie', heat, 'start', 0, 1)))).status, 404)
  // Switched off in SlickSync: not tracked either.
  const inactive = (path) => path.replace(TOKEN, '12'.repeat(16))
  assert.equal((await get(inactive(player('movie', heat, 'start', 0, 1)))).status, 404)
  assert.equal((await get(inactive(library('movie', heat, 'action=watched')))).status, 404)
  assert.equal(cursors.size, 0)
})

test('what cannot be used is still answered 200 {} and changes nothing', async (t) => {
  const { prisma, cursors } = fakeWorld()
  const get = await serve(t, prisma)
  for (const path of [
    player('movie', heat, 'rewind', 5, 5),
    player('series', show, 'start', 5, 5),
    player('movie', 'kitsu:1', 'start', 5, 5),
  ]) {
    const res = await get(path)
    assert.equal(res.status, 200, path)
    assert.deepEqual(await res.json(), {})
  }
  assert.equal(cursors.size, 0)
})

test('nothing reaches the record: no WatchSession, WatchActivity or history from a whole viewing', async (t) => {
  const world = fakeWorld()
  const get = await serve(t, world.prisma)
  await get(player('series', `${show}:1:1`, 'start', 0, 3000000))
  await get(player('series', `${show}:1:1`, 'pause', 900000, 3000000))
  await get(player('series', `${show}:1:1`, 'start', 900000, 3000000))
  await get(player('series', `${show}:1:1`, 'stop', 2900000, 3000000))
  await get(library('series', show, 'action=watched&videoId=' + `${show}:1:1`))
  await settle()
  assert.deepEqual(world.touched, [])
})

test('a burst of library events makes one read of that person, after the delay', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)
  const reads = []
  const real = activityMonitor.checkActivityForUser
  activityMonitor.checkActivityForUser = async (accountId, userId) => { reads.push([accountId, userId]); return true }
  t.after(() => { activityMonitor.checkActivityForUser = real; events.timing.readDelayMs = events.LIBRARY_READ_DELAY_MS })
  // Long enough that the four requests below always finish inside it: at 40 ms
  // a busy machine sometimes took longer than that and the read came first.
  events.timing.readDelayMs = 400

  for (const extra of ['action=watched&videoId=tt1:1:1,tt1:1:2', 'action=watched&videoId=tt1:1:3', 'action=libraryAdd', 'action=unwatched&videoId=tt1:1:2']) {
    const res = await get(library('series', 'tt1', extra))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {})
  }
  assert.deepEqual(reads, [], 'not before the delay')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.deepEqual(reads, [[ACCOUNT, 'u1']])

  // A later burst reads again.
  await get(library('movie', heat, 'action=libraryRemove'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(reads.length, 2)
})

test('an event that is not a library change asks for no read', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)
  let reads = 0
  const real = activityMonitor.checkActivityForUser
  activityMonitor.checkActivityForUser = async () => { reads += 1; return true }
  t.after(() => { activityMonitor.checkActivityForUser = real; events.timing.readDelayMs = events.LIBRARY_READ_DELAY_MS })
  events.timing.readDelayMs = 20
  assert.equal((await get(library('movie', heat, 'action=bogus'))).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(reads, 0)
})

test('reads are per person: two people in a burst are two reads', async () => {
  const reads = []
  const read = async (u) => { reads.push(u.id) }
  assert.equal(events.scheduleLibraryRead({ id: 'a' }, { delayMs: 20, read }), true)
  assert.equal(events.scheduleLibraryRead({ id: 'a' }, { delayMs: 20, read }), false)
  assert.equal(events.scheduleLibraryRead({ id: 'b' }, { delayMs: 20, read }), true)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(reads.sort(), ['a', 'b'])
})

test('a failing read is swallowed', async () => {
  events.scheduleLibraryRead({ id: 'a' }, { delayMs: 10, read: async () => { throw new Error('provider down') } })
  await new Promise((resolve) => setTimeout(resolve, 60))
})

test('the start is announced once whoever sees it first: the proxy, then Stremio, then the library read', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)

  // The proxy saw it first and claimed it.
  assert.equal(dedupe.claimStart(ACCOUNT, 'u1', heat), true)
  await get(player('movie', heat, 'start', 0, 7200000))
  await settle()
  assert.equal(sent.push, 0)
  assert.equal(sent.automation, 0)
  // The library read's own "watched" stands down for it too.
  assert.equal(dedupe.hasClaim(ACCOUNT, 'u1', heat), true)
})

test('Stremio first: announced once, a resume or seek does not repeat it, and the proxy and the library read stand down', async (t) => {
  const { prisma } = fakeWorld()
  const get = await serve(t, prisma)

  await get(player('series', `${show}:1:1`, 'start', 0, 3000000))
  await settle()
  assert.equal(sent.push, 1)
  assert.equal(sent.automation, 1)

  await get(player('series', `${show}:1:1`, 'pause', 600000, 3000000))
  await get(player('series', `${show}:1:1`, 'start', 600000, 3000000))
  await get(player('series', `${show}:1:1`, 'start', 1200000, 3000000))
  await settle()
  assert.equal(sent.push, 1)

  assert.equal(dedupe.claimStart(ACCOUNT, 'u1', show), false, 'the proxy finds it claimed')
  assert.equal(dedupe.hasClaim(ACCOUNT, 'u1', show), true, 'and so does the library read')
  assert.equal(dedupe.hasClaim(ACCOUNT, 'u1', 'tt9999999'), false)
})

test('the viewing is named for Now Playing', async (t) => {
  const { prisma, cursors } = fakeWorld()
  const get = await serve(t, prisma)
  await get(player('movie', heat, 'start', 0, 7200000))
  await settle()
  const [c] = [...cursors.values()]
  assert.equal(c.itemName, 'Heat')
  assert.equal(c.poster, 'https://img.example/p.jpg')
})

test('a viewing whose stop never came is not the same viewing next time: it starts afresh and is announced', async (t) => {
  const { prisma, cursors } = fakeWorld()
  const get = await serve(t, prisma)
  await get(player('movie', heat, 'start', 0, 7200000))
  await settle()
  assert.equal(sent.push, 1)
  // The app was killed; the runtime and its grace have long passed.
  const [c] = [...cursors.values()]
  c.startAt = new Date(Date.now() - 5 * 60 * MIN)
  c.createdAt = new Date(Date.now() - 5 * 60 * MIN)
  await get(player('movie', heat, 'start', 0, 7200000))
  const [after] = [...cursors.values()]
  assert.ok(Date.now() - new Date(after.createdAt).getTime() < 5000, 'the card starts now, not five hours ago')
})

// ---------------------------------------------------------------------------
// Now Playing

function nowPlayingWorld(world, nativeSessions) {
  const { prisma } = world
  const withSessions = new Proxy(prisma, {
    get(target, name) {
      if (name === 'watchSession') return { findMany: async () => nativeSessions }
      if (name === 'user') return { ...target.user, findMany: async () => world.people }
      return target[name]
    },
  })
  return withSessions
}

const nativeSession = (over = {}) => ({
  userId: 'u1', itemId: heat, itemName: 'Heat', itemType: 'movie', videoId: null, season: null, episode: null,
  poster: null, startTime: new Date(Date.now() - 10 * MIN), updatedAt: new Date(), isActive: true,
  lastPosition: 300000, totalDuration: 7200000, ...over,
})

test('Now Playing: Stremio\'s live position replaces the library\'s checkpoint for the same title', async (t) => {
  const world = fakeWorld()
  const get = await serve(t, world.prisma)
  await get(player('movie', heat, 'start', 4000000, 7200000))
  await settle()

  const { buildNowPlaying } = require('../server/utils/metricsBuilder')
  const prisma = nowPlayingWorld(world, [nativeSession()])
  const rows = await buildNowPlaying(prisma, ACCOUNT, world.people)
  const mine = rows.filter((r) => r.item.id === heat)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].source, 'stremio')
  assert.ok(mine[0].lastPosition >= 4000000 && mine[0].lastPosition < 4010000, `position ${mine[0].lastPosition}`)
  assert.equal(mine[0].totalDuration, 7200000)
})

test('Now Playing: once Stremio says stop, the library\'s still-active echo of it is gone', async (t) => {
  const world = fakeWorld()
  const get = await serve(t, world.prisma)
  await get(player('movie', heat, 'start', 0, 7200000))
  await get(player('movie', heat, 'stop', 600000, 7200000))

  const { buildNowPlaying } = require('../server/utils/metricsBuilder')
  const prisma = nowPlayingWorld(world, [nativeSession(), nativeSession({ itemId: 'tt0000001', itemName: 'Other' })])
  const rows = await buildNowPlaying(prisma, ACCOUNT, world.people)
  assert.deepEqual(rows.map((r) => r.item.id), ['tt0000001'], 'only the title Stremio said nothing about is left')
})

test('Now Playing: a title Stremio never reported is left to the library as before', async (t) => {
  const world = fakeWorld()
  const { buildNowPlaying } = require('../server/utils/metricsBuilder')
  const rows = await buildNowPlaying(nowPlayingWorld(world, [nativeSession()]), ACCOUNT, world.people)
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].source, 'stremio')
})
