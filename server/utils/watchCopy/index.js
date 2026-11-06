// Copy watch history: watched titles and resume points from one of a
// person's sign-ins (or one of its profiles) to another. Nothing is removed,
// nothing goes backwards, and each run can be undone for 7 days.
//
// A person has at most one sign-in per provider - their own and the ones a
// merge gave them (UserProviderCredential, never their own provider type) -
// so a side is named by provider, plus the profile inside it:
//   "stremio"            the Stremio account (one history)
//   "nuvio:2"            Nuvio profile 2
//   "jellyfin"           the Jellyfin / AIOStreams / AIOMetadata sign-in
//   "jellyfin:Sam"       Sam, a household profile on that AIOStreams/AIOMetadata
//
// Library (watchlist) copies only between Stremio and Nuvio: a Jellyfin
// server's favourites are not a watchlist.

const { plan } = require('./plan')
const { ADAPTERS } = require('./adapters')
const locks = require('./locks')

const UNDO_DAYS = 7
const KIND_LABEL = { aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata', jellyfin: 'Jellyfin' }

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

const maskEmail = (email) => {
  const m = /^([^@]{1,})@(.+)$/.exec(String(email || ''))
  if (!m) return null
  const [user, domain] = [m[1], m[2]]
  const dot = domain.lastIndexOf('.')
  const host = dot > 0 ? domain.slice(0, dot) : domain
  return `${user[0]}***@${host[0]}***${dot > 0 ? domain.slice(dot) : ''}`
}

async function personWithSignIns(prisma, accountId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, accountId } })
  if (!user) throw fail('Person not found', 404)
  const credentials = await prisma.userProviderCredential.findMany({ where: { userId } }).catch(() => [])
  const rows = { [user.providerType || 'stremio']: user }
  for (const c of credentials) {
    if (rows[c.providerType]) continue
    rows[c.providerType] = {
      ...user,
      providerType: c.providerType,
      stremioAuthKey: c.stremioAuthKey,
      nuvioRefreshToken: c.nuvioRefreshToken,
      nuvioUserId: c.nuvioUserId,
      nuvioProfileId: 1,
      jellyfinServerUrl: c.jellyfinServerUrl,
      jellyfinServerId: c.jellyfinServerId,
      jellyfinServerKind: c.jellyfinServerKind,
      jellyfinUserId: c.jellyfinUserId,
      jellyfinUserName: c.jellyfinUserName,
      jellyfinToken: c.jellyfinToken,
      __credentialId: c.id,
      __persistNuvioRefreshToken: c.providerType === 'nuvio'
        ? async (encrypted) => { await prisma.userProviderCredential.update({ where: { id: c.id }, data: { nuvioRefreshToken: encrypted } }) }
        : undefined,
    }
  }
  return { user, rows }
}

// Another person's sign-in is "<their id>|<side>"; this person's has no prefix.
function parseSide(side, pageUserId = null) {
  let s = String(side || '')
  let personId = pageUserId
  const bar = s.indexOf('|')
  if (bar >= 0) { personId = s.slice(0, bar); s = s.slice(bar + 1) }
  const at = s.indexOf(':')
  const provider = at < 0 ? s : s.slice(0, at)
  const profile = at < 0 ? null : decodeURIComponent(s.slice(at + 1))
  if (!ADAPTERS[provider]) throw fail('Pick a sign-in')
  return { provider, profile, personId }
}

function makeProvider(deps, row) {
  const p = deps.createProvider(row)
  if (!p) throw fail('That sign-in no longer works - reconnect it first', 409)
  return p
}

/**
 * Their sign-ins and the profiles inside each, for the From / To boxes:
 * [{ side, provider, kind, name, detail, profiles: [{ side, name }] }]
 */
async function sides(prisma, deps, accountId, userId) {
  const { user, rows } = await personWithSignIns(prisma, accountId, userId)
  const out = []
  if (rows.stremio) {
    out.push({ side: 'stremio', provider: 'stremio', kind: 'stremio', name: 'Stremio', detail: rows.stremio === user ? maskEmail(user.email) : null, profiles: [] })
  }
  if (rows.nuvio) {
    let profiles = []
    try {
      const provider = makeProvider(deps, rows.nuvio)
      const [list, avatars] = await Promise.all([provider.getProfiles(), provider.getProfileAvatars?.().catch(() => null)])
      profiles = list
        .map((p) => ({ index: p.profile_index ?? p.profileIndex, name: p.name, color: p.avatar_color_hex || null }))
        .filter((p) => Number.isInteger(p.index))
        .sort((a, b) => a.index - b.index)
        .map((p) => ({ side: `nuvio:${p.index}`, name: p.name || `Profile ${p.index}`, avatar: avatars?.get(p.index)?.url || null, color: p.color }))
    } catch { /* listed without profiles; profile 1 is assumed */ }
    if (!profiles.length) profiles = [{ side: 'nuvio:1', name: 'Profile 1' }]
    out.push({ side: profiles[0].side, provider: 'nuvio', kind: 'nuvio', name: 'Nuvio', detail: rows.nuvio === user ? maskEmail(user.email) : null, profiles })
  }
  if (rows.jellyfin) {
    const row = rows.jellyfin
    const kind = row.jellyfinServerKind || 'jellyfin'
    let household = []
    if (kind === 'aiostreams' || kind === 'aiometadata') {
      const tracked = await require('../jellyfinProfiles').trackedProfiles(prisma, (t, o) => deps.decrypt(t, o), userId).catch(() => [])
      const pictures = new Map((await prisma.jellyfinProfile.findMany({ where: { ownerUserId: userId }, select: { id: true, avatarUrl: true } }).catch(() => [])).map((r) => [r.id, r.avatarUrl]))
      household = tracked.map((p) => ({ side: `jellyfin:${encodeURIComponent(p.name)}`, name: p.name, avatar: pictures.get(p.id) || null }))
    }
    // The sign-in's own user is the person themselves: their picture.
    const own = { side: 'jellyfin', name: row.jellyfinUserName || user.username || 'Their sign-in', isPerson: true }
    out.push({ side: 'jellyfin', provider: 'jellyfin', kind, name: KIND_LABEL[kind] || 'Jellyfin', detail: kind === 'jellyfin' ? 'Home server' : 'Media server', profiles: household.length ? [own, ...household] : [] })
  }
  return out
}

const PROVIDER_NAME = (row) => (row.providerType === 'jellyfin' ? (KIND_LABEL[row.jellyfinServerKind || 'jellyfin'] || 'Jellyfin') : row.providerType === 'nuvio' ? 'Nuvio' : 'Stremio')

/**
 * Everyone else's sign-ins, for the "Other people" part of the picker - read
 * from SlickSync alone (no network): one entry per sign-in, a Nuvio one on
 * the profile that person is.
 */
async function others(prisma, accountId, userId) {
  const people = await prisma.user.findMany({
    where: { accountId, id: { not: userId } },
    select: { id: true, username: true, email: true, avatarUrl: true, useGravatar: true, colorIndex: true, providerType: true, jellyfinServerKind: true, nuvioProfileId: true, stremioAuthKey: true, nuvioRefreshToken: true, jellyfinToken: true },
    orderBy: { username: 'asc' },
  })
  const creds = await prisma.userProviderCredential.findMany({ where: { userId: { in: people.map((p) => p.id) } } }).catch(() => [])
  const out = []
  for (const u of people) {
    const person = { id: u.id, username: u.username, email: u.email || null, avatarUrl: u.avatarUrl || null, useGravatar: u.useGravatar === true, colorIndex: u.colorIndex ?? 0 }
    const rows = [u, ...creds.filter((c) => c.userId === u.id).map((c) => ({ ...c, nuvioProfileId: 1 }))]
    for (const r of rows) {
      const type = r.providerType || 'stremio'
      const signedIn = type === 'stremio' ? !!r.stremioAuthKey : type === 'nuvio' ? !!r.nuvioRefreshToken : !!r.jellyfinToken
      if (!signedIn) continue
      const kind = type === 'jellyfin' ? (r.jellyfinServerKind || 'jellyfin') : type
      const local = type === 'nuvio' ? `nuvio:${r.nuvioProfileId || 1}` : type
      out.push({ side: `${u.id}|${local}`, provider: type, kind, name: PROVIDER_NAME(r), detail: type === 'nuvio' ? `Profile ${r.nuvioProfileId || 1}` : null, profiles: [], person })
    }
  }
  return out
}

/** The person as the page shows them (their picture, as everywhere else). */
async function personOf(prisma, accountId, userId) {
  const { user } = await personWithSignIns(prisma, accountId, userId)
  return { id: user.id, username: user.username, email: user.email || null, avatarUrl: user.avatarUrl || null, useGravatar: user.useGravatar === true, colorIndex: user.colorIndex ?? 0 }
}

async function readSide(prisma, deps, accountId, userId, side) {
  const { provider: kind, profile, personId } = parseSide(side, userId)
  const { rows } = await personWithSignIns(prisma, accountId, personId)
  if (!rows[kind]) throw fail('They have no sign-in there', 404)
  const provider = makeProvider(deps, rows[kind])
  let read
  try {
    read = await ADAPTERS[kind].read(provider, profile, deps)
  } catch (e) {
    // A sign-in that stopped working says which one, in plain words.
    if (e?.code === 'PROVIDER_AUTH_EXPIRED' || e?.status === 401 || /authenticat|unauthori[sz]ed|invalid auth|session does not exist/i.test(e?.message || '')) {
      const who = rows[kind].username || 'Their'
      const label = kind === 'jellyfin' ? (KIND_LABEL[rows[kind].jellyfinServerKind || 'jellyfin'] || 'Jellyfin') : kind === 'nuvio' ? 'Nuvio' : 'Stremio'
      throw fail(`${who}’s ${label} sign-in needs reconnecting - reconnect it from their page, then try again`, 409)
    }
    throw e
  }
  return { kind, profile, provider, read, signInId: rows[kind].id }
}

function options(body = {}, fromKind, toKind) {
  const sinceDays = Number(body.sinceDays)
  return {
    watched: body.watched !== false,
    resume: body.resume !== false,
    library: body.library === true && fromKind !== 'jellyfin' && toKind !== 'jellyfin',
    sinceMs: Number.isFinite(sinceDays) && sinceDays > 0 ? (body.now || Date.now()) - sinceDays * 86400000 : 0,
  }
}

/** Read both sides and say what a copy would do, title by title. */
async function preview(prisma, deps, accountId, userId, body = {}) {
  if (!body.from || !body.to || body.from === body.to) throw fail('Pick two different sign-ins')
  const [from, to] = await Promise.all([
    readSide(prisma, deps, accountId, userId, body.from),
    readSide(prisma, deps, accountId, userId, body.to),
  ])
  const presence = to.kind === 'jellyfin' ? await ADAPTERS.jellyfin.presence(to.provider).catch(() => null) : null
  const toServerKind = to.kind === 'jellyfin' ? (to.provider.serverKind || 'jellyfin') : to.kind
  const opts = options(body, from.kind, to.kind)
  const result = plan(from.read.state, to.read.state, opts, { isPresent: presence?.isPresent || null })
  await fillNames(result.items, deps.fetch)
  return {
    ...result,
    options: { ...opts, libraryAvailable: from.kind !== 'jellyfin' && to.kind !== 'jellyfin' },
    counts: { from: countTitles(from.read.state), to: countTitles(to.read.state) },
    limits: limitsOf(toServerKind),
    _ctx: { from, to, presence },
  }
}

// Resume points carry no title on some providers (Nuvio): Cinemeta names them.
const nameCache = new Map()
async function fillNames(items, fetchImpl = fetch) {
  const missing = items.filter((i) => !i.name && /^tt\d+$/.test(i.id || '')).slice(0, 200)
  await require('../mapLimit').mapLimit(missing, 6, async (i) => {
    const key = `${i.type}:${i.id}`
    if (!nameCache.has(key)) {
      let name = null
      try {
        const res = await fetchImpl(`https://v3-cinemeta.strem.io/meta/${i.type === 'movie' ? 'movie' : 'series'}/${i.id}.json`, { signal: AbortSignal.timeout(8000) })
        if (res.ok) name = (await res.json())?.meta?.name || null
      } catch {}
      if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value)
      nameCache.set(key, name)
    }
    i.name = nameCache.get(key) || null
  })
}

const countTitles = (state) => [...state.values()].filter((t) => t.id).length

// What the destination cannot keep, said once.
function limitsOf(kind) {
  if (kind === 'stremio') return ['Stremio keeps one resume point per show - the newest episode wins', 'Stremio keeps one date per show, not one per episode']
  if (kind === 'jellyfin') return ['Only titles the server has can be marked']
  if (kind === 'aiometadata') return ['AIOMetadata shows today as the watch date']
  return []
}

// Running copies, one per person; the page polls status().
const jobs = new Map()

/**
 * Copy the chosen titles (keys from the preview; all that copy when none are
 * given). `matches` maps a "need a match" title's key to the id picked for it.
 */
async function run(prisma, deps, accountId, userId, body = {}) {
  if (jobs.get(userId)?.state === 'running') throw fail('Already copying for them - wait for it to finish', 429)
  // Held from here, before anything is awaited, so a double-tap can't start
  // a second copy while the first is still reading.
  const previous = jobs.get(userId)
  const job = { state: 'running', total: 0, done: 0, failed: 0, from: body.from, to: body.to, runId: null, error: null, startedAt: new Date(deps.now || Date.now()).toISOString() }
  jobs.set(userId, job)
  let lockKey = null
  const giveUp = (e) => {
    if (previous) jobs.set(userId, previous); else jobs.delete(userId)
    if (lockKey) locks.release(lockKey)
    throw e
  }
  try {
    const dest = parseSide(body.to, userId)
    const key = locks.keyOf(accountId, dest.personId, dest.provider)
    if (!locks.take(key, 'copy')) throw fail('Keep in step is updating that sign-in right now - try again in a minute', 429)
    lockKey = key
  } catch (e) { giveUp(e) }
  const pv = await preview(prisma, deps, accountId, userId, body).catch(giveUp)
  const { from, to, presence } = pv._ctx
  const wanted = Array.isArray(body.keys) ? new Set(body.keys.map(String)) : null
  const items = pv.items.filter((i) => i.outcome === 'copy' && (!wanted || wanted.has(i.key)))
  // Titles matched by hand: copied under the picked id.
  for (const [key, id] of Object.entries(body.matches || {})) {
    const src = from.read.state.get(key)
    if (!src || src.id || !/^(tt\d+|tmdb:\d+|tvdb:\d+|kitsu:\d+)$/.test(String(id))) continue
    const fixed = { ...src, id: String(id) }
    const { planTitle } = require('./plan')
    const p = planTitle(fixed, to.read.state.get(fixed.id) || null, pv.options)
    if (p.outcome === 'copy') items.push({ key, id: fixed.id, type: fixed.type, name: fixed.name, poster: fixed.poster, changes: p.changes })
  }
  if (!items.length) giveUp(fail('Nothing to copy'))

  job.total = items.length
  const work = (async () => {
    const result = await ADAPTERS[to.kind].write(to.provider, to.read, items, { ...deps, index: presence?.index || null })
    require('../ownWrites').note(to.signInId, result.own)
    job.done = result.written
    job.failed = result.failed.length
    const data = {
      accountId, userId, fromSide: body.from, toSide: body.to,
      summary: JSON.stringify({ copied: result.written, failed: result.failed.length, fromName: body.fromName || null, toName: body.toName || null }),
      undo: JSON.stringify(result.undo),
    }
    // The titles are already written: one more try before saying the undo
    // couldn't be kept, rather than failing the copy that did happen.
    const row = await prisma.watchCopyRun.create({ data }).catch(() => prisma.watchCopyRun.create({ data })).catch(() => null)
    job.runId = row?.id || null
    job.state = 'done'
    if (!row) job.error = 'Copied, but the undo for it could not be saved'
    require('./offer').forget(userId)
  })().catch((e) => {
    job.state = 'failed'
    job.error = e?.message || 'Something went wrong'
  }).finally(() => locks.release(lockKey))
  if (deps.wait) await work
  return job
}

function status(userId) {
  return jobs.get(userId) || null
}

/** Their newest copy that can still be undone, for the banner. */
async function lastRun(prisma, accountId, userId, now = Date.now()) {
  const since = new Date(now - UNDO_DAYS * 86400000)
  const row = await prisma.watchCopyRun.findFirst({ where: { accountId, userId, state: 'done', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } })
  if (!row) return null
  let summary = {}
  try { summary = JSON.parse(row.summary) } catch {}
  return { id: row.id, from: row.fromSide, to: row.toSide, createdAt: row.createdAt, undoUntil: new Date(new Date(row.createdAt).getTime() + UNDO_DAYS * 86400000), ...summary }
}

async function undo(prisma, deps, accountId, userId, runId, now = Date.now()) {
  const row = await prisma.watchCopyRun.findFirst({ where: { id: String(runId), accountId, userId } })
  if (!row || row.state !== 'done') throw fail('Nothing to undo', 404)
  if (now - new Date(row.createdAt).getTime() > UNDO_DAYS * 86400000) throw fail('That copy is more than 7 days old and can no longer be undone', 410)
  const record = JSON.parse(row.undo)
  const { provider: kind, personId } = parseSide(row.toSide, userId)
  const { rows } = await personWithSignIns(prisma, accountId, personId)
  if (!rows[kind]) throw fail('They no longer have that sign-in', 409)
  const result = await ADAPTERS[record.kind].undo(makeProvider(deps, rows[kind]), record, deps)
  if (result?.failed) {
    // Not undone: keep the run and only what is left, so Undo can be tried again.
    await prisma.watchCopyRun.update({ where: { id: row.id }, data: { undo: JSON.stringify({ ...record, ...result.remaining }) } })
    throw fail(`${result.failed} title${result.failed === 1 ? '' : 's'} couldn’t be undone - try Undo again`, 502)
  }
  await prisma.watchCopyRun.update({ where: { id: row.id }, data: { state: 'undone' } })
  return { restored: result.restored, kept: result.kept }
}

// "Pick the match": titles Cinemeta knows by that name.
async function candidates(name, type, fetchImpl = fetch) {
  const q = String(name || '').trim()
  if (!q) return []
  const kind = type === 'movie' ? 'movie' : 'series'
  try {
    const res = await fetchImpl(`https://v3-cinemeta.strem.io/catalog/${kind}/top/search=${encodeURIComponent(q)}.json`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const metas = (await res.json())?.metas
    return (Array.isArray(metas) ? metas : []).slice(0, 5).map((m) => ({ id: m.id, name: m.name, year: m.releaseInfo || null, poster: m.poster || null }))
  } catch {
    return []
  }
}

function forgetForTests() {
  jobs.clear()
}

module.exports = { sides, others, personOf, readSide, preview, run, status, lastRun, undo, candidates, parseSide, maskEmail, forgetForTests, UNDO_DAYS }
