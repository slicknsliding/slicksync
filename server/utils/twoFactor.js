// TOTP-based 2FA for AppAccount logins - opt-in, per account. Only
// AppAccount has a real password login (`passwordHash` in public mode,
// env-var comparison for private mode's /private-login) - managed Users
// (Stremio/Nuvio accounts under an AppAccount) have no SlickSync login of
// their own, so 2FA lives entirely on AppAccount.
//
// Pending-challenge design: after password/env-var check succeeds for a
// 2FA-enabled account, the login route must NOT issue real session tokens
// yet. It's tempting to jwt.sign() a short-lived "pending" token with the
// same JWT_SECRET the real access/refresh tokens use - DON'T: middleware/
// auth.js's authGate accepts ANY valid JWT signed with JWT_SECRET that
// carries an accId claim as a full session (it never checks a `typ` claim,
// confirmed by reading it directly), so a pending-2FA token in that shape
// would BE a full session bypass, not a checkpoint. Instead this uses an
// opaque random token in an in-memory Map (same pattern as encryption.js's
// accountDekStore) that authGate's jwt.verify() will simply fail to parse -
// it can never be replayed as a session token, by construction rather than
// by convention.
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { authenticator } = require('otplib')
const QRCode = require('qrcode')

const pendingStore = new Map() // pendingToken -> { accountId, expiresAt }
const PENDING_TTL_MS = 5 * 60 * 1000 // 5m - just long enough to type a 6-digit code

// Same account-derived-key AES-GCM pattern settings.js's account-api-key
// routes already use for AppAccount.apiKeyHash (accountKey = sha256(accountId
// + serverKey)) - not the req-based encrypt()/decrypt() from encryption.js,
// because the login-time verification path (where a 2FA secret must be
// decrypted to check a submitted code) runs BEFORE req.appAccountId exists;
// this derivation only ever needs an accountId, which is available in both
// contexts (req.appAccountId during Settings management, the already-
// resolved account.id during login).
function accountKeyFor(accountId) {
  const { getServerKey } = require('./encryption')
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from(accountId || ''), getServerKey()])).digest()
}

function encryptSecret(accountId, plaintext) {
  const { aesGcmEncrypt } = require('./encryption')
  return aesGcmEncrypt(accountKeyFor(accountId), plaintext)
}

function decryptSecret(accountId, encrypted) {
  const { aesGcmDecrypt } = require('./encryption')
  return aesGcmDecrypt(accountKeyFor(accountId), encrypted)
}

function generateSecret() {
  return authenticator.generateSecret()
}

function otpauthUrl(secret, accountLabel) {
  return authenticator.keyuri(accountLabel || 'account', 'SlickSync', secret)
}

async function qrCodeDataUrl(otpauthUrlStr) {
  return QRCode.toDataURL(otpauthUrlStr)
}

// otplib defaults to a 1-step (30s) window either side of "now", enough for
// modest clock drift between server and phone without materially widening
// the guessable window.
function verifyTotp(secret, token) {
  if (!secret || !token) return false
  try {
    return authenticator.check(String(token).replace(/\s+/g, ''), secret)
  } catch {
    return false
  }
}

// Backup codes: returned to the caller ONCE in plaintext (caller must show
// and discard); only bcrypt hashes are persisted, same treatment as the
// login password itself. 10 codes, xxxx-xxxx shape - long enough to resist
// brute force over the codes' effectively-unlimited lifetime (no rate limit
// on backup-code entry beyond the normal login attempt), short enough to
// type by hand.
function generateBackupCodes(count = 10) {
  const codes = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase() // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`)
  }
  return codes
}

async function hashBackupCodes(codes) {
  return Promise.all(codes.map((c) => bcrypt.hash(c, 10)))
}

// Consumes the FIRST matching hash (one-shot) and returns the remaining
// hash list to persist - each backup code works exactly once.
async function consumeBackupCode(hashedCodes, presented) {
  const normalized = String(presented || '').trim().toUpperCase()
  if (!normalized) return null
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(normalized, hashedCodes[i])) {
      return [...hashedCodes.slice(0, i), ...hashedCodes.slice(i + 1)]
    }
  }
  return null
}

function createPendingChallenge(accountId) {
  const token = crypto.randomBytes(32).toString('hex')
  pendingStore.set(token, { accountId, expiresAt: Date.now() + PENDING_TTL_MS })
  return token
}

// One-shot: deletes on read whether or not it was still valid, so a
// pending token can never be replayed even within its TTL.
function consumePendingChallenge(token) {
  const entry = pendingStore.get(String(token || ''))
  if (!entry) return null
  pendingStore.delete(token)
  if (Date.now() > entry.expiresAt) return null
  return entry.accountId
}

module.exports = {
  generateSecret,
  otpauthUrl,
  qrCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  hashBackupCodes,
  consumeBackupCode,
  createPendingChallenge,
  consumePendingChallenge,
  encryptSecret,
  decryptSecret,
}
