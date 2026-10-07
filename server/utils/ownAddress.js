// SlickSync learning its own address - the one phones and TVs reach it at -
// from an admin's own visits, so SlickTrax, pictures on a server and the
// stream gate (utils/streamGate.js) work without anything typed into
// Settings. It used to learn it only when someone switched SlickTrax on.
//
// Kept as the account's observedBaseUrl, which every one of them already
// reads after PUBLIC_APP_URL and the Settings address (both still win). Only
// an address a device could reach is learned (streamGate.deviceReachable): a
// container's own name, localhost or the server talking to itself never
// replace it. The first such address stays - one reached from a second
// address later (a LAN IP beside the domain, say) doesn't flip it back and
// forth - except that it does replace an internal one learned before.
//
// Only from requests that already passed the admin sign-in (after the auth
// gate) - never from unauthenticated traffic, where a made-up Host header
// could set it.

const learned = new Map() // accountId -> the base last confirmed, to skip the read on every request

function requestBase(req) {
  const host = req.get('host')
  return host ? `${req.protocol}://${host}`.replace(/\/+$/, '') : ''
}

async function learn(prisma, accountId, base) {
  const { deviceReachable } = require('./streamGate')
  const { readSync } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  if (typeof cfg.publicBaseUrl === 'string' && cfg.publicBaseUrl.trim()) return
  const current = typeof cfg.observedBaseUrl === 'string' ? cfg.observedBaseUrl.trim().replace(/\/+$/, '') : ''
  if (current === base || (current && deviceReachable(current))) return
  await require('./accountSync').setAccountSyncKeys(prisma, accountId, { observedBaseUrl: base })
  console.log(`[OwnAddress] learned the address devices reach this instance at: ${new URL(base).host}`)
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

module.exports = { learnOwnAddress, learn, requestBase }
