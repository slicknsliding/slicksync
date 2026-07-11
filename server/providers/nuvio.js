/**
 * Nuvio provider — Supabase REST implementation.
 * Translates between Supabase addon rows and the universal addon shape.
 */

const { supabaseGet, supabasePost, supabaseDelete, supabaseRpc } = require('./supabase')
const { refreshNuvioToken, isTokenExpired } = require('./nuvioAuth')

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

function createNuvioProvider({ refreshToken: initialRefreshToken, userId, onTokenRefresh }) {
  async function ensureAuth() {
    const cached = tokenCache.get(userId)
    if (cached?.accessToken && !isTokenExpired(cached.accessToken)) {
      return cached.accessToken
    }

    const existing = refreshPromises.get(userId)
    if (existing) return existing

    const promise = (async () => {
      try {
        const currentRefreshToken = tokenCache.get(userId)?.refreshToken || initialRefreshToken
        const result = await refreshNuvioToken(currentRefreshToken)
        const newAccessToken = result.access_token
        const newRefreshToken = result.refresh_token || currentRefreshToken

        tokenCache.set(userId, { accessToken: newAccessToken, refreshToken: newRefreshToken })

        if (result.refresh_token && onTokenRefresh) {
          await onTokenRefresh(newRefreshToken)
        }
        return newAccessToken
      } catch (e) {
        console.warn(`[NuvioProvider] Auth expired for user ${userId}, token refresh failed:`, e?.message)
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
      const rows = await supabaseGet('addons', {
        user_id: `eq.${userId}`,
        profile_id: 'eq.1',
        order: 'sort_order.asc,created_at.asc',
        select: '*'
      }, accessToken)

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
      const accessToken = await ensureAuth()
      // Snapshot current addons before delete for rollback on failure
      const snapshot = await supabaseGet('addons', {
        user_id: `eq.${userId}`,
        profile_id: 'eq.1',
        select: '*'
      }, accessToken)

      // Delete all current addons, then insert desired set
      await supabaseDelete('addons', {
        user_id: `eq.${userId}`,
        profile_id: 'eq.1'
      }, accessToken)

      if (addons.length > 0) {
        const rows = addons.map((addon, i) => ({
          user_id: userId,
          profile_id: 1,
          url: addon.transportUrl,
          name: addon.manifest?.name || addon.transportName || addon.name || '',
          enabled: true,
          sort_order: i
        }))
        try {
          await supabasePost('addons', rows, accessToken)
        } catch (insertErr) {
          // Attempt to restore previous addons
          console.error('setAddons: insert failed after delete, attempting rollback:', insertErr?.message)
          if (snapshot && snapshot.length > 0) {
            try {
              const cleanRows = snapshot.map(({ id, created_at, updated_at, ...rest }) => rest)
              await supabasePost('addons', cleanRows, accessToken)
            } catch (rollbackErr) {
              console.error('setAddons: rollback also failed, user has empty addon list:', rollbackErr?.message)
            }
          }
          throw insertErr
        }
      }
    },

    async addAddon(url, manifest) {
      const accessToken = await ensureAuth()
      // Get current max sort_order
      const current = await supabaseGet('addons', {
        user_id: `eq.${userId}`,
        profile_id: 'eq.1',
        select: 'sort_order',
        order: 'sort_order.desc',
        limit: '1'
      }, accessToken)
      const nextOrder = (current[0]?.sort_order ?? -1) + 1

      await supabasePost('addons', [{
        user_id: userId,
        profile_id: 1,
        url,
        name: manifest?.name || '',
        enabled: true,
        sort_order: nextOrder
      }], accessToken)
    },

    async clearAddons() {
      const accessToken = await ensureAuth()
      await supabaseDelete('addons', {
        user_id: `eq.${userId}`,
        profile_id: 'eq.1'
      }, accessToken)
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
        const profiles = await supabaseRpc('sync_pull_profiles', {}, accessToken)
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

      // Combine library + watch progress to build libraryItem shape, per profile
      const perProfile = await Promise.all(profileIds.map(async (profileId) => {
        const [libraryResult, progressResult, watchedResult] = await Promise.allSettled([
          supabaseRpc('sync_pull_library', { p_profile_id: profileId }, accessToken),
          supabaseRpc('sync_pull_watch_progress', { p_profile_id: profileId }, accessToken),
          supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken)
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

      // Enrich items with metadata (titles + posters) from Cinemeta
      const seen = new Set()
      const idsToEnrich = items.filter(i => !i.name || !i.poster).reduce((acc, i) => {
        if (!seen.has(i._id)) { seen.add(i._id); acc.push({ id: i._id, type: i.type }) }
        return acc
      }, [])
      const metaMap = new Map()
      await Promise.allSettled(
        idsToEnrich.map(async ({ id, type }) => {
          try {
            const metaType = type === 'series' ? 'series' : 'movie'
            const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${id}.json`)
            if (res.ok) {
              const data = await res.json()
              if (data?.meta) metaMap.set(id, data.meta)
            }
          } catch {}
        })
      )

      for (const item of items) {
        const meta = metaMap.get(item._id)
        if (meta) {
          if (!item.name) item.name = meta.name || ''
          if (!item.poster) item.poster = meta.poster || null
        }
      }

      return items
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

module.exports = { createNuvioProvider }
