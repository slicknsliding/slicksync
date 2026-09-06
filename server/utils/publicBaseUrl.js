/**
 * The address devices reach this instance on.
 *
 * Anything installed onto a device - SlickTrax, a patched-Cinemeta mirror -
 * needs an address a phone or TV can actually resolve, and the code building
 * that address usually has no incoming request to borrow a hostname from
 * (a sync runs on a timer, not on a browser click). Three sources, in
 * descending order of how deliberate they are:
 *
 *   1. PUBLIC_APP_URL, set by whoever runs the instance.
 *   2. The address typed into Settings -> Sync.
 *   3. One an authenticated admin request revealed, recorded earlier.
 *
 * A request is accepted as a last resort only when it is not loopback: an
 * API call made on the server itself would otherwise hand devices an address
 * that only works on the server.
 */

async function resolvePublicBaseUrl(prisma, accountId, req) {
  const env = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  if (env) return env

  try {
    const acct = await prisma.appAccount.findUnique({ where: { id: accountId || 'default' }, select: { sync: true } })
    let cfg = acct?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    const configured = (cfg && typeof cfg.publicBaseUrl === 'string' ? cfg.publicBaseUrl : '').trim().replace(/\/+$/, '')
    if (configured) return configured
    const observed = (cfg && typeof cfg.observedBaseUrl === 'string' ? cfg.observedBaseUrl : '').trim().replace(/\/+$/, '')
    if (observed) return observed
  } catch { /* fall through to the request */ }

  if (req && typeof req.get === 'function') {
    const host = req.get('host')
    const fromRequest = host ? `${req.protocol}://${host}` : ''
    if (fromRequest && !/^https?:\/\/(localhost|127\.|\[?::1)/i.test(fromRequest)) return fromRequest
  }

  return ''
}

module.exports = { resolvePublicBaseUrl }
