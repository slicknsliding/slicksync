// Whether an address someone typed in is safe for this server to fetch.
// Loopback, RFC1918, link-local (cloud metadata included) and their IPv6
// equivalents are refused, by literal IP and by what the name resolves to.
// Used by the image proxy, and by anything that calls a server address an
// account entered on an instance that serves strangers.

const dns = require('dns').promises

function isPrivateIp(ip) {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) return isPrivateIp(v4[1])
  return false
}

async function assertSafeUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('invalid url') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('blocked host')
  }
  if (isPrivateIp(host)) throw new Error('blocked host')
  try {
    const { address } = await dns.lookup(host)
    if (isPrivateIp(address)) throw new Error('blocked host')
  } catch (e) {
    if (e.message === 'blocked host') throw e
    throw new Error('unresolvable host')
  }
  return url
}

module.exports = { isPrivateIp, assertSafeUrl }
