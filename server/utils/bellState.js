/**
 * The bell's own state, kept on the server so it is the same on every device.
 *
 * Two things used to make a cleared notification come back:
 *
 *  1. Clear deleted the stored rows. The checks that run on a timer (the
 *     "streamed but not recorded" check every minute, the sign-in and
 *     collections guards, connection alerts...) decide "already told them"
 *     by whether their row still exists - so a minute after Clear they saw
 *     nothing standing and raised it again. Now a row that one of those
 *     checks owns (it has a dedupeKey) is hidden instead (dismissedAt): the
 *     check still sees it and stays quiet, and when the problem goes away
 *     the check deletes its row as it always did, so a real recurrence
 *     comes back as a new, visible notification. Rows without a key are
 *     one-off events and are still deleted.
 *
 *  2. Everything the bell builds itself (new episodes, addons going down,
 *     invites, tasks...) was cleared only in that browser's localStorage, so
 *     clearing on the PC left them on the phone. The time of the last Clear,
 *     the rows dismissed one by one and the rows read are kept here per
 *     account instead (BellState), and every device reads them.
 */

const MAX_DISMISSED = 500
const MAX_READ = 1000

function parseList(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 200) : []
  } catch {
    return []
  }
}

function shape(row) {
  return {
    clearedBefore: row?.clearedBefore ? new Date(row.clearedBefore).toISOString() : null,
    dismissed: parseList(row?.dismissed),
    read: parseList(row?.readIds),
  }
}

async function getBellState(prisma, accountId) {
  const row = await prisma.bellState.findUnique({ where: { accountId } }).catch(() => null)
  return shape(row)
}

// Newest last; the oldest fall off once the list is full.
function addAll(list, ids, max) {
  const set = new Set(list)
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > 200) continue
    set.delete(id)
    set.add(id)
  }
  return [...set].slice(-max)
}

/**
 * Apply one change from a device and return the whole state.
 *   { clearAll: true }   - Clear: everything up to now is gone everywhere
 *   { dismiss: [ids] }   - rows dismissed one by one
 *   { read: [ids] }      - rows read (opened, or Mark all read)
 * Merged on the server, so two devices acting at once both count.
 */
async function updateBellState(prisma, accountId, change = {}) {
  const current = await getBellState(prisma, accountId)
  let { clearedBefore, dismissed, read } = current
  if (change.clearAll) {
    clearedBefore = new Date().toISOString()
    // Nothing from before now shows again anyway, so the lists start over.
    dismissed = []
    read = []
  }
  if (Array.isArray(change.dismiss)) dismissed = addAll(dismissed, change.dismiss, MAX_DISMISSED)
  if (Array.isArray(change.read)) read = addAll(read, change.read, MAX_READ)
  const data = {
    clearedBefore: clearedBefore ? new Date(clearedBefore) : null,
    dismissed: JSON.stringify(dismissed),
    readIds: JSON.stringify(read),
  }
  await prisma.bellState.upsert({ where: { accountId }, create: { accountId, ...data }, update: data })
  return { clearedBefore, dismissed, read }
}

/**
 * Dismiss stored notifications - some by id, or all of them (Clear). Rows a
 * timed check owns (dedupeKey) are hidden, the rest deleted; see above.
 */
async function dismissStored(prisma, accountId, ids = null) {
  const scope = { accountId, ...(Array.isArray(ids) ? { id: { in: ids } } : {}) }
  await prisma.notification.updateMany({
    where: { ...scope, dedupeKey: { not: null }, dismissedAt: null },
    data: { dismissedAt: new Date(), read: true, readAt: new Date() },
  })
  await prisma.notification.deleteMany({ where: { ...scope, dedupeKey: null } })
}

module.exports = { getBellState, updateBellState, dismissStored, MAX_DISMISSED, MAX_READ }
