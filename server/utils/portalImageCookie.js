// Pictures for someone signed in to their own portal.
//
// The portal proves who someone is with a token in a header, and an <img>
// request cannot send one. So when the portal loads the person's details (with
// that token checked), the server also sets this cookie. It opens exactly two
// routes - the poster cache and the poster-ratings route - and only while the
// person is still switched on.
const jwt = require('jsonwebtoken')

const PORTAL_IMAGE_COOKIE = 'sfm_pimg'
const COVERED = /^\/api\/(img|poster)(\/|$)/
const CHECK_MS = 60 * 1000
const checked = new Map() // `${userId}:${accountId}` -> { ok, at }

const portalImageCookie = {
  sign(userId, accountId, secret) {
    return jwt.sign({ typ: 'portal-img', sub: userId, acc: accountId }, secret, { expiresIn: '30d' })
  },
  covers(path) {
    return COVERED.test(String(path || ''))
  },
  /** The account to serve pictures for, or null. */
  async account(value, secret, prisma) {
    if (!value) return null
    let claims
    try { claims = jwt.verify(value, secret) } catch { return null }
    if (claims?.typ !== 'portal-img' || typeof claims.sub !== 'string' || typeof claims.acc !== 'string') return null
    const now = Date.now()
    const key = `${claims.sub}:${claims.acc}`
    let hit = checked.get(key)
    if (!hit || now - hit.at > CHECK_MS) {
      const row = await prisma.user.findUnique({ where: { id: claims.sub }, select: { isActive: true, accountId: true } }).catch(() => null)
      hit = { ok: !!row?.isActive && (row.accountId || 'default') === claims.acc, at: now }
      checked.set(key, hit)
      if (checked.size > 5000) checked.delete(checked.keys().next().value)
    }
    return hit.ok ? claims.acc : null
  },
}

module.exports = { portalImageCookie, PORTAL_IMAGE_COOKIE }
