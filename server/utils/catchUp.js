// "I'm caught up to here": mark an episode and every aired one before it as
// watched - in SlickSync, and on the person's Jellyfin or AIOStreams server.
//
// History only, never watch time: each episode is recorded the way a
// "played" mark is (discreteWatch.recordDiscreteWatch, completed: true,
// moveForward: false - the same as Watch State's bulk "played"), so no
// WatchActivity row is written and overallTimeWatched is never touched. An
// episode already in History is left as it is.
//
// The episode list comes from Cinemeta for an IMDb show, otherwise from the
// person's own server (anime, TMDb-only). Specials (season 0) and episodes
// that haven't aired are skipped.
//
// On the server:
// - AIOStreams with features.playedUpTo: one call, with the person's own
//   sign-in (its /AIOStreams/ routes refuse API keys).
// - Real Jellyfin, and AIOMetadata (whose PlayedUpTo isn't confirmed): one
//   "played" per episode not already played there, four at a time - 200
//   episodes are 200 calls, so it runs in the background and reports progress.
//
// One run per person at a time; the page polls status().

const { recordDiscreteWatch } = require('./discreteWatch')
const { mapLimit } = require('./mapLimit')

const SERVER_CONCURRENCY = 4
const PROFILE_LABEL = 'Caught up'

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

const jobs = new Map()

async function personFor(prisma, accountId, userId) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { id: true, username: true, accountId: true, providerType: true, jellyfinServerKind: true, jellyfinServerUrl: true, jellyfinUserId: true, jellyfinToken: true } })
  if (!person) throw fail('User not found', 404)
  return person
}

function providerFor(person, decrypt, createProvider) {
  if (person.providerType !== 'jellyfin' || !person.jellyfinToken) return null
  const make = createProvider || require('../providers').createProvider
  return make(person, { decrypt: (t) => decrypt(t, { appAccountId: person.accountId || 'default' }), req: { appAccountId: person.accountId || 'default' } })
}

/** The shows they have watched, newest first - what the picker offers. */
async function showsFor(prisma, accountId, userId) {
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId, userId },
    orderBy: { watchedAt: 'desc' },
    take: 400,
    select: { showId: true, showName: true, poster: true },
  })
  const seen = new Map()
  for (const r of rows) if (!seen.has(r.showId)) seen.set(r.showId, { id: r.showId, name: r.showName, poster: r.poster || null })
  return [...seen.values()].slice(0, 40)
}

const aired = (released, now) => !released || Number.isNaN(Date.parse(released)) || Date.parse(released) <= now

/** Every episode of a show, oldest first, with which are already watched here. */
async function episodesFor(prisma, decrypt, accountId, userId, showId, { createProvider, fetchMeta } = {}) {
  const person = await personFor(prisma, accountId, userId)
  const id = require('../providers/jellyfin').splitStremioId(showId).base
  if (!id) throw fail('Pick a show')
  let name = null
  let poster = null
  let episodes = null
  if (/^tt\d+$/.test(id)) {
    const meta = await (fetchMeta || require('./notify').fetchMetadata)(id, 'series', null).catch(() => null)
    if (meta?.allEpisodes?.length) {
      name = meta.title || null
      poster = meta.poster || null
      episodes = meta.allEpisodes.map((e) => ({ season: e.season, episode: e.episode, title: e.title || null, released: e.released || null }))
    }
  }
  if (!episodes) {
    const provider = providerFor(person, decrypt, createProvider)
    const listed = provider ? await provider.listEpisodes(id).catch(() => null) : null
    if (listed?.length) episodes = listed.map((e) => ({ season: e.season, episode: e.episode, title: e.title, released: e.premiere }))
  }
  if (!episodes) throw fail('SlickSync couldn’t find that show’s episodes', 404)
  const history = await prisma.episodeWatchHistory.findMany({ where: { accountId, userId, showId: id }, select: { season: true, episode: true, completed: true, showName: true, poster: true } })
  const done = new Set(history.filter((h) => h.completed).map((h) => `${h.season}:${h.episode}`))
  name = name || history[0]?.showName || null
  poster = poster || history.find((h) => h.poster)?.poster || null
  return {
    showId: id,
    name,
    poster,
    episodes: episodes
      .filter((e) => e.season > 0)
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .map((e) => ({ ...e, watched: done.has(`${e.season}:${e.episode}`) })),
  }
}

const upTo = (season, episode) => (e) => e.season < season || (e.season === season && e.episode <= episode)

/** Start marking; returns the job straight away. */
async function start(prisma, decrypt, accountId, userId, { showId, season, episode }, deps = {}) {
  const s = Number(season)
  const ep = Number(episode)
  if (!(Number.isInteger(s) && s > 0 && Number.isInteger(ep) && ep > 0)) throw fail('Pick the episode they are caught up to')
  const running = jobs.get(userId)
  if (running?.state === 'running') throw fail('Already marking a show for them - wait for it to finish', 429)

  const now = deps.now || Date.now()
  const list = await episodesFor(prisma, decrypt, accountId, userId, showId, deps)
  const targets = list.episodes.filter(upTo(s, ep)).filter((e) => aired(e.released, now))
  if (!targets.length) throw fail('No aired episodes up to there')
  const person = await personFor(prisma, accountId, userId)
  const provider = providerFor(person, decrypt, deps.createProvider)

  const job = {
    state: 'running',
    show: list.name || list.showId,
    upTo: `S${s}E${ep}`,
    total: targets.length,
    recorded: 0,
    alreadyWatched: targets.filter((t) => t.watched).length,
    server: provider ? { state: 'waiting', marked: 0, total: null, how: null } : null,
    error: null,
    startedAt: new Date(now).toISOString(),
  }
  jobs.set(userId, job)

  const work = (async () => {
    // SlickSync's History first: quick, and the part that is always possible.
    for (const t of targets) {
      if (t.watched) continue
      const result = await recordDiscreteWatch(prisma, {
        accountId, userId, itemId: list.showId, itemType: 'series',
        season: t.season, episode: t.episode, videoId: `${list.showId}:${t.season}:${t.episode}`,
        title: list.name || list.showId, episodeName: t.title || null, poster: list.poster,
        completed: true, watchedAt: new Date(now), moveForward: false, profileLabel: PROFILE_LABEL,
      }).catch((e) => ({ ok: false, reason: e?.message }))
      if (result?.ok) job.recorded++
    }

    if (provider) {
      job.server.state = 'running'
      try {
        const serverEpisodes = await provider.listEpisodes(list.showId)
        if (!serverEpisodes) {
          job.server.state = 'not-there'
        } else {
          const todo = serverEpisodes.filter(upTo(s, ep)).filter((e) => e.season > 0 && aired(e.premiere, now) && !e.played)
          const last = serverEpisodes.find((e) => e.season === s && e.episode === ep)
          if (todo.length && last && await provider.playedUpTo(last.itemId).catch(() => false)) {
            job.server = { state: 'done', marked: todo.length, total: todo.length, how: 'played-up-to' }
          } else {
            job.server.total = todo.length
            job.server.how = 'each'
            await mapLimit(todo, SERVER_CONCURRENCY, async (e) => {
              try { await provider.setPlayed(e.itemId, true); job.server.marked++ } catch { /* counted as not marked */ }
            })
            job.server.state = 'done'
          }
        }
      } catch (e) {
        job.server.state = 'failed'
        job.server.error = e?.message || 'The server refused'
      }
    }
    job.state = 'done'
  })().catch((e) => {
    job.state = 'failed'
    job.error = e?.message || 'Something went wrong'
  })
  if (deps.wait) await work
  return job
}

function status(userId) {
  return jobs.get(userId) || null
}

function forgetForTests() {
  jobs.clear()
}

module.exports = { showsFor, episodesFor, start, status, forgetForTests, PROFILE_LABEL }
