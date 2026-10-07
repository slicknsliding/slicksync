// Instant pause for Stremio and Nuvio.
//
// A pause used to take the group's stream addons off the person's account and
// put them back after. Their apps only read the addon list when they start, so
// a pause took hold - and ended - only after the app was restarted, and an app
// left open could write its paused copy back afterwards.
//
// Instead, anyone with a pause set up (a daily limit that pauses, or a
// bedtime) has their group's stream addons installed through an address of
// their own on SlickSync: /trax/gate/<their token>/<addon id>/<hash>/. Every
// request there is sent straight on to the real addon - except, while they
// are paused, a request for streams, which gets an empty list. The addon list
// never changes, so a pause starts and ends the moment they next open a title.
// Video never comes through here, only the addon's answers - and those by a
// redirect, so SlickSync doesn't even carry them.
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

/**
 * The address devices reach this instance at, for addons it serves itself:
 * the PUBLIC_APP_URL env var, then the one typed into Settings, then the one
 * an admin's own session revealed. '' when there is none.
 */
async function publicBase(prisma, accountId) {
  let base = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  if (base) return base
  const acct = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acct?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  base = (cfg && typeof cfg.publicBaseUrl === 'string' ? cfg.publicBaseUrl : '').trim().replace(/\/+$/, '')
  if (!base) base = (cfg && typeof cfg.observedBaseUrl === 'string' ? cfg.observedBaseUrl : '').trim().replace(/\/+$/, '')
  return base
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

/**
 * For a sync: { base, token } when this person's stream addons go through
 * the gate, or null to install them as they are. Gives them a token if they
 * have none yet (the same one their SlickTrax addon would use).
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
  const { readSync, cleanLimit, pauseInForce } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  if (!wantsGate(cleanLimit(cfg.screenTime?.[user.id])) && !pauseInForce(cfg.screenTimePauses?.[user.id])) return null
  const base = await publicBase(prisma, accountId)
  if (!base) return null
  if (!traxToken) {
    traxToken = crypto.randomBytes(24).toString('hex')
    await prisma.user.update({ where: { id: user.id }, data: { traxToken } })
  }
  return { base, token: traxToken }
}

// What a gate address leads to, for a short while: one lookup per title
// opened would otherwise decrypt the whole group each time.
const RESOLVE_MS = 30 * 1000
const resolved = new Map()

/**
 * The person and real addon behind a gate address, or null when the token
 * is unknown or that addon is no longer in their group. The addon is
 * whatever their sync would install for it right now (a backup standing in
 * for an offline one included).
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
    const groups = await prisma.group.findMany({ where: { accountId, userIds: { contains: person.id } }, select: { id: true } })
    if (!groups.length) return null
    const addon = (await getGroupAddons(prisma, groups[0].id, req)).find((a) => a?.id === addonId)
    const real = typeof addon?.transportUrl === 'string' ? addon.transportUrl : ''
    if (!real || parseGateUrl(real)) return null
    const { presentGroupAddon } = require('./sync')
    return { personId: person.id, accountId, upstreamBase: real.replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''), manifest: presentGroupAddon(addon).manifest }
  })()
  resolved.set(key, { value, at: Date.now() })
  if (resolved.size > 2000) resolved.delete(resolved.keys().next().value)
  return value
}

module.exports = { GATE_PATH, wantsGate, publicBase, gateUrl, parseGateUrl, gateFor, resolveGate, forgetResolvedForTests: () => resolved.clear() }
