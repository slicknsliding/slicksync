// What a title's "Open in …" button needs from a Jellyfin, AIOStreams or
// AIOMetadata server: its address and id, who uses it (their user id there -
// Swiftfin's link names the user), the server's own item for this title and,
// on a real Jellyfin, the devices each person has open in a Jellyfin app (for
// Play on). Shared by the admin route (routes/jellyfin.js /open-targets, every
// person in the household) and the member one (routes/publicLibrary.js, the
// caller alone): the caller decides WHICH sign-in rows go in; this only reads
// them. No token ever leaves it.

const cache = new Map() // "<address>|<id>|<type>" or "tmdb|<type>|<id>" -> { at, itemId }
const ITEM_TTL = 10 * 60 * 1000
const TMDB_TTL = 24 * 60 * 60 * 1000

const TITLE_ID = /^(tt\d+|tmdb:\d+|tvdb:\d+|kitsu:\d+)$/
const validTitleId = (id) => TITLE_ID.test(String(id || ''))

function remember(key, itemId) {
  cache.set(key, { at: Date.now(), itemId })
  if (cache.size > 2000) cache.delete(cache.keys().next().value)
}

/**
 * @param rows sign-in rows: { id, username, jellyfinServerUrl, jellyfinServerId,
 *   jellyfinServerKind, jellyfinUserId, __credentialId? } plus whatever the
 *   provider needs to act (the token).
 * @param providerFor (row) => provider
 * @returns { servers, devices, tmdbId }
 */
async function buildOpenTargets({ rows, id, type, providerFor, withDevices = true }) {
  const { encodePackedId } = require('../providers/jellyfin')
  const servers = new Map()
  const devices = []
  for (const row of rows) {
    const address = String(row.jellyfinServerUrl).replace(/\/+$/, '')
    const kind = row.jellyfinServerKind || 'jellyfin'
    let s = servers.get(address)
    if (!s) {
      s = { address, kind, serverId: row.jellyfinServerId || null, people: [], itemId: null }
      servers.set(address, s)
      if (kind === 'aiostreams' || kind === 'aiometadata') {
        s.itemId = encodePackedId({ kind: type, base: id }) || null
      } else {
        const key = `${address}|${id}|${type}`
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < ITEM_TTL) s.itemId = hit.itemId
        else {
          s.itemId = await providerFor(row)?.findItem(id, type).catch(() => null) || null
          remember(key, s.itemId)
        }
      }
    }
    if (!s.people.some((x) => x.userId === row.jellyfinUserId)) s.people.push({ name: row.username, userId: row.jellyfinUserId || null })
    if (withDevices && kind === 'jellyfin' && s.itemId) {
      const list = await providerFor(row)?.controllableSessions().catch(() => []) || []
      for (const d of list) devices.push({ personId: row.id, credentialId: row.__credentialId || null, person: row.username, address, itemId: s.itemId, sessionId: d.id, device: d.device, client: d.client })
    }
  }
  // Infuse opens a title by its TMDB id; Cinemeta carries it for IMDb ids.
  let tmdbId = id.startsWith('tmdb:') ? id.slice(5) : null
  if (!tmdbId && /^tt\d+$/.test(id) && servers.size) {
    const key = `tmdb|${type}|${id}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TMDB_TTL) tmdbId = hit.itemId
    else {
      try {
        const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, { signal: AbortSignal.timeout(5000) })
        const m = r.ok ? (await r.json())?.meta : null
        tmdbId = m?.moviedb_id ? String(m.moviedb_id) : null
      } catch { tmdbId = null }
      remember(key, tmdbId)
    }
  }
  return { servers: [...servers.values()], devices, tmdbId }
}

module.exports = { buildOpenTargets, validTitleId }
