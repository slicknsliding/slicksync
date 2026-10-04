/**
 * Jellyfin provider - a person whose app signs in to a Jellyfin-compatible
 * server: a real Jellyfin, the media server an AIOStreams configuration runs
 * (its web and desktop apps, Infuse, Swiftfin, Findroid...), or AIOMetadata's.
 *
 * One provider is one user on one server, signed in with that user's own
 * token. The server already keeps what they watched - resume points, played
 * marks, favourites - so getLibrary() reads that and hands it back in the
 * same shape the Stremio and Nuvio providers return, which is what every
 * history, session and metrics step downstream reads. What is playing right
 * now comes from the server's own sessions list.
 *
 * There is no addon list on any of these servers for SlickSync to manage, so
 * the addon methods answer "unsupported" and sync leaves these people out.
 */

const { jfRequest, deviceIdFor } = require('./jellyfinAuth')

const TICKS_PER_MS = 10000
const PLAYED_LIMIT = 1000
const FAVORITES_LIMIT = 500

function ticksToMs(ticks) {
  const n = Number(ticks)
  return Number.isFinite(n) && n > 0 ? Math.round(n / TICKS_PER_MS) : 0
}

// A series' own ids, which its episodes do not carry: the show's IMDb id is
// on the Series item. Server ids never change, so they are kept across polls.
const seriesIdCache = new Map() // `${serverKey}:${seriesItemId}` -> { id, name } | null
const SERIES_CACHE_MAX = 5000
function rememberSeries(key, value) {
  if (seriesIdCache.size >= SERIES_CACHE_MAX) seriesIdCache.delete(seriesIdCache.keys().next().value)
  seriesIdCache.set(key, value)
}

// The ids a Stremio addon would use, in the order SlickSync prefers them.
function stremioIdFromProviderIds(providerIds) {
  if (!providerIds || typeof providerIds !== 'object') return null
  const get = (name) => {
    for (const [k, v] of Object.entries(providerIds)) {
      if (k.toLowerCase() === name && v != null && String(v).trim()) return String(v).trim()
    }
    return null
  }
  const imdb = get('imdb')
  if (imdb && /^tt\d+$/.test(imdb)) return imdb
  const tmdb = get('tmdb')
  if (tmdb && /^\d+$/.test(tmdb)) return `tmdb:${tmdb}`
  const tvdb = get('tvdb')
  if (tvdb && /^\d+$/.test(tvdb)) return `tvdb:${tvdb}`
  return null
}

/*
 * AIOStreams and AIOMetadata both build item ids the same way instead of
 * storing them: 16 bytes, byte 0 = 0xa1, then kind and id type, media type, a
 * 48-bit numeric id, season and episode (0xffff for none). Decoding one gives
 * the title's own id even when the server sent no provider ids, and encoding
 * one is how a title SlickSync knows by IMDb id is found on those servers.
 */
const PACKED = 0xa1
const KIND_CODES = { movie: 1, series: 2, season: 3, episode: 4 }
const ID_TYPES = [null, 'tt', 'tmdb:', 'tvdb:', 'kitsu:', 'mal:', 'anilist:', 'anidb:']

function decodePackedId(hexId) {
  const hex = String(hexId || '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  const buf = Buffer.from(hex, 'hex')
  if (buf[0] !== PACKED) return null
  const kindCode = buf[1] >> 4
  const prefix = ID_TYPES[buf[1] & 0x0f]
  if (!prefix) return null
  const numeric = buf.readUIntBE(3, 6)
  const season = buf.readUInt16BE(9)
  const episode = buf.readUInt16BE(11)
  const base = prefix === 'tt' ? `tt${String(numeric).padStart(7, '0')}` : `${prefix}${numeric}`
  const kind = Object.keys(KIND_CODES).find((k) => KIND_CODES[k] === kindCode) || null
  return { kind, base, season: season === 0xffff ? null : season, episode: episode === 0xffff ? null : episode }
}

function encodePackedId({ kind, base, season = null, episode = null, version = 0 }) {
  const m = /^(tt|tmdb:|tvdb:|kitsu:|mal:|anilist:|anidb:)(\d+)$/.exec(String(base || ''))
  if (!m || !KIND_CODES[kind]) return null
  const idType = ID_TYPES.indexOf(m[1])
  const numeric = Number(m[2])
  if (!Number.isSafeInteger(numeric) || numeric > 2 ** 48 - 1) return null
  const buf = Buffer.alloc(16)
  buf[0] = PACKED
  buf[1] = (KIND_CODES[kind] << 4) | idType
  buf[2] = kind === 'movie' ? 1 : 2
  buf.writeUIntBE(numeric, 3, 6)
  buf.writeUInt16BE(season == null ? 0xffff : season, 9)
  buf.writeUInt16BE(episode == null ? 0xffff : episode, 11)
  buf[13] = version
  return buf.toString('hex')
}

function posterFor(stremioId) {
  return /^tt\d+$/.test(stremioId || '') ? `https://images.metahub.space/poster/medium/${stremioId}/img` : null
}

function dateMs(value) {
  const t = value ? new Date(value).getTime() : NaN
  return Number.isFinite(t) ? t : 0
}

function createJellyfinProvider({ serverUrl, token, userId, serverKind = 'jellyfin', serverId, deviceId, slicksyncUserId, onUnauthorized, resolveProfiles, onProfileUnauthorized }) {
  const base = serverUrl
  const serverKey = serverId || serverUrl
  const device = deviceId || deviceIdFor(serverUrl, userId)
  const isAio = serverKind === 'aiostreams' || serverKind === 'aiometadata'
  const kindLabel = serverKind === 'aiostreams' ? 'AIOStreams' : serverKind === 'aiometadata' ? 'AIOMetadata' : 'Jellyfin'

  // Whose sign-in a request runs as: the person's own, or one of their
  // household profiles (utils/jellyfinProfiles.js), each with its own token.
  const self = { userId, token, label: null }

  async function call(path, opts = {}, viewer = self) {
    try {
      return await jfRequest(base, path, { token: viewer.token, deviceId: device, ...opts })
    } catch (e) {
      // Same wording the activity monitor already treats as "Reconnect needed".
      if (e.status === 401) {
        if (viewer === self && typeof onUnauthorized === 'function') { try { await onUnauthorized() } catch {} }
        throw Object.assign(new Error(`Unauthorized: the ${kindLabel} sign-in${viewer.label ? ` for ${viewer.label}` : ''} no longer works (401)`), { status: 401 })
      }
      throw e
    }
  }

  async function itemsQuery(params, viewer = self) {
    const qs = new URLSearchParams({ userId: viewer.userId, ...params })
    const data = await call(`/Items?${qs}`, {}, viewer)
    return Array.isArray(data?.Items) ? data.Items : []
  }

  async function resumeItems(viewer = self) {
    const qs = new URLSearchParams({ userId: viewer.userId, IncludeItemTypes: 'Movie,Episode', Fields: 'ProviderIds', Limit: '200', EnableUserData: 'true' })
    try {
      const data = await call(`/UserItems/Resume?${qs}`, {}, viewer)
      return Array.isArray(data?.Items) ? data.Items : []
    } catch (e) {
      // Servers older than 10.9 only know the per-user path.
      if (e.status !== 404) throw e
      const data = await call(`/Users/${viewer.userId}/Items/Resume?${qs}`, {}, viewer)
      return Array.isArray(data?.Items) ? data.Items : []
    }
  }

  // What this user has playing right now. A user's own token sees only their
  // own sessions, on every kind of server.
  async function nowPlaying(viewer = self) {
    const sessions = await call('/Sessions', {}, viewer)
    if (!Array.isArray(sessions)) return []
    return sessions.filter((s) => s?.NowPlayingItem && (!s.UserId || String(s.UserId).replace(/-/g, '').toLowerCase() === viewer.userId))
  }

  /** The show's own id and name for each series item id. */
  async function resolveSeries(seriesItemIds, viewer = self) {
    const out = new Map()
    const missing = []
    for (const id of seriesItemIds) {
      const key = `${serverKey}:${id}`
      if (seriesIdCache.has(key)) out.set(id, seriesIdCache.get(key))
      else missing.push(id)
    }
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100)
      let items = []
      try { items = await itemsQuery({ Ids: chunk.join(','), Fields: 'ProviderIds' }, viewer) } catch { items = [] }
      const found = new Map(items.map((it) => [String(it.Id).replace(/-/g, '').toLowerCase(), it]))
      for (const id of chunk) {
        const it = found.get(id)
        let stremioId = it ? stremioIdFromProviderIds(it.ProviderIds) : null
        if (!stremioId) stremioId = decodePackedId(id)?.base || null
        const value = stremioId ? { id: stremioId, name: it?.Name || null } : null
        // An item the server could not answer for this time is asked again
        // next poll rather than remembered as unknown.
        if (it || value) rememberSeries(`${serverKey}:${id}`, value)
        out.set(id, value)
      }
    }
    return out
  }

  function normId(id) {
    return String(id || '').replace(/-/g, '').toLowerCase()
  }

  function movieIdOf(item) {
    return stremioIdFromProviderIds(item.ProviderIds) || decodePackedId(item.Id)?.base || null
  }

  // The person's household profiles, read once per provider.
  let profilesPromise = null
  function profileViewers() {
    if (typeof resolveProfiles !== 'function') return Promise.resolve([])
    if (!profilesPromise) {
      profilesPromise = Promise.resolve()
        .then(() => resolveProfiles())
        .then((rows) => (Array.isArray(rows) ? rows : []).map((p) => ({ id: p.id, userId: normId(p.jellyfinUserId), token: p.token, label: p.name })))
        .catch((e) => { console.warn('[JellyfinProvider] Could not load household profiles:', e?.message); return [] })
    }
    return profilesPromise
  }
  async function viewerFor(label) {
    if (!label) return self
    return (await profileViewers()).find((v) => v.label === label) || self
  }

  /**
   * One sign-in's viewing as SlickSync library entries: one per movie and per
   * show, Stremio-style - a show carries the episode it was last on - plus
   * what is playing right now.
   */
  async function readViewer(viewer) {
    const [resume, played, favorites, live] = await Promise.all([
      resumeItems(viewer),
      itemsQuery({
        Recursive: 'true', Filters: 'IsPlayed', IncludeItemTypes: 'Movie,Episode', Fields: 'ProviderIds',
        SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: String(PLAYED_LIMIT), EnableUserData: 'true',
      }, viewer),
      itemsQuery({
        Recursive: 'true', Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series', Fields: 'ProviderIds',
        Limit: String(FAVORITES_LIMIT), EnableUserData: 'true',
      }, viewer).catch(() => []),
      nowPlaying(viewer).catch(() => []),
    ])

    // Live positions win over what the server last saved: clients report
    // progress to the session every few seconds, but the saved resume point
    // can lag until they pause or stop.
    const liveById = new Map()
    const now = Date.now()
    for (const s of live) {
      const it = s.NowPlayingItem
      liveById.set(normId(it.Id), {
        item: it,
        positionMs: ticksToMs(s.PlayState?.PositionTicks),
        paused: s.PlayState?.IsPaused === true,
        // Which device and app - "Living room TV", "Infuse". Real Jellyfin
        // reports these; AIOStreams and AIOMetadata have no sessions list.
        device: s.DeviceId || s.DeviceName ? { id: s.DeviceId || null, name: s.DeviceName || null, client: s.Client || null } : null,
      })
    }

    const seriesIds = new Set()
    for (const it of [...resume, ...played, ...live.map((s) => s.NowPlayingItem)]) {
      if (it?.Type === 'Episode' && it.SeriesId) seriesIds.add(normId(it.SeriesId))
    }
    const series = await resolveSeries([...seriesIds], viewer)

    // Candidates are ranked by when they were last touched; a live one is "now".
    const entries = new Map()
    function consider(it, { livePos = null, liveAt = null, paused = false, device = null } = {}) {
      if (!it || (it.Type !== 'Movie' && it.Type !== 'Episode')) return
      const ud = it.UserData || {}
      const durationMs = ticksToMs(it.RunTimeTicks)
      let id, type, name, videoId = null, season = null, episode = null
      if (it.Type === 'Movie') {
        id = movieIdOf(it)
        type = 'movie'
        name = it.Name || ''
        videoId = id
      } else {
        const show = series.get(normId(it.SeriesId))
        id = show?.id || null
        type = 'series'
        name = it.SeriesName || show?.name || ''
        season = Number.isInteger(it.ParentIndexNumber) ? it.ParentIndexNumber : null
        episode = Number.isInteger(it.IndexNumber) ? it.IndexNumber : null
        if (id && season != null && episode != null) videoId = `${id}:${season}:${episode}`
        if (!videoId) {
          const packed = decodePackedId(it.Id)
          if (id && packed?.season != null && packed?.episode != null) videoId = `${id}:${packed.season}:${packed.episode}`
        }
      }
      if (!id) return

      let positionMs = livePos != null ? livePos : ticksToMs(ud.PlaybackPositionTicks)
      // Played with no position left is how a server records "finished":
      // it clears the resume point. Reported as at the end, the way the
      // other providers report a finished title.
      const finished = livePos == null && ud.Played === true && positionMs === 0
      if (finished && durationMs > 0) positionMs = durationMs
      const lastWatchedMs = liveAt || dateMs(ud.LastPlayedDate) || 0
      const candidate = {
        _id: id,
        name,
        type,
        poster: posterFor(id),
        state: {
          video_id: videoId,
          season,
          episode,
          timeOffset: positionMs,
          duration: durationMs,
          timeWatched: 0,
          overallTimeWatched: positionMs,
          lastWatched: lastWatchedMs ? new Date(lastWatchedMs).toISOString() : null,
          timesWatched: Number(ud.PlayCount) || 0,
          flaggedWatched: ud.Played === true ? 1 : 0,
          // Which household profile it was watched on, if not the person's
          // own sign-in - history and watch time carry it, like a Nuvio profile.
          ...(viewer.label ? { profileLabel: viewer.label } : {}),
          // Positions here are where playback is, not time spent: a seek
          // jumps them. Metrics caps what such a jump can add by the real
          // time that passed (see metricsProcessor's wall-clock cap).
          wallClockCapped: true,
        },
        _mtime: lastWatchedMs || now,
        _ctime: lastWatchedMs || now,
        removed: false,
        _jf: { itemId: normId(it.Id), seriesId: it.SeriesId ? normId(it.SeriesId) : null, live: livePos != null, paused, profile: viewer.label, device },
      }
      const kept = entries.get(id)
      if (!kept || (candidate._mtime > kept._mtime) || (candidate._jf.live && !kept._jf.live)) entries.set(id, candidate)
    }

    for (const it of played) consider(it)
    for (const it of resume) consider(it)
    for (const [, l] of liveById) consider(l.item, { livePos: l.positionMs, liveAt: l.paused ? null : now, paused: l.paused, device: l.device })

    // Favourites with nothing played are library bookmarks, the same as a
    // Stremio library item that was added but never opened.
    for (const it of favorites) {
      const id = it.Type === 'Series' ? (stremioIdFromProviderIds(it.ProviderIds) || decodePackedId(it.Id)?.base) : movieIdOf(it)
      if (!id || entries.has(id)) continue
      entries.set(id, {
        _id: id,
        name: it.Name || '',
        type: it.Type === 'Series' ? 'series' : 'movie',
        poster: posterFor(id),
        state: viewer.label ? { profileLabel: viewer.label } : {},
        _mtime: now,
        _ctime: now,
        removed: false,
        _jf: { itemId: normId(it.Id), favorite: true, profile: viewer.label },
      })
    }
    for (const entry of entries.values()) {
      if (favorites.some((f) => normId(f.Id) === entry._jf.itemId || normId(f.Id) === entry._jf.seriesId)) entry._jf.favorite = true
    }
    return entries
  }

  return {
    type: 'jellyfin',
    serverKind,

    // --- Addons: none of these servers has an addon list to manage ---
    supportsAddons: false,
    async getAddons() { return { addons: [], unsupported: true } },
    async setAddons() { return null },
    async addAddon() { return null },
    async clearAddons() { return null },

    // --- Content ---

    /**
     * The person's viewing: their own sign-in's, and each household profile
     * they track, merged one entry per title - the most recently touched wins,
     * the way a Nuvio account's profiles are merged. A profile that cannot be
     * read this time is left out of this pass; the person's own sign-in
     * failing is a connection problem and is reported as one.
     */
    async getLibrary() {
      const profiles = await profileViewers()
      const own = await readViewer(self)
      const merged = new Map(own)
      const reads = await Promise.all(profiles.map((viewer) => readViewer(viewer).catch(async (e) => {
        console.warn(`[JellyfinProvider] Could not read profile ${viewer.label}:`, e?.message)
        // Signed out on the server (a PIN change, a password change): the
        // household card asks for a fresh sign-in instead of failing quietly.
        if (e?.status === 401 && typeof onProfileUnauthorized === 'function') {
          try { await onProfileUnauthorized(viewer) } catch {}
        }
        return null
      })))
      for (const entries of reads) {
        if (!entries) continue
        for (const [id, candidate] of entries) {
          const kept = merged.get(id)
          if (!kept || (candidate._mtime > kept._mtime) || (candidate._jf.live && !kept._jf.live)) merged.set(id, candidate)
        }
      }

      // Now Playing reads this, between polls - see utils/jellyfinLive.js.
      // Everything playing on any of the person's sign-ins counts, not only
      // the entry that won the merge for its title.
      try {
        const playing = []
        for (const entries of [own, ...reads]) {
          if (!entries) continue
          for (const e of entries.values()) {
            if (!e._jf.live) continue
            playing.push({
              itemId: e._id,
              itemType: e.type,
              videoId: e.type === 'series' ? e.state.video_id : null,
              itemName: e.name || null,
              poster: e.poster,
              season: e.state.season,
              episode: e.state.episode,
              positionMs: e.state.timeOffset || 0,
              durationMs: e.state.duration || null,
              paused: e._jf.paused === true,
              profileLabel: e._jf.profile || null,
              device: e._jf.device || null,
            })
          }
        }
        require('../utils/jellyfinLive').recordLive(slicksyncUserId, playing)
      } catch {}

      return [...merged.values()]
    },

    /** What is playing for this user now, straight from the server. */
    async getNowPlaying() {
      return nowPlaying()
    },

    // --- Library writes ---

    /**
     * The server's item for a title SlickSync knows by its own id
     * (tt123 / tt123:1:2). AIOStreams and AIOMetadata build their ids from
     * the title's id, so they are computed and checked; a real Jellyfin is
     * searched through its movies and shows.
     */
    async findItem(stremioId, type) {
      const [baseId, s, e] = String(stremioId || '').split(':')
      const season = s != null && s !== '' ? Number(s) : null
      const episode = e != null && e !== '' ? Number(e) : null
      const wantEpisode = type === 'series' && Number.isInteger(season) && Number.isInteger(episode)
      if (isAio) {
        for (const version of [0, 1]) {
          const id = encodePackedId({ kind: wantEpisode ? 'episode' : type === 'series' ? 'series' : 'movie', base: baseId, season: wantEpisode ? season : null, episode: wantEpisode ? episode : null, version })
          if (!id) break
          try {
            const item = await call(`/Items/${id}?userId=${userId}`)
            if (item?.Id) return normId(item.Id)
          } catch { /* try the next layout */ }
        }
        return null
      }
      const kind = type === 'series' ? 'Series' : 'Movie'
      const all = await itemsQuery({ Recursive: 'true', IncludeItemTypes: kind, Fields: 'ProviderIds', Limit: '5000' })
      const match = all.find((it) => stremioIdFromProviderIds(it.ProviderIds) === baseId)
      if (!match) return null
      if (!wantEpisode) return normId(match.Id)
      const eps = await call(`/Shows/${match.Id}/Episodes?${new URLSearchParams({ userId, season: String(season) })}`)
      const ep = (Array.isArray(eps?.Items) ? eps.Items : []).find((it) => it.IndexNumber === episode && (it.ParentIndexNumber == null || it.ParentIndexNumber === season))
      return ep ? normId(ep.Id) : null
    },

    async setPlayed(itemId, played, profile = null) {
      const viewer = await viewerFor(profile)
      return call(`/UserPlayedItems/${itemId}?userId=${viewer.userId}`, { method: played ? 'POST' : 'DELETE' }, viewer)
    },

    async setFavorite(itemId, favorite, profile = null) {
      const viewer = await viewerFor(profile)
      return call(`/UserFavoriteItems/${itemId}?userId=${viewer.userId}`, { method: favorite ? 'POST' : 'DELETE' }, viewer)
    },

    /** Take a title out of Continue Watching without marking it watched. */
    async clearResume(itemId, profile = null) {
      const viewer = await viewerFor(profile)
      return call(`/UserItems/${itemId}/UserData?userId=${viewer.userId}`, { method: 'POST', body: { PlaybackPositionTicks: 0 } }, viewer)
    },

    supportsLibraryWrite: true,

    // Stremio's library is Jellyfin's favourites: adding a title to the
    // library favourites it, removing one unfavourites it.
    async addLibraryItem(changes) {
      for (const change of Array.isArray(changes) ? changes : [changes]) {
        const id = change?._jf?.itemId || await this.findItem(change._id, change.type)
        if (!id) continue
        await this.setFavorite(id, change.removed !== true, change?._jf?.profile || null)
      }
      return { ok: true }
    },

    // Removing a title takes it off the device: out of favourites and out of
    // Continue Watching. What was watched stays watched.
    async removeLibraryItem(changes) {
      const library = await this.getLibrary()
      for (const change of Array.isArray(changes) ? changes : [changes]) {
        const entry = library.find((it) => it._id === change._id)
        const ids = new Set()
        if (entry?._jf?.itemId) ids.add(entry._jf.itemId)
        if (!entry) {
          const found = await this.findItem(change._id, change.type)
          if (found) ids.add(found)
        }
        const profile = entry?._jf?.profile || null
        for (const id of ids) {
          await this.setFavorite(id, false, profile).catch(() => {})
          await this.clearResume(id, profile).catch(() => {})
        }
        if (entry?._jf?.seriesId) await this.setFavorite(entry._jf.seriesId, false, profile).catch(() => {})
      }
      return { ok: true }
    },

    // Likes - no equivalent
    async getLikeStatus() { return null },
    async setLikeStatus() { return null },
  }
}

module.exports = { createJellyfinProvider, stremioIdFromProviderIds, decodePackedId, encodePackedId, ticksToMs }
