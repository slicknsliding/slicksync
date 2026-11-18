// Which addresses streaming through the household's AIOStreams login are not
// the household's.
//
// The login is shared, so it says whose login a stream used, never whose
// device. A device someone else has the link on (real case, Nov 2026: a home
// connection in another state played titles through the household's login
// for weeks) was shown as the login's own person - "NuvioSLICK started
// watching" - and raised "streamed but not recorded, add the sign-in" alerts
// for viewings no sign-in of theirs could ever record.
//
// An address is the household's when:
//  - someone claimed it for a person (ProxyDeviceClaim), or marked it known
//    with no one in particular (a claim with an empty userId - "It's fine,
//    don't ask again"), or
//  - a stream from it lined up with one of their sign-ins' own records: the
//    same title, recorded while that stream was open or just after. Time AND
//    title - a title alone ties a stranger to anyone who watched it later the
//    same day.
// It is called unknown only when, on top of none of that:
//  - it has been streaming for a while (NEW_ADDRESS_GRACE_MS): a home whose
//    address just changed lines up within minutes of its first record, and
//    should not be announced as a stranger in the meantime;
//  - some other address of theirs is known: on a new install with nothing
//    recorded yet, every address would otherwise be "unknown".
// A stream named only by a hash can't be compared by title, so it is never
// evidence either way.

const { isPlayingConnection } = require('./proxyPlaying')
const { isOpaqueStreamName, proxyDisplayTitle } = require('./proxyTitle')

const NEW_ADDRESS_GRACE_MS = 12 * 60 * 60 * 1000
const EVIDENCE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000
const RECORD_BEFORE_MS = 5 * 60 * 1000 // a record can land a little before the proxy row's start
const RECORD_AFTER_MS = 15 * 60 * 1000 // ...or at the pause/stop just after its last request
const KNOWN_TTL_MS = 6 * 60 * 60 * 1000
const UNKNOWN_TTL_MS = 5 * 60 * 1000
const CHUNK = 25

const evidence = new Map() // `${accountId}|${ip}` -> { known, at }
const baseline = new Map() // accountId -> { ok, at }

const imdbOf = (id) => /^tt\d+/.exec(String(id || ''))?.[0] || null
function normalizeTitle(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\bs\d{1,2}e\d{1,3}\b.*$/i, '')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
const rowName = (row) => proxyDisplayTitle(row) || row.displayName || ''
const isNamed = (row) => !!row.metadataItemId || !!row.metadataName || !isOpaqueStreamName(String(row.displayName || '').trim())

// Did any stream in `rows` line up with a record (same title, around its time)?
async function linesUpWithARecord(prisma, accountId, rows) {
  const named = rows.filter(isNamed)
  for (let i = 0; i < named.length; i += CHUNK) {
    const chunk = named.slice(i, i + CHUNK).map((r) => ({
      from: new Date(r.startTime).getTime() - RECORD_BEFORE_MS,
      to: new Date(r.lastSeenAt || r.startTime).getTime() + RECORD_AFTER_MS,
      id: imdbOf(r.metadataItemId),
      title: normalizeTitle(rowName(r)),
    }))
    const from = new Date(Math.min(...chunk.map((c) => c.from)))
    const to = new Date(Math.max(...chunk.map((c) => c.to)))
    const inRange = { gte: from, lte: to }
    const [sessions, movies, episodes] = await Promise.all([
      prisma.watchSession.findMany({
        where: { accountId, OR: [{ startTime: inRange }, { endTime: inRange }, { updatedAt: inRange }] },
        select: { itemId: true, itemName: true, startTime: true, endTime: true, updatedAt: true },
      }),
      prisma.movieWatchHistory.findMany({ where: { accountId, watchedAt: inRange }, select: { itemId: true, itemName: true, watchedAt: true } }),
      prisma.episodeWatchHistory.findMany({ where: { accountId, watchedAt: inRange }, select: { showId: true, showName: true, watchedAt: true } }),
    ])
    const records = [
      ...sessions.map((s) => ({ id: imdbOf(s.itemId), title: normalizeTitle(s.itemName), times: [s.startTime, s.endTime, s.updatedAt] })),
      ...movies.map((m) => ({ id: imdbOf(m.itemId), title: normalizeTitle(m.itemName), times: [m.watchedAt] })),
      ...episodes.map((e) => ({ id: imdbOf(e.showId), title: normalizeTitle(e.showName), times: [e.watchedAt] })),
    ]
    for (const c of chunk) {
      for (const rec of records) {
        const same = (c.id && rec.id && c.id === rec.id) || (c.title && rec.title && c.title === rec.title)
        if (!same) continue
        if (rec.times.some((t) => t && new Date(t).getTime() >= c.from && new Date(t).getTime() <= c.to)) return true
      }
    }
  }
  return false
}

async function hasEvidence(prisma, accountId, ip) {
  const key = `${accountId}|${ip}`
  const hit = evidence.get(key)
  if (hit && Date.now() - hit.at < (hit.known ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) return hit.known
  const rows = (await prisma.proxyStreamSession.findMany({
    where: { accountId, clientIp: ip, startTime: { gte: new Date(Date.now() - EVIDENCE_WINDOW_MS) } },
    select: { startTime: true, lastSeenAt: true, displayName: true, metadataName: true, metadataItemId: true, requestCount: true },
    orderBy: { startTime: 'desc' },
    take: 300,
  })).filter(isPlayingConnection)
  const known = await linesUpWithARecord(prisma, accountId, rows)
  evidence.set(key, { known, at: Date.now() })
  return known
}

// Some other address of theirs is known (a claim for a person, or evidence).
async function householdHasAKnownAddress(prisma, accountId, ip, claimedIps) {
  if ([...claimedIps.entries()].some(([addr, userId]) => addr !== ip && userId)) return true
  const hit = baseline.get(accountId)
  if (hit && hit.ok && Date.now() - hit.at < KNOWN_TTL_MS) return true
  if (hit && !hit.ok && Date.now() - hit.at < UNKNOWN_TTL_MS) return false
  // The busiest addresses of the last month: the household's home is one.
  const recent = await prisma.proxyStreamSession.findMany({
    where: { accountId, startTime: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    select: { clientIp: true },
    take: 2000,
    orderBy: { startTime: 'desc' },
  })
  const counts = new Map()
  for (const r of recent) if (r.clientIp && r.clientIp !== ip) counts.set(r.clientIp, (counts.get(r.clientIp) || 0) + 1)
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([addr]) => addr)
  let ok = false
  for (const addr of busiest) {
    if (await hasEvidence(prisma, accountId, addr)) { ok = true; break }
  }
  baseline.set(accountId, { ok, at: Date.now() })
  return ok
}

// Where to change the AIOStreams password: its own page, when the address
// SlickSync polls is one a browser can open (an internal container name is not).
function aiostreamsPage() {
  try {
    const u = new URL(String(process.env.AIOSTREAMS_URL || ''))
    if (!/^https?:$/.test(u.protocol)) return null
    const host = u.hostname
    if (!host.includes('.') || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return null
    return `${u.origin}/stremio/configure`
  } catch {
    return null
  }
}

// The server itself, the home network or a private tunnel (Tailscale's
// 100.64/10): never a stranger's device.
function isInternalAddress(ip) {
  const a = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '')
  if (a === '::1' || a.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(a)) return true
  const p = a.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false
  return p[0] === 127 || p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
}

/**
 * The unknown ones among `ips`, each with what the "Who is this?" box shows:
 * Map(ip -> { address, firstSeen, titles, aiostreamsPage }). Never throws -
 * on any error it reports nothing as unknown (the old attribution stands).
 */
async function unknownAddresses(prisma, accountId, ips) {
  const out = new Map()
  const wanted = [...new Set((ips || []).filter(Boolean))]
  if (!wanted.length) return out
  try {
    const claims = await prisma.proxyDeviceClaim.findMany({ where: { accountId }, select: { clientIp: true, userId: true } })
    const claimedIps = new Map(claims.map((c) => [c.clientIp, c.userId || '']))
    for (const ip of wanted) {
      if (claimedIps.has(ip) || isInternalAddress(ip)) continue
      const first = await prisma.proxyStreamSession.findFirst({ where: { accountId, clientIp: ip }, orderBy: { startTime: 'asc' }, select: { startTime: true } })
      if (!first || Date.now() - new Date(first.startTime).getTime() < NEW_ADDRESS_GRACE_MS) continue
      if (await hasEvidence(prisma, accountId, ip)) continue
      if (!(await householdHasAKnownAddress(prisma, accountId, ip, claimedIps))) continue
      const all = (await prisma.proxyStreamSession.findMany({
        where: { accountId, clientIp: ip },
        select: { startTime: true, lastSeenAt: true, displayName: true, metadataName: true, metadataItemId: true, requestCount: true },
        take: 1000,
      })).filter(isPlayingConnection)
      const titles = new Set(all.filter(isNamed).map((r) => imdbOf(r.metadataItemId) || normalizeTitle(rowName(r))).filter(Boolean))
      out.set(ip, { address: ip, firstSeen: new Date(first.startTime).toISOString(), titles: titles.size, aiostreamsPage: aiostreamsPage() })
    }
  } catch {
    return new Map()
  }
  return out
}

// A claim was just saved for this address: decide it afresh next time.
function forgetAddress(accountId, ip) {
  evidence.delete(`${accountId}|${ip}`)
  baseline.delete(accountId)
}

function _resetForTests() {
  evidence.clear()
  baseline.clear()
}

module.exports = { unknownAddresses, forgetAddress, _resetForTests, NEW_ADDRESS_GRACE_MS }
