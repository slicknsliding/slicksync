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
// - AIOStreams and AIOMetadata with features.playedUpTo: one call, with the
//   person's own sign-in (their /AIOStreams/ routes refuse API keys).
// - Real Jellyfin, or a server without it: one "played" per episode not
//   already played there, four at a time - 200 episodes are 200 calls, so it
//   runs in the background and reports progress.
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
// What the last run changed, kept apart from the job (which the page polls)
// so Undo can take back exactly that and nothing else.
const undoable = new Map()

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

const PICKER_SHOWS = 24
const PICKER_LOOKUPS = 6
// How far back through their shows the picker looks for ones it can list,
// so a run of unlistable ones at the top doesn't leave it nearly empty.
const PICKER_MAX_CHECKED = 60
// fetchMetadata only caches what it finds, so a show Cinemeta doesn't know
// would be asked about again on every opening of the picker.
const UNLISTED_MEMORY_MS = 6 * 60 * 60 * 1000
const unlisted = new Map()

/**
 * The shows they have watched, newest first, with the episode they watched
 * last - what the picker offers as tiles. Only shows whose episodes can be
 * listed are offered: an IMDb show Cinemeta knows (the same cached lookup
 * episodesFor makes, so opening one is instant), or any show at all for a
 * person with their own server to list it from. A show that can't be listed
 * would only ever answer "couldn't find that show's episodes".
 */
async function showsFor(prisma, accountId, userId, { fetchMeta } = {}) {
  const person = await personFor(prisma, accountId, userId)
  const rows = await prisma.episodeWatchHistory.findMany({
    where: { accountId, userId },
    orderBy: { watchedAt: 'desc' },
    take: 400,
    select: { showId: true, showName: true, poster: true, season: true, episode: true },
  })
  const seen = new Map()
  for (const r of rows) {
    const show = seen.get(r.showId)
    if (!show) seen.set(r.showId, { id: r.showId, name: r.showName, poster: r.poster || null, last: { season: r.season, episode: r.episode } })
    else if (!show.poster && r.poster) show.poster = r.poster
  }
  const ownServer = person.providerType === 'jellyfin' && !!person.jellyfinToken
  const lookup = fetchMeta || require('./notify').fetchMetadata
  const { splitStremioId } = require('../providers/jellyfin')
  const check = async (show) => {
    const id = splitStremioId(show.id).base
    if (/^tt\d+$/.test(id || '') && !(Date.now() - (unlisted.get(id) || 0) < UNLISTED_MEMORY_MS)) {
      const meta = await lookup(id, 'series', null).catch(() => null)
      if (meta?.allEpisodes?.length) return { ...show, name: show.name || meta.title || null, poster: show.poster || meta.poster || null }
      unlisted.set(id, Date.now())
    }
    return ownServer ? show : null
  }
  const all = [...seen.values()].slice(0, PICKER_MAX_CHECKED)
  const offered = []
  // A batch at a time, stopping once there are enough: someone whose shows
  // all list costs two batches, the same as checking only the first 24.
  for (let i = 0; i < all.length && offered.length < PICKER_SHOWS; i += PICKER_LOOKUPS * 2) {
    const checked = await mapLimit(all.slice(i, i + PICKER_LOOKUPS * 2), PICKER_LOOKUPS, check)
    offered.push(...checked.filter(Boolean))
  }
  return offered.slice(0, PICKER_SHOWS)
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
  // On AIOStreams the server's own list is read too: it says which anime
  // episodes are filler or a recap, matched to these by season and episode.
  const provider = !episodes || person?.jellyfinServerKind === 'aiostreams' ? providerFor(person, decrypt, createProvider) : null
  const listed = provider ? await provider.listEpisodes(id).catch(() => null) : null
  if (!episodes && listed?.length) episodes = listed.map((e) => ({ season: e.season, episode: e.episode, title: e.title, released: e.premiere }))
  if (!episodes) throw fail('SlickSync couldn’t find that show’s episodes', 404)
  const marks = new Map((listed || []).filter((e) => e.filler || e.recap).map((e) => [`${e.season}:${e.episode}`, e.recap ? 'recap' : 'filler']))
  if (marks.size) episodes = episodes.map((e) => (marks.has(`${e.season}:${e.episode}`) ? { ...e, kind: marks.get(`${e.season}:${e.episode}`) } : e))
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
  if (running?.state === 'running' || running?.state === 'undoing') throw fail('Already marking a show for them - wait for it to finish', 429)

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
  const record = { added: [], serverIds: [] }
  undoable.set(userId, record)

  const work = (async () => {
    // SlickSync's History first: quick, and the part that is always possible.
    for (const t of targets) {
      if (t.watched) continue
      const videoId = `${list.showId}:${t.season}:${t.episode}`
      // An episode they had started already has a row; Undo puts that back
      // to unfinished instead of deleting it.
      const existed = await prisma.episodeWatchHistory.findUnique({ where: { accountId_userId_videoId: { accountId, userId, videoId } }, select: { completed: true } }).catch(() => null)
      const result = await recordDiscreteWatch(prisma, {
        accountId, userId, itemId: list.showId, itemType: 'series',
        season: t.season, episode: t.episode, videoId,
        title: list.name || list.showId, episodeName: t.title || null, poster: list.poster,
        completed: true, watchedAt: new Date(now), moveForward: false, profileLabel: PROFILE_LABEL,
      }).catch((e) => ({ ok: false, reason: e?.message }))
      if (result?.ok) {
        job.recorded++
        record.added.push({ videoId, existed: !!existed })
      }
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
            record.serverIds.push(...todo.map((e) => e.itemId))
          } else {
            job.server.total = todo.length
            job.server.how = 'each'
            await mapLimit(todo, SERVER_CONCURRENCY, async (e) => {
              try { await provider.setPlayed(e.itemId, true); job.server.marked++; record.serverIds.push(e.itemId) } catch { /* counted as not marked */ }
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
  return status(userId)
}

/**
 * Take back the last run: the History rows it added go (one they had started
 * goes back to unfinished), and what it marked played on their server is
 * marked unplayed. Nothing else is touched - an episode that was already
 * watched before the run stays watched. Kept until the next run or a restart.
 */
async function undo(prisma, decrypt, accountId, userId, deps = {}) {
  const job = jobs.get(userId)
  const record = undoable.get(userId)
  if (!job || job.state !== 'done' || !record) throw fail('Nothing to undo')
  const person = await personFor(prisma, accountId, userId)
  const provider = record.serverIds.length ? providerFor(person, decrypt, deps.createProvider) : null
  undoable.delete(userId)
  job.state = 'undoing'
  const work = (async () => {
    for (const a of record.added) {
      const where = { accountId, userId, videoId: a.videoId }
      if (a.existed) await prisma.episodeWatchHistory.updateMany({ where, data: { completed: false } })
      else await prisma.episodeWatchHistory.deleteMany({ where })
    }
    if (provider) {
      await mapLimit(record.serverIds, SERVER_CONCURRENCY, async (itemId) => {
        try { await provider.setPlayed(itemId, false) } catch { /* left played there */ }
      })
    }
    job.state = 'undone'
  })().catch((e) => {
    job.state = 'failed'
    job.error = e?.message || 'Could not undo'
  })
  if (deps.wait) await work
  return status(userId)
}

/** One episode back to not watched: out of History, and unplayed on their server. */
async function unmark(prisma, decrypt, accountId, userId, { showId, season, episode }, deps = {}) {
  const s = Number(season)
  const ep = Number(episode)
  if (!(Number.isInteger(s) && s > 0 && Number.isInteger(ep) && ep > 0)) throw fail('Pick the episode')
  const person = await personFor(prisma, accountId, userId)
  const id = require('../providers/jellyfin').splitStremioId(showId).base
  if (!id) throw fail('Pick a show')
  // Every row for it, whichever app's id it was recorded under.
  const removed = await prisma.episodeWatchHistory.deleteMany({ where: { accountId, userId, showId: id, season: s, episode: ep } })
  let server = null
  const provider = providerFor(person, decrypt, deps.createProvider)
  if (provider) {
    try {
      const listed = await provider.listEpisodes(id)
      const item = listed?.find((e) => e.season === s && e.episode === ep)
      if (!item) server = 'not-there'
      else { await provider.setPlayed(item.itemId, false); server = 'done' }
    } catch {
      server = 'failed'
    }
  }
  return { removed: removed?.count || 0, server }
}

/**
 * Clear a finished run's card - its Done button, or the page's countdown
 * running out. Undo goes with it. A run still going is left alone.
 */
function dismiss(userId) {
  const job = jobs.get(userId)
  if (job && job.state !== 'running' && job.state !== 'undoing') {
    jobs.delete(userId)
    undoable.delete(userId)
  }
  return status(userId)
}

/** The job as the page sees it, with whether Undo is on offer. */
function status(userId) {
  const job = jobs.get(userId)
  if (!job) return null
  const record = undoable.get(userId)
  return { ...job, canUndo: job.state === 'done' && !!record && (record.added.length + record.serverIds.length) > 0 }
}

function forgetForTests() {
  jobs.clear()
  undoable.clear()
  unlisted.clear()
}

module.exports = { showsFor, episodesFor, start, undo, unmark, dismiss, status, forgetForTests, PROFILE_LABEL }
