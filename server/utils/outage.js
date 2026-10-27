// Whether an error means "could not check right now" rather than "no".
//
// A person's own page signs them out only when their sign-in check answers
// 401/403/404; anything else keeps the saved sign-in. The checks used to send
// 401 for every unexpected error, so our database being down, or Stremio,
// Nuvio or a Jellyfin server not answering, signed people out as if their
// sign-in had ended. Those answer 503 now, through this test.

// Prisma: can't reach the database, it timed out, the connection closed, or
// the connection pool ran dry.
const PRISMA_OUTAGE = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

function isOutage(error) {
  if (!error) return false
  const name = error.name || ''
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') return true
  if (PRISMA_OUTAGE.has(error.code)) return true
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (NETWORK_CODES.has(error.code) || NETWORK_CODES.has(error.cause?.code)) return true
  const status = Number(error.status ?? error.statusCode ?? error.response?.status)
  if (status >= 500 && status < 600) return true
  // fetch() itself, and a provider answering with a server error ("HTTP 503").
  return /^fetch failed$|^HTTP 5\d\d\b/i.test(String(error.message || ''))
}

const OUTAGE_ANSWER = { error: 'SERVICE_UNAVAILABLE', message: 'Your sign-in could not be checked just now. Try again in a moment.' }

module.exports = { isOutage, OUTAGE_ANSWER }
