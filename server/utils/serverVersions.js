// Which version each Jellyfin, AIOStreams and AIOMetadata server people use
// is running, and whether a newer stable release is out - for Health ->
// Servers. A server answers /System/Info/Public without a sign-in: Jellyfin
// gives its Version, AIOStreams and AIOMetadata their own build in the
// `aiostreams` block (with the channel - stable or nightly - on AIOStreams).
// Releases come from each project's GitHub releases, stable ones only.
//
// Read in the background at most every 6 hours and kept in memory, so the
// Health page stays a page of facts already known; a cold start waits a
// moment for the first read.

const { jfRequest } = require('../providers/jellyfinAuth')

const TTL_MS = 6 * 60 * 60 * 1000
const COLD_WAIT_MS = 4000
const REPOS = { jellyfin: 'jellyfin/jellyfin', aiostreams: 'Viren070/AIOStreams', aiometadata: 'cedya77/aiometadata' }

const seen = new Map() // server key -> { at, version, channel, commit }
const releases = new Map() // kind -> { at, tag }
let refreshing = null

/** [major, minor, patch] from "12.2", "10.10.7" or "v2.35.9"; null otherwise. */
function parseVersion(raw) {
  const m = String(raw || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

async function latestRelease(kind) {
  const cached = releases.get(kind)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.tag
  try {
    const res = await fetch(`https://api.github.com/repos/${REPOS[kind]}/releases?per_page=20`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return cached?.tag || null
    const list = await res.json()
    // AIOStreams also releases its desktop and TV apps, and nightlies.
    const stable = (Array.isArray(list) ? list : []).find((r) => !r.prerelease && !r.draft && /^v?\d+\.\d+/.test(String(r.tag_name || '')))
    releases.set(kind, { at: Date.now(), tag: stable?.tag_name || null })
    return stable?.tag_name || null
  } catch {
    return cached?.tag || null
  }
}

async function readServer(url) {
  const info = await jfRequest(url, '/System/Info/Public', { timeoutMs: 5000 })
  const ext = info?.aiostreams?.version
  if (ext && typeof ext === 'object') return { version: ext.tag || null, channel: ext.channel || null, commit: ext.commit || null }
  return { version: info?.Version || null, channel: null, commit: null }
}

async function refresh(servers) {
  const stale = servers.filter((s) => !seen.has(s.key) || Date.now() - seen.get(s.key).at >= TTL_MS)
  await Promise.all([
    ...stale.map(async (s) => {
      try {
        seen.set(s.key, { at: Date.now(), ...(await readServer(s.url)) })
      } catch {
        // Down or refusing: what it said last time stands; try again later.
        if (seen.has(s.key)) seen.get(s.key).at = Date.now()
      }
    }),
    ...[...new Set(servers.map((s) => s.kind))].map((k) => latestRelease(k)),
  ])
}

/**
 * Add { version, channel, commit, latest, updateAvailable } to each server
 * row ({ key, kind, url }). Waits briefly when nothing is known yet.
 */
async function annotate(rows) {
  const known = rows.every((r) => seen.has(r.key)) && rows.every((r) => releases.has(r.kind))
  const stale = rows.some((r) => !seen.has(r.key) || Date.now() - seen.get(r.key).at >= TTL_MS)
  if (stale && !refreshing) refreshing = refresh(rows).finally(() => { refreshing = null })
  if (!known && refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, COLD_WAIT_MS))])
  return rows.map((r) => {
    const v = seen.get(r.key) || {}
    const latest = releases.get(r.kind)?.tag || null
    const mine = parseVersion(v.version)
    const theirs = parseVersion(latest)
    // A nightly build is ahead of the last stable one, or close to it - not "behind".
    const updateAvailable = !!(mine && theirs && v.channel !== 'nightly' && isNewer(theirs, mine))
    return { ...r, version: v.version || null, channel: v.channel || null, commit: v.commit || null, latest, updateAvailable }
  })
}

module.exports = { annotate, parseVersion, isNewer, forgetForTests: () => { seen.clear(); releases.clear() } }
