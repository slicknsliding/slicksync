// The visitor's own address behind Cloudflare.
//
// `trust proxy` reads X-Forwarded-For, but a proxy that sits between
// Cloudflare and SlickSync (Traefik by default) replaces that header with the
// address of the Cloudflare server it heard from. Every visitor then shares a
// handful of Cloudflare addresses, and every limit keyed on the address is
// shared with strangers. Cloudflare puts the real address in CF-Connecting-IP.
//
// Anyone can send that header, so it is only believed when the request came
// in from one of Cloudflare's own published ranges, and only when the
// operator says the instance sits behind Cloudflare (TRUST_CLOUDFLARE=true).
// Ranges from https://www.cloudflare.com/ips (checked November 2026).
const proxyaddr = require('proxy-addr')
const net = require('net')

const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

const fromCloudflare = proxyaddr.compile(CLOUDFLARE_RANGES)

function cloudflareTrusted(env = process.env) {
  return String(env.TRUST_CLOUDFLARE || '').trim().toLowerCase() === 'true'
}

/** The address to count a request against. `ip` is what Express worked out. */
function visitorAddress(ip, cfHeader, enabled) {
  if (!enabled || !ip || !cfHeader) return ip
  const claimed = String(cfHeader).trim()
  if (!net.isIP(claimed)) return ip
  let edge = ip
  if (edge.startsWith('::ffff:') && net.isIPv4(edge.slice(7))) edge = edge.slice(7)
  if (!net.isIP(edge) || !fromCloudflare(edge, 0)) return ip
  return claimed
}

/** Express middleware: makes req.ip the visitor's own address when it can tell. */
function cloudflareClientIp({ env = process.env } = {}) {
  const enabled = cloudflareTrusted(env)
  return (req, res, next) => {
    if (enabled) {
      const ip = visitorAddress(req.ip, req.get('cf-connecting-ip'), true)
      if (ip !== req.ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true })
    }
    next()
  }
}

module.exports = { cloudflareClientIp, visitorAddress, cloudflareTrusted, CLOUDFLARE_RANGES }
