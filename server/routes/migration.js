const express = require('express')
const crypto = require('crypto')

// One-code instance migration.
//
// Old instance: "Generate migration code" mints a one-time token and a
// random kit passphrase, and hands back ONE code encoding
// {url, token, passphrase}. New instance: paste the code into "Receive
// migration" and it pulls the full Disaster Recovery Kit - users, groups,
// addons, settings, every Vault secret - straight over an encrypted
// handshake and restores it. The DR Kit was always the manual version of
// this (export file, carry it over, import, retype a passphrase); the code
// collapses that into a minute.
//
// Security model, stated plainly:
//  - /bundle is the only unauthenticated route (allowlisted like
//    federation's catalog route - the caller is another server with no
//    session). The token authorizes exactly one read, expires in 15
//    minutes, and dies with the process (in-memory by design: an offer is
//    made and consumed in the same sitting, and a restart voiding pending
//    offers is a feature, not a bug).
//  - The kit itself is passphrase-encrypted with a key that exists only
//    inside the code. Whoever holds the code holds the household - which is
//    exactly as true of the manual DR-kit file plus its passphrase. Treat
//    the code like the password it is; it is single-use either way.

const OFFER_TTL_MS = 15 * 60 * 1000
const offers = new Map() // token -> { accountId, passphrase, expiresAt }

function mintOffer(accountId) {
  const token = crypto.randomBytes(24).toString('hex')
  const passphrase = crypto.randomBytes(24).toString('base64url')
  offers.set(token, { accountId, passphrase, expiresAt: Date.now() + OFFER_TTL_MS })
  return { token, passphrase }
}

function consumeOffer(token) {
  const offer = offers.get(token)
  if (!offer) return null
  offers.delete(token) // single-use, even on later failure - re-offer instead
  if (Date.now() > offer.expiresAt) return null
  return offer
}

function encodeCode(url, token, passphrase) {
  return 'slickmig1.' + Buffer.from(JSON.stringify({ u: url, t: token, k: passphrase }), 'utf8').toString('base64url')
}

function decodeCode(code) {
  try {
    const raw = String(code || '').trim()
    if (!raw.startsWith('slickmig1.')) return null
    const parsed = JSON.parse(Buffer.from(raw.slice('slickmig1.'.length), 'base64url').toString('utf8'))
    if (typeof parsed?.u !== 'string' || typeof parsed?.t !== 'string' || typeof parsed?.k !== 'string') return null
    if (!/^https?:\/\//i.test(parsed.u)) return null
    return parsed
  } catch { return null }
}

module.exports = ({ prisma, decrypt }) => {
  const router = express.Router()

  // GET /bundle?token= - the one-time kit read. Public path, token-gated.
  router.get('/bundle', async (req, res) => {
    try {
      const offer = consumeOffer(String(req.query.token || ''))
      if (!offer) return res.status(404).json({ error: 'No such offer - codes are single-use and expire after 15 minutes. Generate a fresh one.' })
      const { buildKit } = require('../utils/disasterRecoveryKit')
      const kit = await buildKit(prisma, offer.accountId, offer.passphrase, { appAccountId: offer.accountId }, { decrypt })
      res.json({ kit })
    } catch (e) {
      console.error('[Migration] bundle failed:', e?.message)
      res.status(500).json({ error: 'Failed to build the migration bundle' })
    }
  })

  return router
}

module.exports.mintOffer = mintOffer
module.exports.encodeCode = encodeCode
module.exports.decodeCode = decodeCode
module.exports.consumeOffer = consumeOffer
