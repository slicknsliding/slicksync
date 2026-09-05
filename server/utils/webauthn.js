/**
 * Passkeys (WebAuthn) - shared pieces between registering one and signing in
 * with one.
 *
 * The whole feature is an ADDITION to password login and never a
 * replacement. There is no setting that turns the password off, because a
 * self-hosted instance has no support desk: a browser profile wiped, a phone
 * lost, or a passkey created on the wrong hostname would otherwise mean
 * nobody can get in at all. What passkeys buy here is a login that cannot be
 * phished and does not involve typing a shared household password on a TV
 * remote.
 *
 * @simplewebauthn/server does the actual verification. It is ESM-only, so it
 * is loaded through a dynamic import rather than require() - and lazily, so
 * an instance that never touches passkeys never pays for loading it.
 *
 * RP ID and origin are derived from the REQUEST rather than configured. A
 * self-hosted instance can be reached on a LAN address, a Tailscale name and
 * a public domain, and a passkey is bound to whichever one it was created
 * on. Deriving them means each of those just works on its own terms; the
 * cost is that a passkey made on one hostname will not offer itself on
 * another, which the UI says plainly rather than leaving as a mystery.
 */

const crypto = require('crypto')

let libPromise = null
function getLib() {
  if (!libPromise) libPromise = import('@simplewebauthn/server')
  return libPromise
}

// Challenges live for one exchange and are consumed on use. In memory on
// purpose: they are worthless after 5 minutes, and writing them to the
// database would mean a table of dead rows to prune for no gain.
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const challenges = new Map()

function putChallenge(key, value) {
  challenges.set(key, { value, at: Date.now() })
  // Opportunistic sweep - this map only ever holds seconds' worth of logins.
  if (challenges.size > 200) {
    for (const [k, v] of challenges) {
      if (Date.now() - v.at > CHALLENGE_TTL_MS) challenges.delete(k)
    }
  }
}

function takeChallenge(key) {
  const hit = challenges.get(key)
  challenges.delete(key)
  if (!hit) return null
  if (Date.now() - hit.at > CHALLENGE_TTL_MS) return null
  return hit.value
}

function newChallengeId() {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Works out which domain this request is for.
 *
 * The Origin header is what the browser will actually put in the signed
 * client data, so it is the authority here - the Host header is only a
 * fallback for clients that omit Origin. Anything that is not a real URL is
 * rejected rather than guessed at, since a wrong RP ID silently produces
 * passkeys that can never be used again.
 */
function rpFromRequest(req) {
  const origin = req.get('origin') || (req.get('host') ? `${req.protocol}://${req.get('host')}` : '')
  if (!origin) return null
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  if (!parsed.hostname) return null
  return { rpID: parsed.hostname, origin: parsed.origin }
}

const RP_NAME = 'SlickSync'

module.exports = {
  getLib,
  putChallenge,
  takeChallenge,
  newChallengeId,
  rpFromRequest,
  RP_NAME,
  CHALLENGE_TTL_MS,
}
