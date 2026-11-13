// A Vault key's History (the VaultAccessLog table): each time it was shown,
// copied, changed or added, from which device and address. Read by
// GET /api/vault/:id/history for the clock button on the Vault card.
//
// Only what a person did is kept. SlickSync using a key itself - its checks,
// putting it into addons, the nightly backup - happens all day and would
// bury the lines worth reading.
//
// Also here: the limit on showing and copying keys. More than REVEAL_LIMIT in
// REVEAL_WINDOW_MS for one account and the next one is refused for a few
// minutes - normal use never gets near it, but a stolen session cannot empty
// the Vault in one go.

const KEEP_DAYS = 365
const LIST_LIMIT = 100
const REVEAL_LIMIT = 30
const REVEAL_WINDOW_MS = 10 * 60 * 1000
const LIMIT_MESSAGE = 'You’ve shown keys a lot in a short time. Wait a few minutes, then try again.'

// swapped: SlickSync traded it with its backup key (failover, and back).
const ACTIONS = new Set(['shown', 'copied', 'moved', 'changed', 'added', 'swapped'])

/** "Chrome on Windows", from the browser's own description. */
function deviceFromUserAgent(ua) {
  const s = String(ua || '')
  if (!s) return null
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(s) ? 'Firefox'
    : /Chrome|CriOS|Chromium/.test(s) ? 'Chrome'
    : /Safari/.test(s) ? 'Safari'
    : /curl|wget|python|node|bun|axios|okhttp/i.test(s) ? 'A script'
    : 'A browser'
  const os = /iPhone|iPod/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? 'Android'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows'
    : /Linux/.test(s) ? 'Linux'
    : null
  return os ? `${browser} on ${os}` : browser
}

/** The address the request came from (trust proxy is set to one hop). */
function clientAddress(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || '')
  return ip.replace(/^::ffff:/, '') || null
}

async function recordVaultAccess(prisma, { accountId, entryId, action, req, device }) {
  try {
    if (!prisma?.vaultAccessLog || !entryId || !ACTIONS.has(action)) return
    const now = new Date()
    await prisma.vaultAccessLog.create({
      data: {
        accountId: accountId || 'default',
        entryId,
        action,
        device: device || deviceFromUserAgent(req?.headers?.['user-agent']),
        ip: req ? clientAddress(req) : null,
      },
    })
    const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000)
    await prisma.vaultAccessLog.deleteMany({ where: { entryId, at: { lt: cutoff } } })
  } catch (e) {
    console.warn('[VaultAccess] Could not record:', e?.message)
  }
}

async function listVaultHistory(prisma, { accountId, entryId }) {
  const rows = await prisma.vaultAccessLog.findMany({
    where: { accountId: accountId || 'default', entryId },
    orderBy: { at: 'desc' },
    take: LIST_LIMIT,
  })
  return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, device: r.device, ip: r.ip }))
}

// One sliding window per account, in memory: a restart clears it, which is
// fine for a limit measured in minutes.
const windows = new Map()

/** True when this account may show or copy one more key right now. */
function takeRevealSlot(accountId, now = Date.now()) {
  const key = accountId || 'default'
  const recent = (windows.get(key) || []).filter((t) => now - t < REVEAL_WINDOW_MS)
  if (recent.length >= REVEAL_LIMIT) {
    windows.set(key, recent)
    return false
  }
  recent.push(now)
  windows.set(key, recent)
  return true
}

function resetRevealSlots() {
  windows.clear()
}

module.exports = {
  deviceFromUserAgent,
  clientAddress,
  recordVaultAccess,
  listVaultHistory,
  takeRevealSlot,
  resetRevealSlots,
  LIMIT_MESSAGE,
  REVEAL_LIMIT,
  REVEAL_WINDOW_MS,
}
