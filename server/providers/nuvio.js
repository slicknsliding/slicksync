/**
 * Nuvio provider — Supabase REST implementation.
 * Translates between Supabase addon rows and the universal addon shape.
 */

const { supabaseGet, supabasePost, supabaseDelete, supabaseRpc, isCircuitOpen, isTransientFailure } = require('./supabase')
const { refreshNuvioToken, isTokenExpired } = require('./nuvioAuth')
const { mapLimit } = require('../utils/mapLimit')

// Module-level (not per-provider-instance) token cache and in-flight-refresh
// tracking, keyed by Nuvio userId. createProvider() is called fresh on
// every single operation (see providers/index.js) rather than being reused
// across a session, so without this cache every getAddons/getLibrary/etc.
// call — even seconds apart — was forcing a brand new token refresh against
// Nuvio's API. That's what caused the constant "Nuvio token refresh failed"
// log spam and 429s: a scheduled 5-minute activity check alone was one
// refresh per user per cycle, forever, even though a Supabase access token
// is typically valid for about an hour. Caching at module level means the
// cache survives across separate createNuvioProvider() calls for the same
// user, cutting refresh calls down to roughly once per real token lifetime
// instead of once per operation.
//
// The in-flight-refresh map serves a second purpose: Supabase refresh
// tokens are single-use (each refresh rotates it). If two concurrent
// requests for the same user both see an expired/missing token and both
// fire off their own refreshNuvioToken() call using the same refresh
// token, the second one fails because the first already consumed and
// rotated it. Tracking one shared in-flight promise per userId means
// concurrent callers await the same refresh instead of racing each other.
const tokenCache = new Map()      // userId -> { accessToken, refreshToken }
const refreshPromises = new Map() // userId -> Promise<string> (in-flight refresh)

// One write at a time per person and profile. A list is replaced by deleting
// it and inserting the new one, so two writes for the same list that overlap
// can interleave (delete, delete, insert, insert) and leave it holding both,
// or break on the insert that finds the other's rows still there. Sync All,
// a group edit and a person's own sync all reach the same list, so this is
// not rare. In-process on purpose: one server process serves a household, so
// a database lock would add nothing. A write that fails does not hold up the
// next one.
const writeQueues = new Map() // `${userId}:${profileId}` -> tail of the queue
function inWriteQueue(key, task) {
  const run = (writeQueues.get(key) || Promise.resolve()).then(task)
  const tail = run.then(() => {}, () => {})
  writeQueues.set(key, tail)
  tail.then(() => { if (writeQueues.get(key) === tail) writeQueues.delete(key) })
  return run
}

// While the backend is being held back (see the breaker in supabase.js), a
// write does not start: the person's sync fails with this message before
// their list is touched, instead of going ahead and being refused halfway.
// This only covers a write that has not begun. Once the old list has been
// deleted, setAddons carries on whatever the breaker says (see there), because
// stopping at that point is what would leave the list empty.
function refuseWhileBackendIsDown(serverConfig) {
  if (!isCircuitOpen(serverConfig)) return
  const err = new Error('Nuvio backend unavailable - too many recent failures')
  err.status = 503
  throw err
}

// After the old list has been deleted, the only thing between a person and an
// empty list is the insert that follows, so it is not held back by the breaker
// and is sent again when the backend was merely busy: the same backend that
// has just been rate-limiting is the one this has to get through. Waits are
// short and few (the person's queue slot is held for all of them), and are
// stretched to a Retry-After the backend asked for, up to maxWaitMs. A mutable
// object so a test can shorten them.
const WRITE_RETRY = {
  insertMs: [1500, 4000],
  restoreMs: [1500, 4000, 10000],
  maxWaitMs: 15000
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs `attempt`, and again after each wait in `waitsMs` for as long as it
// fails in a way that is worth another try. Throws the last failure.
async function retryWhileTransient(attempt, waitsMs) {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (i >= waitsMs.length || !isTransientFailure(e)) throw e
      await sleep(Math.min(Math.max(waitsMs[i], e?.retryAfterMs || 0), WRITE_RETRY.maxWaitMs))
    }
  }
}

// A write that may have reached the backend without its answer coming back:
// no status at all (timeout, dropped connection) or a server error. A 429, a
// conflict or any other 4xx was answered, and the breaker's own refusal never
// left this server.
function isUnansweredWrite(err) {
  if (err?.code === 'BACKEND_REFUSED' || err?.code === 'CIRCUIT_OPEN') return false
  const status = err?.status
  return status === undefined || status === null || status >= 500
}

// What the caller's failure message says when the new list was not saved and
// the old one could not be put back either. Callers show an error's message
// as the reason the sync failed, so it says what state the list is in and what
// to do about it.
function listNotRestoredError(insertErr) {
  const err = new Error('Their addon list could not be written back after the change failed and may be empty. Run a sync to fill it again.')
  err.status = insertErr?.status
  err.retryAfterMs = insertErr?.retryAfterMs
  err.code = 'ADDON_LIST_NOT_RESTORED'
  err.cause = insertErr
  return err
}

// The same address twice is never a wanted list, and some Nuvio backends
// reject the whole insert over it. Keeps the first of each, matching how the
// desired list is built (utils/sync.js dedupeByUrl).
//
// Two addresses are the same when they match apart from the case of the
// scheme and the host, which a server never tells apart. The rest of the
// address is compared as it is: a config token or key in the path or query is
// case-sensitive, and two addons that differ only there are two addons.
function addonKey(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  try {
    const u = new URL(trimmed)
    return `${u.protocol.toLowerCase()}//${u.username}:${u.password}@${u.host.toLowerCase()}${u.pathname}${u.search}${u.hash}`
  } catch {
    return trimmed
  }
}

function dedupeAddonsByUrl(addons) {
  const seen = new Set()
  const out = []
  for (const addon of addons) {
    const key = addonKey(addon?.transportUrl)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(addon)
  }
  return out
}

// Titles Nuvio sent no name or poster for are looked up on Cinemeta. What a
// lookup found is kept between polls: this runs for every Nuvio person every
// minute, and every title in their library was being asked for again each
// time, with nothing to stop a slow answer holding the whole pass up. A title
// Cinemeta has never heard of is kept longer than one it simply failed to
// answer for - a name that is missing is not recorded as watched, so a blip
// must not hold it back for long.
const META = {
  ttlMs: 24 * 60 * 60 * 1000,      // found
  missTtlMs: 60 * 60 * 1000,       // answered "no such title"
  failTtlMs: 5 * 60 * 1000,        // no answer at all (timeout, network, 5xx)
  max: 5000,
  concurrency: 6,
  timeoutMs: 8000,
  // Past this, the titles still to ask for wait for the next poll rather than
  // holding this one up; names missing go first so they are what gets done.
  budgetMs: 20000
}
const metaCache = new Map() // `${metaType}:${id}` -> { meta: { name, poster } | null, expires }

function cachedMeta(key) {
  const hit = metaCache.get(key)
  if (!hit) return undefined
  if (hit.expires <= Date.now()) { metaCache.delete(key); return undefined }
  return hit
}

function rememberMeta(key, meta, ttlMs) {
  metaCache.delete(key)
  if (metaCache.size >= META.max) metaCache.delete(metaCache.keys().next().value)
  metaCache.set(key, { meta, expires: Date.now() + ttlMs })
}

// Never throws: a title that cannot be looked up keeps whatever name it had.
async function lookUpTitle(key, metaType, id) {
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${id}.json`, { signal: AbortSignal.timeout(META.timeoutMs) })
    if (res.status === 404) return rememberMeta(key, null, META.missTtlMs)
    if (!res.ok) return rememberMeta(key, null, META.failTtlMs)
    const data = await res.json()
    if (data?.meta) rememberMeta(key, { name: data.meta.name || '', poster: data.meta.poster || null }, META.ttlMs)
    else rememberMeta(key, null, META.missTtlMs)
  } catch {
    rememberMeta(key, null, META.failTtlMs)
  }
}

// profileId is Nuvio's own profile_index (1 for the primary profile), NOT the
// profile row's UUID. A Nuvio account can hold several profiles, and a profile
// either keeps its own addon list or is marked as using the primary's - see
// `uses_primary_addons` on what getProfiles() returns. Everything addon-shaped
// below is scoped to one profile, so a SlickSync user that points at profile 2
// reads and writes profile 2's list and never touches the primary's.
function createNuvioProvider({ refreshToken: initialRefreshToken, userId, profileId, resolveProfileId, resolveLibraryProfiles, onTokenRefresh, resolveServerConfig }) {
  // Resolved the same way the server config is, and for the same reason: the
  // profile lives on the User row, and the dozens of places that build a
  // provider select only the columns they happen to need. Requiring every one
  // of them to remember a new column would mean a caller that forgot it wrote
  // one profile's addons into another's list. A caller that already has the
  // value passes it and nothing is read; anyone else gets it looked up once,
  // on the first addon call, and cached for the life of the provider.
  let cachedProfileId = Number.isInteger(Number(profileId)) && Number(profileId) > 0 ? Number(profileId) : null
  async function getAddonProfileId() {
    if (cachedProfileId !== null) return cachedProfileId
    if (typeof resolveProfileId === 'function') {
      try {
        const resolved = Number(await resolveProfileId())
        if (Number.isInteger(resolved) && resolved > 0) {
          cachedProfileId = resolved
          return cachedProfileId
        }
      } catch (e) {
        console.warn(`[NuvioProvider] Could not resolve the profile for user ${userId}, using the primary:`, e?.message)
      }
    }
    cachedProfileId = 1
    return cachedProfileId
  }
  // Which Nuvio backend this account talks to. Resolved lazily rather than
  // at construction because createProvider() is synchronous everywhere it's
  // called, and reading the account's setting needs a DB round-trip. Cached
  // per provider instance so a sync pass doesn't re-query per request.
  let serverConfigPromise = null
  function getServerConfig() {
    if (!resolveServerConfig) return Promise.resolve(undefined)
    if (!serverConfigPromise) {
      serverConfigPromise = Promise.resolve()
        .then(() => resolveServerConfig())
        .catch(() => undefined)
    }
    return serverConfigPromise
  }

  async function ensureAuth() {
    const cached = tokenCache.get(userId)
    if (cached?.unsaved && !cached.saving && onTokenRefresh) {
      cached.saving = true
      Promise.resolve(onTokenRefresh(cached.refreshToken))
        .then(() => { cached.unsaved = false })
        .catch(() => {})
        .finally(() => { cached.saving = false })
    }
    if (cached?.accessToken && !isTokenExpired(cached.accessToken)) {
      return cached.accessToken
    }

    const existing = refreshPromises.get(userId)
    if (existing) return existing

    const promise = (async () => {
      try {
        const currentRefreshToken = tokenCache.get(userId)?.refreshToken || initialRefreshToken
        const result = await refreshNuvioToken(currentRefreshToken, await getServerConfig())
        const newAccessToken = result.access_token
        const newRefreshToken = result.refresh_token || currentRefreshToken

        tokenCache.set(userId, { accessToken: newAccessToken, refreshToken: newRefreshToken })

        // The old refresh token is spent the moment Nuvio answers, so the new
        // one has to reach the database. A failed save is retried, and is not
        // reported as an expired sign-in - the sign-in works, and the token
        // kept in memory is saved on the next use.
        if (result.refresh_token && onTokenRefresh) {
          await onTokenRefresh(newRefreshToken)
            .catch(() => onTokenRefresh(newRefreshToken))
            .catch((saveError) => {
              tokenCache.set(userId, { accessToken: newAccessToken, refreshToken: newRefreshToken, unsaved: true })
              console.warn(`[NuvioProvider] Could not save the new sign-in token for user ${userId}, will retry:`, saveError?.message)
            })
        }
        return newAccessToken
      } catch (e) {
        console.warn(`[NuvioProvider] Auth expired for user ${userId}, token refresh failed:`, e?.message)
        // A backend address that is refused is not an expired sign-in, and
        // reconnecting cannot help; the person is told what is actually wrong.
        if (e?.code === 'BACKEND_REFUSED') throw e
        const err = new Error('Provider authentication expired')
        err.code = 'PROVIDER_AUTH_EXPIRED'
        err.cause = e
        throw err
      } finally {
        refreshPromises.delete(userId)
      }
    })()

    refreshPromises.set(userId, promise)
    return promise
  }

  return {
    type: 'nuvio',

    // --- Addon Transport ---

    async getAddons() {
      const accessToken = await ensureAuth()
      const addonProfileId = await getAddonProfileId()
      const rows = await supabaseGet('addons', {
        user_id: `eq.${userId}`,
        profile_id: `eq.${addonProfileId}`,
        order: 'sort_order.asc,created_at.asc',
        select: '*'
      }, accessToken, await getServerConfig())

      // Transform to universal shape (minimal manifest — sync uses urlOnly mode)
      const addons = rows.map(row => ({
        transportUrl: row.url,
        transportName: '',
        manifest: {
          id: row.url,
          name: row.name || '',
          types: [],
          catalogs: [],
          resources: []
        }
      }))
      return { addons }
    },

    async setAddons(addons) {
      // Checked before anything is touched: a list that is not a list used to
      // fail only after the old one had been deleted.
      if (!Array.isArray(addons)) throw new TypeError('setAddons needs a list of addons')
      const addonProfileId = await getAddonProfileId()
      return inWriteQueue(`${userId}:${addonProfileId}`, async () => {
        const serverConfig = await getServerConfig()
        refuseWhileBackendIsDown(serverConfig)
        const accessToken = await ensureAuth()
        const wanted = dedupeAddonsByUrl(addons)

        // The whole list in one call, the way Nuvio's own apps write it
        // (sync_push_addons, AddonRepository.pushToServer in NuvioMobile):
        // the backend swaps it over in one step, so the list is never empty
        // in between and a failure leaves the old list whole. p_addons is
        // the raw array - a JSON string would be stored double-encoded (see
        // setCollections). A backend without that call - an older
        // self-hosted one answers 404 - gets the delete-and-insert below.
        try {
          await supabaseRpc('sync_push_addons', {
            p_profile_id: addonProfileId,
            p_addons: wanted.map((addon, i) => ({
              url: addon.transportUrl,
              name: addon.manifest?.name || addon.transportName || addon.name || '',
              enabled: true,
              sort_order: i,
            })),
          }, accessToken, serverConfig)
          return
        } catch (pushErr) {
          if (pushErr?.status !== 404) throw pushErr
        }

        // Snapshot current addons before delete for rollback on failure
        const snapshot = await supabaseGet('addons', {
          user_id: `eq.${userId}`,
          profile_id: `eq.${addonProfileId}`,
          select: '*'
        }, accessToken, serverConfig)

        // What the list holds right now, read without regard to the breaker
        // because it is what decides what to do after a write whose answer was
        // lost. Null when it could not be read.
        const readListBack = async () => {
          try {
            return await supabaseGet('addons', {
              user_id: `eq.${userId}`,
              profile_id: `eq.${addonProfileId}`,
              select: '*'
            }, await ensureAuth(), serverConfig, { bypassBreaker: true })
          } catch {
            return null
          }
        }

        // Delete all current addons, then insert desired set. A backend that
        // is held back by now refuses the delete itself, before it is sent.
        try {
          await supabaseDelete('addons', {
            user_id: `eq.${userId}`,
            profile_id: `eq.${addonProfileId}`
          }, accessToken, serverConfig)
        } catch (deleteErr) {
          // A delete that went through but whose answer was lost leaves the
          // list empty: carry on as if it had been answered. Anything still
          // there means nothing was deleted, and the failure stands.
          if (!isUnansweredWrite(deleteErr)) throw deleteErr
          const now = await readListBack()
          if (!Array.isArray(now) || now.length > 0) throw deleteErr
        }

        // From here the list is only whole again once something has been
        // inserted, so these writes are not held back by the breaker and are
        // sent again while the backend is only busy (see WRITE_RETRY). The
        // token is asked for each time, as the waits can outlast it. `sent`
        // notes whether any try went unanswered, as that one may have landed.
        const insertRows = (rows, waitsMs, sent) => retryWhileTransient(
          async () => {
            try {
              return await supabasePost('addons', rows, await ensureAuth(), serverConfig, { bypassBreaker: true })
            } catch (e) {
              if (isUnansweredWrite(e)) sent.unanswered = true
              throw e
            }
          },
          waitsMs
        )
        const restoreRows = snapshot && snapshot.length > 0
          ? snapshot.map(({ id, created_at, updated_at, ...rest }) => rest)
          : null

        if (wanted.length > 0) {
          const rows = wanted.map((addon, i) => ({
            user_id: userId,
            profile_id: addonProfileId,
            url: addon.transportUrl,
            name: addon.manifest?.name || addon.transportName || addon.name || '',
            enabled: true,
            sort_order: i
          }))
          const sent = { unanswered: false }
          try {
            await insertRows(rows, WRITE_RETRY.insertMs, sent)
          } catch (insertErr) {
            // A try that went unanswered may have landed, and a retry after it
            // meets a conflict. Look at what the list holds before putting
            // anything back: if it is the new list the write is done.
            if (sent.unanswered) {
              const now = await readListBack()
              if (Array.isArray(now) && now.length > 0) {
                const have = new Set(now.map((row) => addonKey(row?.url)))
                const want = new Set(rows.map((row) => addonKey(row.url)))
                if (have.size === want.size && [...want].every((key) => have.has(key))) return
              }
            }
            // Attempt to restore previous addons
            console.error('setAddons: insert failed after delete, attempting rollback:', insertErr?.message)
            if (restoreRows) {
              const restoreSent = { unanswered: false }
              try {
                await insertRows(restoreRows, WRITE_RETRY.restoreMs, restoreSent)
              } catch (rollbackErr) {
                console.error(`setAddons: rollback also failed, user ${userId} profile ${addonProfileId} has no addon list (${restoreRows.length} addons to put back):`, rollbackErr?.message)
                // A conflict means rows of that list are there already (an
                // insert that did land but whose answer was lost), so the list
                // is not empty and the original failure is the true one. The
                // same goes for any list found there after an unanswered try.
                let listThere = rollbackErr?.status === 409
                if (!listThere && restoreSent.unanswered) {
                  const now = await readListBack()
                  listThere = Array.isArray(now) && now.length > 0
                }
                if (!listThere) throw listNotRestoredError(insertErr)
              }
            }
            throw insertErr
          }
        }
      })
    },

    async addAddon(url, manifest) {
      const addonProfileId = await getAddonProfileId()
      return inWriteQueue(`${userId}:${addonProfileId}`, async () => {
        const accessToken = await ensureAuth()
        // Get current max sort_order
        const current = await supabaseGet('addons', {
          user_id: `eq.${userId}`,
          profile_id: `eq.${addonProfileId}`,
          select: 'sort_order',
          order: 'sort_order.desc',
          limit: '1'
        }, accessToken, await getServerConfig())
        const nextOrder = (current[0]?.sort_order ?? -1) + 1

        await supabasePost('addons', [{
          user_id: userId,
          profile_id: addonProfileId,
          url,
          name: manifest?.name || '',
          enabled: true,
          sort_order: nextOrder
        }], accessToken, await getServerConfig())
      })
    },

    async clearAddons() {
      const addonProfileId = await getAddonProfileId()
      return inWriteQueue(`${userId}:${addonProfileId}`, async () => {
        const serverConfig = await getServerConfig()
        refuseWhileBackendIsDown(serverConfig)
        const accessToken = await ensureAuth()
        await supabaseDelete('addons', {
          user_id: `eq.${userId}`,
          profile_id: `eq.${addonProfileId}`
        }, accessToken, serverConfig)
      })
    },

    // --- Content ---

    async getLibrary() {
      const accessToken = await ensureAuth()

      // Nuvio accounts can have multiple profiles (like Netflix profiles) -
      // sync_pull_profiles lists them. Watch activity can land on any one of
      // them, so a hardcoded profile 1 silently misses everything watched
      // under profile 2, 3, etc. Pull every profile and merge. Falls back to
      // profile 1 alone if the profile list itself can't be fetched, so a
      // single-profile account (or a transient failure) still works.
      let profileIds = [1]
      const profileNames = new Map() // profile_index -> display name
      try {
        const profiles = await supabaseRpc('sync_pull_profiles', {}, accessToken, await getServerConfig())
        if (Array.isArray(profiles) && profiles.length > 0) {
          const ids = []
          for (const p of profiles) {
            const idx = p.profile_index ?? p.profileIndex
            if (Number.isFinite(idx)) {
              ids.push(idx)
              if (p.name) profileNames.set(idx, p.name)
            }
          }
          if (ids.length > 0) profileIds = ids
        }
      } catch (e) {
        console.warn('[NuvioProvider] Failed to list profiles, falling back to profile 1 only:', e?.message)
      }

      // Only the profiles this person's viewing is made of. Several people
      // here can share one Nuvio login, one per profile, and reading every
      // profile for each of them put everyone's viewing on everyone. Which
      // profile counts for whom lives in utils/nuvioProfiles.js.
      if (typeof resolveLibraryProfiles === 'function') {
        try {
          const owned = await resolveLibraryProfiles(profileIds)
          if (Array.isArray(owned)) profileIds = owned
        } catch (e) {
          console.warn('[NuvioProvider] Could not work out which profiles count, reading all of them:', e?.message)
        }
        if (profileIds.length === 0) return []
      }

      // Combine library + watch progress to build libraryItem shape, per profile
      const perProfile = await Promise.all(profileIds.map(async (profileId) => {
        const [libraryResult, progressResult, watchedResult] = await Promise.allSettled([
          supabaseRpc('sync_pull_library', { p_profile_id: profileId }, accessToken, await getServerConfig()),
          supabaseRpc('sync_pull_watch_progress', { p_profile_id: profileId }, accessToken, await getServerConfig()),
          supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken, await getServerConfig())
        ])
        return {
          profileId,
          profileName: profileNames.get(profileId) || null,
          library: libraryResult.status === 'fulfilled' ? libraryResult.value : [],
          progress: progressResult.status === 'fulfilled' ? progressResult.value : [],
          watched: watchedResult.status === 'fulfilled' ? watchedResult.value : [],
          libraryFailed: libraryResult.status === 'rejected',
          progressFailed: progressResult.status === 'rejected'
        }
      }))

      if (perProfile.every(r => r.libraryFailed && r.progressFailed)) {
        throw new Error('Failed to fetch library: both RPCs failed for every profile')
      }

      // Build title lookup from watched items across all profiles (which have titles)
      const titleMap = new Map()
      for (const { watched } of perProfile) {
        if (Array.isArray(watched)) {
          for (const w of watched) {
            if (w.content_id && w.title) titleMap.set(w.content_id, w.title)
          }
        }
      }

      // Transform watch progress to universal libraryItem shape, merged across
      // profiles. If the same content was watched under more than one profile,
      // keep whichever entry is most recent.
      const itemsById = new Map()
      for (const { progress, profileName } of perProfile) {
        for (const p of (Array.isArray(progress) ? progress : [])) {
          const mtime = new Date(p.last_watched).getTime()
          const existing = itemsById.get(p.content_id)
          if (existing && existing._mtime >= mtime) continue
          itemsById.set(p.content_id, {
            _id: p.content_id,
            name: p.title || p.name || titleMap.get(p.content_id) || '',
            type: p.content_type,
            poster: null,
            state: {
              video_id: p.video_id,
              season: p.season,
              episode: p.episode,
              timeOffset: p.position,
              duration: p.duration,
              timeWatched: 0,
              overallTimeWatched: p.position || 0,
              lastWatched: new Date(p.last_watched).toISOString(),
              nuvioProfile: profileName
            },
            _mtime: mtime,
            _ctime: mtime,
            removed: false
          })
        }
      }
      const items = Array.from(itemsById.values())

      // Merge in any library-only items (bookmarked but no progress), from any profile
      for (const { library, profileName } of perProfile) {
        if (!Array.isArray(library)) continue
        for (const item of library) {
          if (!itemsById.has(item.content_id)) {
            const placeholder = {
              _id: item.content_id,
              name: item.title || titleMap.get(item.content_id) || '',
              type: item.content_type,
              poster: null,
              state: { nuvioProfile: profileName },
              _mtime: Date.now(),
              _ctime: Date.now(),
              removed: false
            }
            itemsById.set(item.content_id, placeholder)
            items.push(placeholder)
          }
        }
      }

      // Enrich items with metadata (titles + posters) from Cinemeta. What was
      // found on an earlier poll is reused; only titles not known yet are
      // asked for, a few at a time, within a time budget (see META). A title
      // that cannot be looked up keeps the name it had, and never fails the
      // library read.
      const keyOf = (item) => `${item.type === 'series' ? 'series' : 'movie'}:${item._id}`
      const toAsk = new Map() // key -> { key, metaType, id, needsName }
      for (const item of items) {
        if (!item._id || (item.name && item.poster)) continue
        const key = keyOf(item)
        const queued = toAsk.get(key)
        if (queued) queued.needsName = queued.needsName || !item.name
        else toAsk.set(key, { key, metaType: item.type === 'series' ? 'series' : 'movie', id: item._id, needsName: !item.name })
      }
      const unknown = [...toAsk.values()]
        .filter((t) => cachedMeta(t.key) === undefined)
        .sort((a, b) => Number(b.needsName) - Number(a.needsName))
      if (unknown.length > 0) {
        const stopAsking = Date.now() + META.budgetMs
        await mapLimit(unknown, META.concurrency, async (t) => {
          if (Date.now() >= stopAsking) return
          await lookUpTitle(t.key, t.metaType, t.id)
        })
      }

      for (const item of items) {
        if (!item._id) continue
        const meta = cachedMeta(keyOf(item))?.meta
        if (meta) {
          if (!item.name) item.name = meta.name || ''
          if (!item.poster) item.poster = meta.poster || null
        }
      }

      return items
    },

    // --- Profiles / Collections (admin-only, Nuvio Collections manager) ---

    // Nuvio accounts can have multiple profiles (see getLibrary()'s own
    // comment above) - this was previously only ever used internally for
    // the library merge fan-out. Exposed as its own method now that an
    // admin-facing profile picker needs the raw list.
    async getProfiles() {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('sync_pull_profiles', {}, accessToken, await getServerConfig())
      return Array.isArray(rows) ? rows : []
    },

    // Each profile's picture: the avatar it picked from Nuvio's catalogue (a
    // public file on the backend), else null - callers fall back to the
    // profile's colour (avatar_color_hex).
    async getProfileAvatars() {
      const accessToken = await ensureAuth()
      const config = await getServerConfig()
      const [profiles, catalog] = await Promise.all([
        supabaseRpc('sync_pull_profiles', {}, accessToken, config),
        supabaseRpc('get_avatar_catalog', {}, accessToken, config).catch(() => []),
      ])
      const base = require('./supabase').backendUrl(config)
      const paths = new Map((Array.isArray(catalog) ? catalog : []).map((a) => [a.id, a.storage_path]))
      const out = new Map()
      for (const p of Array.isArray(profiles) ? profiles : []) {
        const idx = Number(p.profile_index ?? p.profileIndex)
        if (!Number.isInteger(idx)) continue
        const path = p.avatar_id ? paths.get(p.avatar_id) : null
        out.set(idx, { url: path ? `${base}/storage/v1/object/public/avatars/${String(path).split('/').map(encodeURIComponent).join('/')}` : null, color: p.avatar_color_hex || null })
      }
      return out
    },

    // A Nuvio TV or computer that isn't signed in shows a 6-character code.
    // A signed-in account looks the code up (which device is asking) and
    // approves it; the device is then signed in to this account and picks
    // its own profile. Both answer { success, message, device_name,
    // device_type } - an unknown or expired code is success: false, not an
    // error, and Nuvio counts failed tries against the account.
    async getDeviceLogin(code) {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('get_device_login_session', { p_user_code: code }, accessToken, await getServerConfig())
      return (Array.isArray(rows) ? rows[0] : rows) || null
    },

    async approveDeviceLogin(code) {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('approve_device_login_session', { p_user_code: code }, accessToken, await getServerConfig())
      return (Array.isArray(rows) ? rows[0] : rows) || null
    },

    // One profile's watch state as Nuvio keeps it, unmerged: finished titles
    // and episodes (watched_items, with the date), resume points
    // (watch_progress) and the library. Read a page at a time - the backend
    // may cap one answer below what a long history holds.
    async getWatchState(profileId) {
      const accessToken = await ensureAuth()
      const config = await getServerConfig()
      const PAGE = 1000
      const watched = []
      for (let page = 1; page <= 200; page++) {
        const rows = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId, p_page: page, p_page_size: PAGE }, accessToken, config)
        const list = Array.isArray(rows) ? rows : []
        watched.push(...list)
        if (list.length < PAGE) break
      }
      const progress = await supabaseRpc('sync_pull_watch_progress', { p_profile_id: profileId }, accessToken, config)
      const library = []
      for (let offset = 0; offset < 100000; offset += 500) {
        const rows = await supabaseRpc('sync_pull_library', { p_profile_id: profileId, p_limit: 500, p_offset: offset }, accessToken, config)
        const list = Array.isArray(rows) ? rows : []
        library.push(...list)
        if (list.length < 500) break
      }
      return { watched, progress: Array.isArray(progress) ? progress : [], library }
    },

    // Writes for Copy watch history and Keep in step. Each is an upsert (or a
    // delete by key) on one profile, tagged with SlickSync as the origin so
    // Nuvio's apps pick the change up as coming from elsewhere.
    async pushWatchedItems(profileId, items) {
      if (!items?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_watched_items', { p_items: items, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },
    async deleteWatchedItems(profileId, keys) {
      if (!keys?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_delete_watched_items', { p_keys: keys, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },
    async pushWatchProgress(profileId, entries) {
      if (!entries?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_watch_progress', { p_entries: entries, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },
    async deleteWatchProgress(profileId, progressKeys) {
      if (!progressKeys?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_delete_watch_progress', { p_keys: progressKeys, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },
    async pushLibraryItems(profileId, items) {
      if (!items?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_library_items', { p_items: items, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },
    async deleteLibraryItems(profileId, keys) {
      if (!keys?.length) return
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_delete_library_items', { p_keys: keys, p_profile_id: profileId, p_origin_client_id: 'slicksync' }, accessToken, await getServerConfig())
    },

    // A profile's media servers (Jellyfin / Emby) - the list Nuvio's apps
    // sign in to. One list per profile, replaced whole on every write, so a
    // caller always pulls first and keeps what isn't theirs.
    async getMediaServers(profileId) {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('sync_pull_media_servers', { p_profile_id: profileId }, accessToken, await getServerConfig())
      let raw = (Array.isArray(rows) ? rows[0] : rows)?.servers_json
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { raw = [] }
      }
      return Array.isArray(raw) ? raw : []
    },

    // p_servers is the raw array, not a JSON string (the same double-encoding
    // trap as sync_push_collections).
    async setMediaServers(profileId, servers) {
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_media_servers', {
        p_profile_id: profileId,
        p_servers: servers,
        p_origin_client_id: 'slicksync',
      }, accessToken, await getServerConfig())
    },

    // profileId here is Nuvio's own profile_index (an integer, e.g. 1) -
    // NOT the profile row's id (a UUID). Easy to mix up since getProfiles()
    // returns both on the same row.
    async getCollections(profileId) {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('sync_pull_collections', { p_profile_id: profileId }, accessToken, await getServerConfig())
      const raw = rows?.[0]?.collections_json
      if (!raw) return []
      // Confirmed against the real API (via two independent third-party
      // tools built against it): collections_json comes back either
      // already-parsed or still a JSON string depending on how the RPC's
      // return type gets decoded - handle both rather than assume one.
      if (typeof raw === 'string') {
        try { return JSON.parse(raw) } catch { return [] }
      }
      return Array.isArray(raw) ? raw : []
    },

    // Home catalog settings - the synced per-profile blob that controls
    // home ROW ORDER and per-row title overrides (see
    // utils/nuvioHomePlacement.js for the full shape, learned from the
    // desktop client's own HomeCatalogSettingsSyncService). Platform is
    // 'mobile' / 'desktop' / the 'home_catalog_shared' fallback bucket.
    async getHomeCatalogSettings(profileId, platform) {
      const accessToken = await ensureAuth()
      const rows = await supabaseRpc('sync_pull_home_catalog_settings', {
        p_profile_id: profileId,
        p_platform: platform,
      }, accessToken, await getServerConfig())
      return Array.isArray(rows) ? rows : []
    },

    // p_settings_json must be the raw object, NOT a JSON string - same
    // double-encoding trap sync_push_collections already taught us (see
    // setCollections below).
    async pushHomeCatalogSettings(profileId, platform, settings) {
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_home_catalog_settings', {
        p_profile_id: profileId,
        p_platform: platform,
        p_settings_json: settings,
      }, accessToken, await getServerConfig())
    },

    // Full replace, matching sync_push_collections' own semantics - there is
    // no partial-update RPC, so callers must always push the complete array.
    //
    // p_collections_json must be the raw array, NOT a JSON string. Confirmed
    // live (2026-08-06) via a raw fetch intercept on sync_pull_collections:
    // stringifying it here meant supabaseRpc's own JSON.stringify(body) on
    // the outer request double-encoded it, so collections_json was stored
    // (and always came back) as a JSON *string* containing escaped JSON
    // text, not a real array - typeof came back "string", not "object".
    // Nuvio's real desktop client (composeApp/.../CollectionModels.kt,
    // SupabaseCollectionBlob.collectionsJson: JsonElement) expects a native
    // JSON array there; getting a string instead makes its strict
    // kotlinx.serialization decode of the whole payload throw, which its
    // own sync code silently swallows (logs and discards) - so literally
    // nothing written by this app ever appeared on-device, regardless of
    // which fields were set on any individual folder. This masked itself
    // completely from every read this app ever did of its own writes,
    // since getCollections() already defensively re-parses a string return
    // back into an array - see that function's own comment.
    async setCollections(profileId, collections) {
      const accessToken = await ensureAuth()
      await supabaseRpc('sync_push_collections', {
        p_profile_id: profileId,
        p_collections_json: collections
      }, accessToken, await getServerConfig())
    },

    // Community Covers - nuvio.tv's own public gallery of user-submitted
    // cover art (GIFs/JPG/PNG) for Collections/folders/rows, the same place
    // the account owner found their own GIF covers before SlickSync had
    // this feature. Same Supabase-issued access token as every other
    // authenticated call here, just against nuvio.tv's own Next API route
    // instead of Supabase's REST/RPC endpoints directly - confirmed via a
    // real authenticated browser session (the endpoint 401s without this
    // exact Bearer token; param names/values - sort, orientation, format -
    // confirmed by watching the real UI's own network requests, not
    // guessed).
    async getCommunityCovers({ sort = 'recent', orientation = 'all', format = 'all', page = 1, limit = 24, search = '' } = {}) {
      const accessToken = await ensureAuth()
      const params = new URLSearchParams({ sort, orientation, page: String(page), limit: String(limit) })
      if (format && format !== 'all') params.set('format', format)
      // Real server-side search - confirmed live against nuvio.tv/api/covers
      // (nuvio.tv's own search box in the UI doesn't fire an observable
      // request, but the API itself supports it; ?search= filters
      // pagination.total correctly and returns 0 results for garbage terms).
      if (search && search.trim()) params.set('search', search.trim())
      const res = await fetch(`https://nuvio.tv/api/covers?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`Nuvio covers request failed (${res.status})`)
      return res.json()
    },

    // Library writes — no-op; returns null to signal "not supported". Callers guard via providerType.
    // Capability flag: Nuvio library is read-only in this implementation
    supportsLibraryWrite: false,
    async addLibraryItem() { return null },
    async removeLibraryItem() { return null },

    // Likes — no Nuvio equivalent
    async getLikeStatus() { return null },
    async setLikeStatus() { return null }
  }
}

module.exports = {
  createNuvioProvider,
  _test: {
    META,
    WRITE_RETRY,
    clearMetaCache() { metaCache.clear() },
    metaCacheSize() { return metaCache.size },
  }
}
