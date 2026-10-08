// SlickSync's own address - the one phones and TVs reach it at - learned from
// an admin's own visits, so SlickTrax, pictures on a server, Vault proxies and
// the stream gate (utils/streamGate.js) work with nothing typed in. The site
// an admin opens it from is the address their devices use.
//
// Learned into the account's observedBaseUrl, from requests that already
// passed the admin sign-in (after the auth gate) - never unauthenticated
// traffic, where a made-up Host header could set it. Only an address a
// device could reach is learned (streamGate.deviceReachable): a container's
// own name or localhost never is. A named address (slicksync.example.com) is
// preferred to a bare network number, and the named one an admin last
// opened it from wins - so moving to a new domain is picked up on the first
// visit there, while opening it at home by its network address doesn't swap
// the address out for one that only works at home.
//
// PUBLIC_APP_URL (Docker) still wins over everything, for a setup only ever
// opened through some other address. An address typed into Settings before
// it learned by itself (publicBaseUrl) is used until it has learned one.

const learned = new Map() // accountId -> the base last confirmed, to skip the read on every request

function requestBase(req) {
  const host = req.get('host')
  return host ? `${req.protocol}://${host}`.replace(/\/+$/, '') : ''
}

const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '')

/** A bare network number (192.168.1.20, ::1) rather than a name. */
function isNumeric(base) {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, '')
    return /^[\d.]+$/.test(host) || host.includes(':')
  } catch { return false }
}

/**
 * The address devices reach this instance at, '' when none is known:
 * PUBLIC_APP_URL, then the learned one when a device could reach it, then one
 * typed into Settings before learning existed, then whatever was learned.
 */
async function publicBase(prisma, accountId) {
  const env = clean(process.env.PUBLIC_APP_URL)
  if (env) return env
  const { readSync } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId || 'default')
  const observed = clean(cfg.observedBaseUrl)
  const typed = clean(cfg.publicBaseUrl)
  const { deviceReachable } = require('./streamGate')
  if (observed && deviceReachable(observed)) return observed
  return typed || observed
}

/** Whether a newly seen address should replace the one learned before. */
function replaces(base, current) {
  const { deviceReachable } = require('./streamGate')
  if (!deviceReachable(base) || base === current) return false
  if (!current || !deviceReachable(current)) return true
  // A named address: the one last opened from wins. A network number never
  // replaces what's known.
  return !isNumeric(base)
}

async function learn(prisma, accountId, base) {
  const { readSync } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  if (!replaces(base, clean(cfg.observedBaseUrl))) return false
  await require('./accountSync').setAccountSyncKeys(prisma, accountId, { observedBaseUrl: base })
  console.log(`[OwnAddress] learned the address devices reach this instance at: ${new URL(base).host}`)
  return true
}

/** Express middleware, after the auth gate, on /api. */
function learnOwnAddress(prisma) {
  return (req, res, next) => {
    next()
    try {
      const accountId = req.appAccountId
      if (!accountId || process.env.PUBLIC_APP_URL) return
      // A person's own pages and sign-in aren't the admin.
      if (/^\/(public-library|public-auth|auth|invite)/.test(req.path)) return
      const base = requestBase(req)
      if (!base || learned.get(accountId) === base) return
      if (!require('./streamGate').deviceReachable(base)) return
      learned.set(accountId, base)
      learn(prisma, accountId, base).catch((e) => {
        learned.delete(accountId)
        console.warn('[OwnAddress] could not keep the address:', e?.message)
      })
    } catch { /* never in the request's way */ }
  }
}

module.exports = { learnOwnAddress, learn, publicBase, requestBase, replaces, isNumeric }
