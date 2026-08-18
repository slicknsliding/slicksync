// Live usage data for debrid Vault entries (Real-Debrid/TorBox) - Vault's
// existing checks only ever answer "is this key valid" (vaultCheckers.js);
// this answers "what am I actually getting for it" - active downloads right
// now and premium days remaining, fetched live rather than the manually-
// entered cost/expiresAt fields Vault already tracks.
//
// Deliberately scoped to just these two fields, not full byte-level traffic
// totals: Real-Debrid's /traffic endpoint reports usage per-hoster (a
// dozen+ separate entries with their own reset cadence), and TorBox's own
// API docs don't expose a confirmed field name for a lifetime-downloaded
// total at all - both would mean guessing at a shape rather than showing
// real numbers. "Active downloads" and "premium days left" are the two
// numbers both providers' APIs unambiguously support.

const REAL_DEBRID_BASE = 'https://api.real-debrid.com/rest/1.0'
const TORBOX_BASE = 'https://api.torbox.app/v1/api'

function timeoutSignal(ms) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
}

function daysUntil(date) {
  if (!date) return null
  const ms = new Date(date).getTime() - Date.now()
  return ms > 0 ? Math.ceil(ms / (24 * 60 * 60 * 1000)) : 0
}

async function fetchRealDebridUsage(apiKey) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const [userRsp, activeRsp] = await Promise.all([
      fetch(`${REAL_DEBRID_BASE}/user`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
      fetch(`${REAL_DEBRID_BASE}/torrents?filter=active&limit=100`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
    ])
    cancel()
    if (!userRsp.ok) return null
    const user = await userRsp.json()
    const activeTorrents = activeRsp.ok ? await activeRsp.json() : []
    return {
      premiumDaysLeft: typeof user.premium === 'number' ? Math.ceil(user.premium / 86400) : null,
      activeDownloads: Array.isArray(activeTorrents) ? activeTorrents.length : null,
    }
  } catch {
    cancel()
    return null
  }
}

async function fetchTorBoxUsage(apiKey) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const [userRsp, listRsp] = await Promise.all([
      fetch(`${TORBOX_BASE}/user/me`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
      fetch(`${TORBOX_BASE}/torrents/mylist?bypass_cache=true`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
    ])
    cancel()
    if (!userRsp.ok) return null
    const userBody = await userRsp.json()
    const user = userBody?.data || userBody
    const listBody = listRsp.ok ? await listRsp.json() : null
    const torrents = Array.isArray(listBody?.data) ? listBody.data : (Array.isArray(listBody) ? listBody : [])
    const activeDownloads = torrents.filter((t) => t && t.download_finished === false).length
    return {
      premiumDaysLeft: user?.premium_expires_at ? daysUntil(user.premium_expires_at) : null,
      activeDownloads,
    }
  } catch {
    cancel()
    return null
  }
}

// Keyed off testType, not the free-text `provider` display field - testType
// is the same controlled enum vaultCheckers.js's CHECKERS map already
// dispatches on ('real_debrid'/'torbox'), so this stays correct even if an
// entry's provider label was typed differently.
async function fetchDebridUsage(testType, apiKey) {
  if (testType === 'real_debrid') return fetchRealDebridUsage(apiKey)
  if (testType === 'torbox') return fetchTorBoxUsage(apiKey)
  return null
}

// ---- Auto-remove: finished torrents idle past a configured age ------------
//
// "Finished" and "idle since" are read differently per provider since
// neither exposes the exact same shape (confirmed against Real-Debrid's own
// API docs and TorBox's OpenAPI spec / TypeScript SDK, not guessed):
//  - Real-Debrid: status === 'downloaded' means finished, and `ended` (only
//    present once finished) is the real completion timestamp.
//  - TorBox: download_finished === true means finished; TorBox's API has no
//    separate "finished at" field, so `updated_at` is used as the best
//    available proxy (a finished torrent generally stops being touched).
async function listEligibleRealDebridTorrents(apiKey, afterDays) {
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${REAL_DEBRID_BASE}/torrents?limit=100`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
    cancel()
    if (!res.ok) return []
    const torrents = await res.json()
    const cutoffMs = Date.now() - afterDays * 24 * 60 * 60 * 1000
    return (Array.isArray(torrents) ? torrents : [])
      .filter((t) => t?.status === 'downloaded' && t?.ended && new Date(t.ended).getTime() < cutoffMs)
      .map((t) => ({ id: t.id, name: t.filename }))
  } catch {
    cancel()
    return []
  }
}

async function listEligibleTorBoxTorrents(apiKey, afterDays) {
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${TORBOX_BASE}/torrents/mylist?bypass_cache=true`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
    cancel()
    if (!res.ok) return []
    const body = await res.json()
    const torrents = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : [])
    const cutoffMs = Date.now() - afterDays * 24 * 60 * 60 * 1000
    return torrents
      .filter((t) => t?.download_finished === true && t?.updated_at && new Date(t.updated_at).getTime() < cutoffMs)
      .map((t) => ({ id: t.id, name: t.name }))
  } catch {
    cancel()
    return []
  }
}

async function listEligibleTorrents(testType, apiKey, afterDays) {
  if (testType === 'real_debrid') return listEligibleRealDebridTorrents(apiKey, afterDays)
  if (testType === 'torbox') return listEligibleTorBoxTorrents(apiKey, afterDays)
  return []
}

async function deleteRealDebridTorrent(apiKey, torrentId) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${REAL_DEBRID_BASE}/torrents/delete/${encodeURIComponent(torrentId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    cancel()
    return res.ok || res.status === 204
  } catch {
    cancel()
    return false
  }
}

async function deleteTorBoxTorrent(apiKey, torrentId) {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    // Confirmed request shape against TorBox's community TypeScript SDK
    // (torrent_id + lowercase operation: 'delete') - their own OpenAPI spec
    // types the body as untyped `any` with no example, so this is the one
    // piece of this file taken from real working client code rather than
    // TorBox's own docs directly.
    const res = await fetch(`${TORBOX_BASE}/torrents/controltorrent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent_id: torrentId, operation: 'delete' }),
      signal,
    })
    cancel()
    return res.ok
  } catch {
    cancel()
    return false
  }
}

async function deleteTorrent(testType, apiKey, torrentId) {
  if (testType === 'real_debrid') return deleteRealDebridTorrent(apiKey, torrentId)
  if (testType === 'torbox') return deleteTorBoxTorrent(apiKey, torrentId)
  return false
}

module.exports = {
  fetchDebridUsage,
  fetchRealDebridUsage,
  fetchTorBoxUsage,
  listEligibleTorrents,
  deleteTorrent,
}
