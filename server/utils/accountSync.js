// AppAccount.sync is one JSON value that dozens of features share. Changing
// one key means writing the whole value back, so the copy written has to be
// read right before the write: a copy taken earlier, before some slow work,
// puts back whatever any other feature saved in the meantime. A sync run
// doing exactly that switched off a daily limit saved while it was going.

/**
 * Set top-level keys of the account's settings on a fresh read, keeping the
 * column's own shape (a JSON column on Postgres, text on SQLite). Returns
 * false, writing nothing, when the stored value can't be read.
 */
async function setAccountSyncKeys(prisma, accountId, keys) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { return false } }
  const next = { ...(cfg && typeof cfg === 'object' ? cfg : {}), ...keys }
  if (asString) {
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(next) } })
    return true
  }
  // Nothing stored yet says nothing about the column, so try both shapes.
  try {
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: next } })
  } catch {
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(next) } })
  }
  return true
}

module.exports = { setAccountSyncKeys }
