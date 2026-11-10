// Change ONE key of AppAccount.sync from a fresh read: `update` gets the key's
// current value (as just read) and returns the new one. Callers that held an
// older copy of the whole settings blob across a slow step use this so they
// never write back keys they don't own. See accountSync.js for the write.

const { setAccountSyncKeys } = require('./accountSync')

async function updateAccountSyncKey(prisma, accountId, key, update) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  const current = cfg && typeof cfg === 'object' ? cfg[key] : undefined
  const next = update(current)
  return setAccountSyncKeys(prisma, accountId, { [key]: next })
}

module.exports = { updateAccountSyncKey }
