// SlickSync's stream gate: pauses and age limits that take hold at once.
//
// Stremio and Nuvio apps only read their addon list when they start. A pause
// used to take the stream addons off the account, so it only took hold - and
// only ended - once the app was restarted, and an app left open could write
// its paused copy back afterwards.
//
// Instead, anyone with a pause set up (a daily limit that pauses, or a
// bedtime) or an age limit has their stream addons installed through an
// address of their own on SlickSync:
//
//   /trax/gate/<their token>/<addon id>/<hash>/   a group addon
//   /trax/gate/<their token>/w-<wrap id>/<hash>/  any other addon (a "wrap")
//
// Every request there is sent straight on to the real addon - except a
// request for streams while they're paused, or for a title rated above their
// age limit, which gets an empty list. The addon list never changes, so a
// pause starts and ends the moment they next open a title. Video never comes
// through here, only the addons' answers - and those by a redirect, so
// SlickSync doesn't even carry them. Wraps cover what SlickSync doesn't sync:
// a merged Nuvio profile's own stream addons, and the stream source of
// someone on AIOMetadata with an age limit.
//
// The hash segment is the real address's fingerprint: when the addon's
// address changes, theirs does too, because Nuvio keeps an addon's manifest
// for as long as its address stays the same.

const crypto = require('crypto')

const GATE_PATH = '/trax/gate/'

/** Whether a limit can pause someone: a pausing daily limit, or a bedtime. */
function wantsGate(limit) {
  return !!limit && (limit.onReach === 'pause' || !!limit.bedtime)
}

/** The address devices reach this instance at ('' when there is none) - the one SlickTrax and pictures use. */
function publicBase(prisma, accountId) {
  return require('./serverAvatars').publicBase(prisma, accountId)
}

function gateUrl(gate, addonId, transportUrl) {
  const hash = crypto.createHash('sha256').update(String(transportUrl || '')).digest('hex').slice(0, 10)
  return `${gate.base}${GATE_PATH}${gate.token}/${addonId}/${hash}/manifest.json`
}

/** { token, addonId } from a gate address, or null for any other. */
function parseGateUrl(url) {
  const m = /\/trax\/gate\/([a-f0-9]{16,})\/([^/?#]+)\/[a-f0-9]+\/manifest\.json(?:[?#].*)?$/i.exec(String(url || ''))
  return m ? { token: m[1], addonId: m[2] } : null
}

// ---------------------------------------------------------------------------
// Can devices reach it?
//
// The instance's public address must answer /trax/gate/ping with SlickSync's
// own reply - not a login page, not nothing. Asked of that address from here,
// so a wrong address or a login gate in front of /trax/ is caught before
// anyone's addons point at it. Kept with the account's settings: looked at
// again after six hours when it worked, half an hour when it didn't - and a
// gate that worked is only given up after two failures in a row, so a passing
// hiccup (an update, a restart) never moves everyone's addons back and forth.

const CHECK_KEY = 'streamGateCheck'
const CHECK_OK_MS = 6 * 60 * 60 * 1000
const CHECK_FAIL_MS = 30 * 60 * 1000
const PING_REPLY = { slicksync: 'gate' }

async function ping(base, fetchImpl) {
  try {
    const r = await fetchImpl(`${base}${GATE_PATH}ping`, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    if (r.status >= 300 && r.status < 400) return { ok: false, reason: 'login' }
    const body = await r.json().catch(() => null)
    if (body?.slicksync === PING_REPLY.slicksync) return { ok: true }
    return { ok: false, reason: r.ok ? 'not-slicksync' : `answered ${r.status}` }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/**
 * Whether a phone or TV could ever reach this address. Asking it from here
 * proves nothing for a name only this server's own network knows - a
 * container's name, localhost - which answers here and nowhere else (seen
 * live: betatest's own container name passed the check and went onto a real
 * account's addon, out of reach of its phone). A home network's own address
 * (192.168.x.x, a .local name) is left alone: its devices can reach it.
 */
function deviceReachable(base) {
  let host
  try { host = new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return false }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return false
  if (/^127\./.test(host)) return false
  if (host.endsWith('.internal')) return false
  // A bare name, with no dot: resolves only inside the network it was given in.
  if (!host.includes('.') && !host.includes(':')) return false
  return true
}

async function gateUsable(prisma, accountId, { now = Date.now(), fetchImpl = fetch } = {}) {
  const base = await publicBase(prisma, accountId)
  if (!base) return { ok: false, reason: 'no-address' }
  if (!deviceReachable(base)) return { ok: false, reason: 'internal-address', base }
  const { readSync, patchEntry } = require('./screenTime')
  const last = (await readSync(prisma, accountId)).cfg[CHECK_KEY]?.state
  if (last && last.base === base && Number(last.next) > now) return last
  const reached = await ping(base, fetchImpl)
  const fails = reached.ok ? 0 : (last?.base === base ? Number(last.fails) || 0 : 0) + 1
  const ok = reached.ok || (last?.base === base && last.ok === true && fails < 2)
  const next = {
    base, ok, fails, at: now,
    next: now + (reached.ok ? CHECK_OK_MS : CHECK_FAIL_MS),
    ...(reached.ok ? {} : { reason: reached.reason }),
  }
  await patchEntry(prisma, accountId, CHECK_KEY, 'state', next).catch(() => {})
  return next
}

/** Whether someone's stream addons belong behind the gate: a pause set up, a pause in force, or an age limit. */
function wantsGateFor(cfg, id) {
  const { cleanLimit, pauseInForce } = require('./screenTime')
  const { cleanAgeLimit } = require('./ageLimits')
  return wantsGate(cleanLimit(cfg?.screenTime?.[id])) || pauseInForce(cfg?.screenTimePauses?.[id]) || !!cleanAgeLimit(cfg?.ageLimits?.[id])
}

/** Someone's gate token - the one their SlickTrax addon uses - made if they have none. */
async function tokenOf(prisma, userId, known) {
  let token = known
  if (token === undefined) token = (await prisma.user.findUnique({ where: { id: userId }, select: { traxToken: true } }))?.traxToken
  if (token) return token
  token = crypto.randomBytes(24).toString('hex')
  await prisma.user.update({ where: { id: userId }, data: { traxToken: token } })
  return token
}

/**
 * For a sync: { base, token } when this person's stream addons go through
 * the gate, or null to install them as they are - including whenever devices
 * can't reach the gate.
 */
async function gateFor(prisma, accountId, user) {
  if (!user?.id) return null
  let { providerType, traxToken } = user
  if (providerType === undefined || traxToken === undefined) {
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { providerType: true, traxToken: true } })
    if (!row) return null
    providerType = row.providerType
    traxToken = row.traxToken
  }
  if (providerType === 'jellyfin') return null
  const { readSync } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  if (!wantsGateFor(cfg, user.id)) return null
  const usable = await gateUsable(prisma, accountId)
  if (!usable.ok) return null
  return { base: usable.base, token: await tokenOf(prisma, user.id, traxToken) }
}

// ---------------------------------------------------------------------------
// Wraps: an addon SlickSync doesn't manage, behind the gate (StreamGateWrap)

const urlHash = (url) => crypto.createHash('sha256').update(String(url || '')).digest('hex')

/**
 * The wrap for this addon address and whose limits apply to it, made if there
 * is none. Kept after the limits go: an app still holding the gate's address
 * keeps playing through it until it reads its list again.
 */
async function wrapFor(prisma, accountId, { userId, subjectId, realUrl }) {
  const hash = urlHash(realUrl)
  const found = await prisma.streamGateWrap.findFirst({ where: { userId, subjectId, urlHash: hash } })
  if (found) return found
  const { encrypt } = require('./encryption')
  return prisma.streamGateWrap.create({ data: { accountId, userId, subjectId, urlHash: hash, realUrl: encrypt(realUrl, { appAccountId: accountId }) } })
}

/** The address a wrap stands for, or null. */
function wrapAddress(wrap, decrypt) {
  try { return (decrypt || require('./encryption').decrypt)(wrap.realUrl, { appAccountId: wrap.accountId }) || null } catch { return null }
}

/**
 * A merged Nuvio profile's stream addons through the gate (want), or back to
 * their own addresses. The rest of its list stays as it is - only the address
 * of each addon that plays streams changes. Also notes the profile's name,
 * and whether it uses the main profile's addons (then it has no list of its
 * own, so nothing can be held to there).
 */
async function wrapProfile(prisma, accountId, person, want, { decrypt } = {}) {
  const { ownerId, index } = person.subject
  const owner = await prisma.user.findFirst({ where: { id: ownerId, accountId } })
  if (!owner) throw new Error('The person this profile belongs to is gone')
  const dec = decrypt || require('./encryption').decrypt
  const { encrypt } = require('./encryption')
  const provider = require('../providers').makeCreateProvider({ prisma, encrypt, getAccountId: () => accountId })(
    { ...owner, nuvioProfileId: index },
    { decrypt: dec, req: { appAccountId: accountId } },
  )
  if (!provider?.getAddons) throw new Error('Their Nuvio sign-in can’t be used')
  const { patchEntry, servesStreams } = require('./screenTime')
  const profiles = await provider.getProfiles().catch(() => null)
  const profile = (profiles || []).find((p) => Number(p.profile_index ?? p.profileIndex) === index)
  if (profiles && !profile) throw new Error('That profile is no longer on this Nuvio account')
  if (profile) {
    await patchEntry(prisma, accountId, 'screenTimeProfiles', person.id, { name: profile.name || null, sharesPrimary: profile.uses_primary_addons === true, at: new Date().toISOString() })
    if (profile.uses_primary_addons === true && want) throw new Error('That profile uses the main profile’s addons')
  }

  let gate = null
  if (want) {
    const usable = await gateUsable(prisma, accountId)
    if (!usable.ok) throw new Error('Devices can’t reach this instance’s gate')
    gate = { base: usable.base, token: await tokenOf(prisma, owner.id, owner.traxToken) }
  }
  const { fetchManifest } = require('./nuvioHomeLayout')
  const { addons } = await provider.getAddons()
  const next = []
  let changed = false
  for (const a of Array.isArray(addons) ? addons : []) {
    const url = a?.transportUrl || a?.manifestUrl || a?.url || ''
    const gated = parseGateUrl(url)
    if (want) {
      if (!url || gated) { next.push(a); continue }
      const manifest = await fetchManifest(url).catch(() => null)
      if (!servesStreams({ manifest })) { next.push(a); continue }
      const wrap = await wrapFor(prisma, accountId, { userId: owner.id, subjectId: person.id, realUrl: url })
      next.push({ ...a, transportUrl: gateUrl(gate, `w-${wrap.id}`, url) })
      changed = true
    } else {
      const wrap = gated?.addonId.startsWith('w-')
        ? await prisma.streamGateWrap.findFirst({ where: { id: gated.addonId.slice(2), subjectId: person.id } })
        : null
      const real = wrap ? wrapAddress(wrap, dec) : null
      if (real) { next.push({ ...a, transportUrl: real }); changed = true } else next.push(a)
    }
  }
  if (changed) await provider.setAddons(next)
  return { changed }
}

/**
 * Someone on AIOMetadata with an age limit: their stream source through the
 * gate (want), or back. AIOMetadata asks one stream addon per user - the
 * configuration's own for its main user, a household user's own when they
 * have one - so that address is wrapped, the way a pause points it away
 * (aiomPause.js): pointing the main user's changes it for every household
 * user without their own, so each of those first keeps a copy of the old one.
 * What was there is kept (cfg.aiomGate) and only what still holds the gate's
 * address is put back. A pause on top keeps working: it points away from the
 * gate and back to it.
 */
async function gateAiom(prisma, accountId, person, want, { decrypt } = {}) {
  const aiom = require('./aiomPause')
  const { configOf, userIdFor, readConfig, writeConfig } = require('./aiometadataHousehold')
  const { readSync, patchEntry } = require('./screenTime')
  const found = await aiom.pauseAccess(prisma, accountId, person)
  if (!found) throw new Error('An age limit on AIOMetadata needs the configuration password - reconnect them with it')
  const { owner } = found
  const dec = decrypt || require('./encryption').decrypt
  const where = configOf(owner.jellyfinServerUrl)
  const access = { ...where, password: dec(owner.aioConfigPassword, { appAccountId: owner.accountId || accountId }) }
  const config = await readConfig(access)
  const uuid = owner.aioConfigId || where.uuid
  const users = Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []
  const idOf = (u) => userIdFor(uuid, u.id)
  const ours = (url) => !!parseGateUrl(url)
  const paused = await aiom.pausedAddress(prisma, accountId)

  if (want) {
    const usable = await gateUsable(prisma, accountId)
    if (!usable.ok) throw new Error('Devices can’t reach this instance’s gate')
    const gate = { base: usable.base, token: await tokenOf(prisma, owner.id, owner.traxToken) }
    const wrapped = async (real) => gateUrl(gate, `w-${(await wrapFor(prisma, accountId, { userId: owner.id, subjectId: person.id, realUrl: real })).id}`, real)
    const state = { users: [], main: null }
    const main = typeof config.jellyfinStreamUrl === 'string' ? config.jellyfinStreamUrl : ''
    const targets = users.filter((u) => u && typeof u.id === 'string' && found.users.includes(idOf(u)))
    for (const u of targets) {
      const own = typeof u.streamUrl === 'string' && u.streamUrl.trim() ? u.streamUrl : null
      const real = own || main
      if (!real || ours(real) || real === paused) continue
      state.users.push({ id: u.id, was: own })
      u.streamUrl = await wrapped(real)
    }
    if (found.users.includes(String(uuid || '').replace(/-/g, '').toLowerCase()) && main && !ours(main) && main !== paused) {
      const pinned = []
      for (const u of users) {
        if (!u || typeof u.id !== 'string' || targets.includes(u)) continue
        if (typeof u.streamUrl === 'string' && u.streamUrl.trim()) continue
        u.streamUrl = main
        pinned.push(u.id)
      }
      state.main = { was: main, pinned }
      config.jellyfinStreamUrl = await wrapped(main)
    }
    if (!state.users.length && !state.main) return { changed: false }
    await writeConfig(access, config)
    await patchEntry(prisma, accountId, 'aiomGate', person.id, state)
    return { changed: true }
  }

  const state = (await readSync(prisma, accountId)).cfg.aiomGate?.[person.id]
  if (!state) return { changed: false }
  // Paused right now: their source points away from the gate and comes back
  // to it when the pause ends - put back after that.
  const isPaused = (state.users || []).some((e) => users.find((x) => x?.id === e.id)?.streamUrl === paused)
    || (state.main && config.jellyfinStreamUrl === paused)
  if (isPaused) throw new Error('Paused just now - the age limit comes off when the pause ends')
  for (const entry of state.users || []) {
    const u = users.find((x) => x && x.id === entry.id)
    if (!u || !ours(u.streamUrl)) continue
    if (entry.was) u.streamUrl = entry.was
    else delete u.streamUrl
  }
  if (state.main) {
    if (ours(config.jellyfinStreamUrl)) config.jellyfinStreamUrl = state.main.was
    for (const id of state.main.pinned || []) {
      const u = users.find((x) => x && x.id === id)
      if (u && u.streamUrl === state.main.was) delete u.streamUrl
    }
  }
  await writeConfig(access, config)
  await patchEntry(prisma, accountId, 'aiomGate', person.id, null)
  return { changed: true }
}

// ---------------------------------------------------------------------------
// Answering at the gate (routes/traxAddon.js)

// What a gate address leads to, for a short while: one lookup per title
// opened would otherwise decrypt the whole group each time.
const RESOLVE_MS = 30 * 1000
const resolved = new Map()

const baseOf = (url) => url.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')

/**
 * Whose limits apply, and the real addon behind a gate address - or null when
 * the token is unknown or the address no longer leads anywhere. For a group
 * addon, whatever their sync would install for it right now (a backup
 * standing in for an offline one included); for a wrap, its own address.
 * { subjectId, accountId, upstreamBase, manifest (null for a wrap), manifestUrl }
 */
async function resolveGate(prisma, token, addonId) {
  if (!token || token.length < 16 || !addonId) return null
  const key = `${token}:${addonId}`
  const hit = resolved.get(key)
  if (hit && Date.now() - hit.at < RESOLVE_MS) return hit.value
  const value = await (async () => {
    const person = await prisma.user.findFirst({ where: { traxToken: token }, select: { id: true, accountId: true } })
    if (!person) return null
    const { getAccountId, getGroupAddons } = require('./helpers')
    const req = { appAccountId: person.accountId }
    const accountId = getAccountId(req)
    if (addonId.startsWith('w-')) {
      const wrap = await prisma.streamGateWrap.findFirst({ where: { id: addonId.slice(2), userId: person.id } })
      const real = wrap ? wrapAddress(wrap) : null
      if (!real || parseGateUrl(real)) return null
      return { subjectId: wrap.subjectId, accountId, upstreamBase: baseOf(real), manifest: null, manifestUrl: real }
    }
    const groups = await prisma.group.findMany({ where: { accountId, userIds: { contains: person.id } }, select: { id: true } })
    if (!groups.length) return null
    const addon = (await getGroupAddons(prisma, groups[0].id, req)).find((a) => a?.id === addonId)
    const real = typeof addon?.transportUrl === 'string' ? addon.transportUrl : ''
    if (!real || parseGateUrl(real)) return null
    const { presentGroupAddon } = require('./sync')
    return { subjectId: person.id, accountId, upstreamBase: baseOf(real), manifest: presentGroupAddon(addon).manifest, manifestUrl: real }
  })()
  resolved.set(key, { value, at: Date.now() })
  if (resolved.size > 2000) resolved.delete(resolved.keys().next().value)
  return value
}

/** What the gate answers a stream request with right now: 'pass', 'paused', or 'age' (rated above their limit). */
async function streamVerdict(prisma, found, resourcePath, deps = {}) {
  const { readSync, pauseInForce } = require('./screenTime')
  const { cfg } = await readSync(prisma, found.accountId)
  if (pauseInForce(cfg.screenTimePauses?.[found.subjectId])) return 'paused'
  const { cleanAgeLimit, mayPlay } = require('./ageLimits')
  const age = cleanAgeLimit(cfg.ageLimits?.[found.subjectId])
  if (age && !(await mayPlay(prisma, found.accountId, age, resourcePath, deps))) return 'age'
  return 'pass'
}

module.exports = {
  GATE_PATH, PING_REPLY, wantsGate, wantsGateFor, publicBase, gateUrl, parseGateUrl, gateFor, gateUsable, deviceReachable,
  wrapProfile, gateAiom, wrapFor, resolveGate, streamVerdict,
  forgetResolvedForTests: () => resolved.clear(),
}
