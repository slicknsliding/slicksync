// Reading and writing one sign-in's watch state, per provider, in the shape
// plan.js compares (see the top of plan.js). Every write returns an undo
// record that puts back exactly what it changed and nothing else.
//
// - Stremio: one library item per title. Finished episodes live in the
//   item's packed watched field (stremioWatched.js), against the show's
//   episode list from Cinemeta; a resume point is the item's position.
// - Nuvio: per profile - watched_items (with the date), watch_progress and
//   library_items, each an upsert or a delete by key.
// - Jellyfin, AIOStreams, AIOMetadata: the server's own played marks (with
//   the date) and resume positions, per household profile.

const { orderVideos, readWatched, writeWatched } = require('./stremioWatched')
const { epKey } = require('./plan')
const { mapLimit } = require('../mapLimit')

const FINISHED = 0.9
const msOf = (v) => {
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : 0
}
const posterFor = (id) => (/^tt\d+$/.test(id || '') ? `https://images.metahub.space/poster/medium/${id}/img` : null)

// Cinemeta's episode list for a show, as Stremio numbers it.
const CINEMETA = 'https://v3-cinemeta.strem.io'
const videoCache = new Map()
const VIDEO_TTL = 6 * 60 * 60 * 1000
const MISS_TTL = 10 * 60 * 1000
async function showVideos(id, fetchImpl = fetch) {
  if (!/^tt\d+$/.test(id || '')) return null
  const hit = videoCache.get(id)
  // A miss (Cinemeta down, or no such show) is tried again after a few minutes.
  if (hit && Date.now() - hit.at < (hit.ids ? VIDEO_TTL : MISS_TTL)) return hit.ids
  let ids = null
  try {
    const res = await fetchImpl(`${CINEMETA}/meta/series/${id}.json`, { signal: AbortSignal.timeout(10000) })
    if (res.ok) {
      const videos = (await res.json())?.meta?.videos
      if (Array.isArray(videos) && videos.length) ids = orderVideos(videos)
    }
  } catch { ids = null }
  if (videoCache.size > 3000) videoCache.delete(videoCache.keys().next().value)
  videoCache.set(id, { at: Date.now(), ids })
  return ids
}

// Undo leaves alone anything that changed after the copy - they watched it
// for real since. A date this much past the copy's own counts as a change
// (servers stamp writes a moment after they're sent).
const CHANGED_SLACK_MS = 2 * 60 * 1000
const changedSince = (currentAt, copiedAt) => msOf(currentAt) > msOf(copiedAt) + CHANGED_SLACK_MS

function blankTitle(id, type, name, poster) {
  return { id, type, name: name || null, poster: poster || posterFor(id), watchedAt: null, episodes: new Map(), resume: null, inLibrary: false, lastActivity: 0 }
}
function touch(t, at) {
  if (at && at > t.lastActivity) t.lastActivity = at
}

// ---------------------------------------------------------------- Stremio

const stremio = {
  async read(provider, _profile, deps = {}) {
    const items = await provider.getLibrary()
    const state = new Map()
    const raw = new Map()
    const series = []
    for (const it of Array.isArray(items) ? items : []) {
      const id = it?._id
      if (!id || (it.type !== 'movie' && it.type !== 'series')) continue
      raw.set(id, it)
      const st = it.state || {}
      const t = blankTitle(id, it.type, it.name, it.poster)
      t.inLibrary = it.removed !== true && it.temp !== true
      const at = msOf(st.lastWatched)
      touch(t, at)
      const pos = Number(st.timeOffset) || 0
      const dur = Number(st.duration) || 0
      if (it.type === 'movie') {
        if ((Number(st.timesWatched) || 0) > 0 || (Number(st.flaggedWatched) || 0) > 0) t.watchedAt = at || 0
        else if (pos > 0 && !(dur > 0 && pos >= dur * FINISHED)) t.resume = { position: pos, duration: dur, at }
      } else {
        if (st.watched) series.push(t)
        const v = String(st.video_id || '').split(':')
        const season = Number(v[v.length - 2])
        const episode = Number(v[v.length - 1])
        if (pos > 0 && Number.isInteger(season) && Number.isInteger(episode) && !(dur > 0 && pos >= dur * FINISHED)) {
          t.resume = { season, episode, position: pos, duration: dur, at }
        }
      }
      if (t.inLibrary || t.watchedAt != null || t.resume || it.type === 'series') state.set(id, t)
    }
    await mapLimit(series, 6, async (t) => {
      const ids = await showVideos(t.id, deps.fetch)
      if (!ids) return
      const at = t.lastActivity || 0
      for (const vid of readWatched(raw.get(t.id).state.watched, ids)) {
        const parts = vid.split(':')
        const s = Number(parts[parts.length - 2])
        const e = Number(parts[parts.length - 1])
        if (Number.isInteger(s) && Number.isInteger(e) && s > 0) t.episodes.set(epKey(s, e), at)
      }
    })
    for (const [id, t] of state) if (t.type === 'series' && !t.episodes.size && !t.resume && !t.inLibrary) state.delete(id)
    return { state, raw }
  },

  async write(provider, read, items, deps = {}) {
    const now = deps.now || Date.now()
    const undo = []
    const changes = []
    const failed = []
    for (const item of items) {
      const c = item.changes
      const before = read.raw.get(item.id) || null
      const next = before ? JSON.parse(JSON.stringify(before)) : {
        _id: item.id, name: item.name || '', type: item.type, poster: item.poster || '', posterShape: 'poster',
        removed: true, temp: false, _ctime: new Date(now).toISOString(),
        state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
        behaviorHints: { defaultVideoId: item.type === 'movie' ? item.id : null, featuredVideoId: null, hasScheduledVideos: false },
      }
      const st = next.state = next.state || {}
      let newest = msOf(st.lastWatched)
      let wrote = false
      if (c.markWatched) {
        st.timesWatched = Math.max(1, Number(st.timesWatched) || 0)
        st.flaggedWatched = 1
        st.timeOffset = 0
        newest = Math.max(newest, c.markWatched.at || now)
        wrote = true
      }
      if (c.addEpisodes?.length) {
        const ids = await showVideos(item.id, deps.fetch)
        if (!ids) {
          failed.push({ key: item.key, reason: 'Stremio has no episode list for this show' })
        } else {
          const set = readWatched(st.watched, ids)
          const size = set.size
          for (const e of c.addEpisodes) {
            const vid = `${item.id}:${e.season}:${e.episode}`
            if (ids.includes(vid)) { set.add(vid); newest = Math.max(newest, e.at || 0) }
          }
          if (set.size > size) { st.watched = writeWatched(set, ids); wrote = true }
        }
      }
      if (c.resume) {
        const r = c.resume
        st.timeOffset = r.position
        st.duration = r.duration || st.duration || 0
        if (item.type === 'series') {
          st.video_id = `${item.id}:${r.season}:${r.episode}`
          st.season = r.season
          st.episode = r.episode
        } else st.video_id = item.id
        newest = Math.max(newest, r.at || now)
        next.temp = next.removed ? true : next.temp
        wrote = true
      }
      if (c.addLibrary) {
        next.removed = false
        next.temp = false
        wrote = true
      }
      if (!wrote) continue
      if (newest) st.lastWatched = new Date(newest).toISOString()
      next._mtime = new Date(now).toISOString()
      changes.push(next)
      undo.push({ id: item.id, before, mtime: next._mtime })
    }
    for (let i = 0; i < changes.length; i += 50) await provider.addLibraryItem(changes.slice(i, i + 50))
    return { undo: { kind: 'stremio', items: undo }, written: undo.length, failed, own: undo.map((u) => ({ id: u.id, mtime: u.mtime })) }
  },

  // Back to exactly how each item was - unless it has changed since the copy
  // (they watched something), in which case it is left alone.
  async undo(provider, record, deps = {}) {
    const now = deps.now || Date.now()
    const library = await provider.getLibrary()
    const current = new Map((Array.isArray(library) ? library : []).map((it) => [it._id, it]))
    const puts = []
    let kept = 0
    for (const u of record.items || []) {
      const cur = current.get(u.id)
      if (cur && cur._mtime !== u.mtime) { kept++; continue }
      // Stremio has no delete, so an item the copy created can't go away.
      // It becomes type "other" instead - the type every Stremio app skips:
      // never listed, never in Continue Watching, never even synced to a
      // device. Copying the title again later writes a fresh item over it
      // (the reader only takes movies and shows).
      const back = u.before
        ? { ...u.before, _mtime: new Date(now).toISOString() }
        : { _id: u.id, name: cur?.name || '', type: 'other', poster: '', posterShape: 'poster', removed: true, temp: false, _ctime: cur?._ctime || new Date(now).toISOString(), _mtime: new Date(now).toISOString(), state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false }, behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false } }
      puts.push(back)
    }
    for (let i = 0; i < puts.length; i += 50) await provider.addLibraryItem(puts.slice(i, i + 50))
    return { restored: puts.length, kept }
  },
}

// ---------------------------------------------------------------- Nuvio

function nuvioId(row) {
  const cid = String(row?.content_id || '')
  if ((cid === 'tmdb' || cid === 'kitsu') && /^\d+$/.test(String(row.video_id || ''))) return `${cid}:${row.video_id}`
  return cid || null
}
const nuvioType = (t) => (String(t || '').toLowerCase() === 'movie' ? 'movie' : 'series')

const nuvio = {
  async read(provider, profile) {
    const profileId = Number(profile) || 1
    const ws = await provider.getWatchState(profileId)
    const state = new Map()
    const get = (id, type, name, poster) => {
      let t = state.get(id)
      if (!t) { t = blankTitle(id, type, name, poster); state.set(id, t) }
      if (!t.name && name) t.name = name
      if (poster && !t.poster) t.poster = poster
      return t
    }
    for (const w of ws.watched) {
      const id = nuvioId(w)
      if (!id) continue
      const at = msOf(w.watched_at)
      const isEp = w.season != null && w.episode != null
      const t = get(id, isEp ? 'series' : nuvioType(w.content_type), w.title)
      if (isEp) { if (Number(w.season) > 0) t.episodes.set(epKey(Number(w.season), Number(w.episode)), at) } else t.watchedAt = at
      touch(t, at)
    }
    for (const p of ws.progress) {
      const id = nuvioId(p)
      if (!id) continue
      const at = msOf(p.last_watched)
      const pos = Number(p.position) || 0
      const dur = Number(p.duration) || 0
      const isEp = p.season != null && p.episode != null
      const t = get(id, isEp ? 'series' : nuvioType(p.content_type))
      touch(t, at)
      if (pos <= 0 || (dur > 0 && pos >= dur * FINISHED)) continue
      const r = isEp ? { season: Number(p.season), episode: Number(p.episode), position: pos, duration: dur, at } : { position: pos, duration: dur, at }
      if (!t.resume || (r.at || 0) > (t.resume.at || 0)) t.resume = r
    }
    for (const l of ws.library) {
      const id = l.content_id
      if (!id) continue
      const t = get(id, nuvioType(l.content_type), l.name, l.poster)
      t.inLibrary = true
      touch(t, msOf(l.added_at))
    }
    return {
      state, profileId,
      library: new Map(ws.library.map((l) => [l.content_id, l])),
      progress: new Map(ws.progress.filter((p) => p.progress_key).map((p) => [p.progress_key, p])),
    }
  },

  async write(provider, read, items, deps = {}) {
    const now = deps.now || Date.now()
    const profileId = read.profileId
    const watched = []
    const progress = []
    const library = []
    // at: when the copy ran - undo leaves alone what changed after it.
    // progress holds what each resume point was before (null: there was none).
    const undo = { kind: 'nuvio', profileId, at: now, watched: [], progress: [], library: [] }
    for (const item of items) {
      const c = item.changes
      const ctype = item.type === 'movie' ? 'movie' : 'series'
      if (c.markWatched) {
        watched.push({ content_id: item.id, content_type: ctype, title: item.name || '', season: null, episode: null, watched_at: c.markWatched.at || now })
        undo.watched.push({ content_id: item.id, at: c.markWatched.at || now })
      }
      for (const e of c.addEpisodes || []) {
        watched.push({ content_id: item.id, content_type: ctype, title: item.name || '', season: e.season, episode: e.episode, watched_at: e.at || now })
        undo.watched.push({ content_id: item.id, season: e.season, episode: e.episode, at: e.at || now })
      }
      if (c.resume) {
        const r = c.resume
        const isEp = item.type === 'series'
        const key = isEp ? `${item.id}_s${r.season}e${r.episode}` : item.id
        progress.push({
          content_id: item.id, content_type: ctype, video_id: isEp ? `${item.id}:${r.season}:${r.episode}` : item.id,
          season: isEp ? r.season : null, episode: isEp ? r.episode : null,
          position: Math.round(r.position), duration: Math.round(r.duration || 0), last_watched: r.at || now, progress_key: key,
        })
        const was = read.progress?.get(key) || null
        undo.progress.push({ key, before: was ? { ...was } : null })
      }
      if (c.addLibrary) {
        library.push({ content_id: item.id, content_type: ctype, name: item.name || '', poster: item.poster || null, poster_shape: 'POSTER', added_at: now })
        undo.library.push({ content_id: item.id, content_type: ctype })
      }
    }
    // What the tracker could read as playing: each resume point as written.
    const own = progress.map((p) => ({ id: p.content_id, lastWatched: p.last_watched, position: p.position }))
    for (let i = 0; i < watched.length; i += 500) await provider.pushWatchedItems(profileId, watched.slice(i, i + 500))
    for (let i = 0; i < progress.length; i += 200) await provider.pushWatchProgress(profileId, progress.slice(i, i + 200))
    // Nuvio quietly refuses a resume point older than the last time that
    // entry was removed (so a dismissed Continue Watching item stays gone) -
    // which is also what an earlier Undo leaves behind. Whatever it refused is
    // sent again dated now: the copy was asked for, so it should land.
    if (progress.length) {
      const landed = new Set(((await provider.getWatchState(profileId).catch(() => null))?.progress || []).map((p) => p.progress_key))
      const refused = progress.filter((p) => !landed.has(p.progress_key)).map((p) => ({ ...p, last_watched: now }))
      for (const p of refused) { const o = own.find((x) => x.id === p.content_id && x.position === p.position); if (o) o.lastWatched = now }
      for (let i = 0; i < refused.length; i += 200) await provider.pushWatchProgress(profileId, refused.slice(i, i + 200))
    }
    for (let i = 0; i < library.length; i += 200) await provider.pushLibraryItems(profileId, library.slice(i, i + 200))
    undo.at = deps.now || Date.now()
    return { undo, written: items.length, failed: [], own }
  },

  // Takes back what the copy wrote - except what they've watched since (a
  // newer date than the copy's), and a resume point that was there before
  // goes back to where it was instead of disappearing.
  async undo(provider, record) {
    const p = record.profileId
    const now = typeof provider.getWatchState === 'function' ? await provider.getWatchState(p).catch(() => null) : null
    const wKey = (w) => `${w.content_id}|${w.season ?? ''}|${w.episode ?? ''}`
    const watchedNow = new Map((now?.watched || []).map((w) => [wKey(w), w]))
    const progressNow = new Map((now?.progress || []).map((r) => [r.progress_key, r]))
    let kept = 0
    const watched = []
    for (const w of record.watched) {
      const cur = watchedNow.get(wKey(w))
      if (cur && w.at != null && changedSince(cur.watched_at, Math.max(msOf(w.at), msOf(record.at)))) { kept++; continue }
      watched.push({ content_id: w.content_id, ...(w.season != null ? { season: w.season, episode: w.episode } : {}) })
    }
    const drop = []
    const putBack = []
    for (const entry of record.progress) {
      // Records from before this change hold just the key.
      const { key, before } = typeof entry === 'string' ? { key: entry, before: null } : entry
      const cur = progressNow.get(key)
      if (cur && record.at != null && changedSince(cur.last_watched, record.at)) { kept++; continue }
      if (before) putBack.push({ ...before, last_watched: Date.now() })
      else drop.push(key)
    }
    for (let i = 0; i < watched.length; i += 500) await provider.deleteWatchedItems(p, watched.slice(i, i + 500))
    for (let i = 0; i < drop.length; i += 200) await provider.deleteWatchProgress(p, drop.slice(i, i + 200))
    for (let i = 0; i < putBack.length; i += 200) await provider.pushWatchProgress(p, putBack.slice(i, i + 200))
    for (let i = 0; i < record.library.length; i += 200) await provider.deleteLibraryItems(p, record.library.slice(i, i + 200))
    return { restored: watched.length + drop.length + putBack.length + record.library.length, kept }
  },
}

// ---------------------------------------------------------------- Jellyfin

const jellyfin = {
  async read(provider, profile) {
    const rows = await provider.watchState(profile || null)
    const state = new Map()
    // Each item's resume position before a copy, for its undo.
    const positions = new Map(rows.filter((r) => r.itemId).map((r) => [r.itemId, r.played ? 0 : (r.positionMs || 0)]))
    for (let r of rows) {
      const isEp = r.type === 'episode'
      const name = isEp ? r.seriesName : r.name
      // A title the server has no ids for is kept under its name, with what
      // was watched on it, so the page can offer "Pick the match".
      const key = r.id || (name ? `name:${name.toLowerCase()}` : null)
      if (!key) continue
      let t = state.get(key)
      if (!t) { t = blankTitle(r.id || null, isEp ? 'series' : 'movie', name, r.id ? undefined : null); state.set(key, t) }
      touch(t, r.playedAt || 0)
      // Stopped in the last tenth counts as finished, as on the other providers.
      const nearEnd = !r.played && r.durationMs > 0 && r.positionMs >= r.durationMs * FINISHED
      if (nearEnd) r = { ...r, played: true }
      const inProgress = !r.played && r.positionMs > 0
      if (isEp) {
        if (r.season == null || r.episode == null || r.season <= 0) continue
        if (r.played) t.episodes.set(epKey(r.season, r.episode), r.playedAt || 0)
        else if (inProgress && (!t.resume || (r.playedAt || 0) > (t.resume.at || 0))) t.resume = { season: r.season, episode: r.episode, position: r.positionMs, duration: r.durationMs, at: r.playedAt || 0 }
      } else if (r.played) t.watchedAt = r.playedAt || 0
      else if (inProgress) t.resume = { position: r.positionMs, duration: r.durationMs, at: r.playedAt || 0 }
    }
    return { state, profile: profile || null, positions }
  },

  /** For a real Jellyfin: which source titles its library has. */
  async presence(provider) {
    const index = await provider.titleIndex()
    if (!index) return null
    return { index, isPresent: (t) => index.has(t.id) }
  },

  async write(provider, read, items, deps = {}) {
    const profile = read.profile
    const index = deps.index || (await provider.titleIndex())
    const undo = { kind: 'jellyfin', profile, at: deps.now || Date.now(), played: [], positions: [] }
    const before = (itemId) => read.positions?.get(itemId) || 0
    const failed = []
    const itemFor = async (id, type) => (index ? index.get(id)?.itemId || null : await provider.findItem(id, type))
    // AIOStreams ignores a date on "mark played" but keeps one on a playback
    // stop - a dated stop at the very end is "finished then". AIOMetadata
    // keeps no date either way (and a stop at the end stays a resume point
    // there), so it is simply marked played.
    const aio = provider.serverKind === 'aiostreams' || provider.serverKind === 'aiometadata'
    const datedStop = provider.serverKind === 'aiostreams'
    const markPlayed = async (itemId, at) => {
      if (datedStop && at && typeof provider.runtimeMs === 'function') {
        const runtime = await provider.runtimeMs(itemId, profile).catch(() => 0)
        if (runtime > 0) return provider.setPosition(itemId, runtime, profile, at)
      }
      return provider.setPlayedAt(itemId, at, profile)
    }
    const wanted = new Map() // itemId -> position to resume at (0 = finished)
    await mapLimit(items, 4, async (item) => {
      const c = item.changes
      try {
        const titleId = await itemFor(item.id, item.type)
        if (!titleId) { failed.push({ key: item.key, reason: 'Not on that server' }); return }
        if (item.type === 'movie') {
          if (c.markWatched) { await markPlayed(titleId, c.markWatched.at); undo.played.push(titleId); wanted.set(titleId, 0) }
          if (c.resume) { await provider.setPosition(titleId, c.resume.position, profile, c.resume.at); undo.positions.push({ itemId: titleId, before: before(titleId), set: c.resume.position }); wanted.set(titleId, c.resume.position) }
          return
        }
        if (!c.addEpisodes?.length && !c.resume) return // a whole-show mark: Jellyfin has no such thing
        const eps = await provider.episodesOf(titleId)
        const byKey = new Map(eps.map((e) => [epKey(e.season, e.episode), e.itemId]))
        for (const e of c.addEpisodes || []) {
          const id = byKey.get(epKey(e.season, e.episode))
          if (!id) continue
          await markPlayed(id, e.at)
          undo.played.push(id)
          wanted.set(id, 0)
        }
        if (c.resume) {
          const id = byKey.get(epKey(c.resume.season, c.resume.episode))
          if (id) { await provider.setPosition(id, c.resume.position, profile, c.resume.at); undo.positions.push({ itemId: id, before: before(id), set: c.resume.position }); wanted.set(id, c.resume.position) }
        }
      } catch (e) {
        failed.push({ key: item.key, reason: e?.message || 'The server refused' })
      }
    })
    // AIOStreams (like Nuvio) refuses an event older than the title's own last
    // activity - an earlier Undo leaves exactly that. Read back, and send
    // whatever didn't land again, dated now.
    if (aio && wanted.size) {
      const now = new Map(((await provider.watchState(profile).catch(() => null)) || []).map((r) => [r.itemId, r]))
      await mapLimit([...wanted], 4, async ([itemId, pos]) => {
        const got = now.get(itemId)
        try {
          if (pos === 0 && !got?.played) await provider.setPlayedAt(itemId, null, profile)
          else if (pos > 0 && !(got && Math.abs((got.positionMs || 0) - pos) < 5000)) await provider.setPosition(itemId, pos, profile)
        } catch { /* left as the server has it */ }
      })
    }
    undo.at = deps.now || Date.now()
    return { undo, written: items.length - failed.length, failed }
  },

  // Takes back the played marks and resume points the copy set - except on
  // anything played since (a newer date than the copy's, or a resume point
  // that moved), and a resume point goes back to where it was.
  async undo(provider, record) {
    const rows = record.at != null && typeof provider.watchState === 'function' ? await provider.watchState(record.profile).catch(() => null) : null
    const nowById = new Map((rows || []).map((r) => [r.itemId, r]))
    let kept = 0
    let restored = 0
    // What the server refused stays in `remaining`, so Undo can be tried again.
    const remaining = { played: [], positions: [] }
    await mapLimit(record.played || [], 4, async (id) => {
      const cur = nowById.get(id)
      if (cur && changedSince(cur.playedAt, record.at)) { kept++; return }
      try { await provider.setPlayed(id, false, record.profile); restored++ } catch { remaining.played.push(id) }
    })
    await mapLimit(record.positions || [], 4, async (p) => {
      const cur = nowById.get(p.itemId)
      if (cur && p.set != null && (cur.played || Math.abs((cur.positionMs || 0) - p.set) > 5000)) { kept++; return }
      try { await provider.setPosition(p.itemId, p.before || 0, record.profile); restored++ } catch { remaining.positions.push(p) }
    })
    return { restored, kept, failed: remaining.played.length + remaining.positions.length, remaining }
  },
}

const ADAPTERS = { stremio, nuvio, jellyfin }

module.exports = { ADAPTERS, showVideos, nuvioId, forgetForTests: () => videoCache.clear() }
