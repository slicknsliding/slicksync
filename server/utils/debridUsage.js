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

module.exports = { fetchDebridUsage, fetchRealDebridUsage, fetchTorBoxUsage }
