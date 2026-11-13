// A person's Sync history (the SyncLog table): what each sync changed on
// their Stremio or Nuvio account, who or what started it, and the ones that
// failed. Read by GET /api/users/:id/sync-history for the "Sync history"
// button on their page.
//
// Kept on purpose:
//   - only syncs that changed something, and failures. The schedule checks
//     every few hours and finds nothing to do almost every time; keeping
//     those would bury the syncs that matter.
//   - a failure that repeats (same sign-in, same error) is counted on the
//     line it already has rather than added again, so a sign-in that stays
//     broken for a week is one line, not fifty.
//   - 90 days, trimmed whenever that person gets a new line.
//
// Recording never changes a sync's result: every write is caught.

const KEEP_DAYS = 90
const LIST_LIMIT = 60

// What started a sync. Stored as the key; the page words it.
const SOURCES = new Set([
  'manual', // Sync on their page or the Users list
  'sync_all', // Sync all (users or groups)
  'group_sync', // Sync on a group
  'group_change', // a group's addons were reordered or edited
  'addon_update', // an addon was reloaded and changed
  'schedule', // the automatic sync
  'api', // the external API
  'invite', // an invite was accepted
  'self', // they did it from their own page
  'automation', // an automation rule
  'key_change', // a Vault key changed and was pushed to its addons
  'screen_time', // a screen-time limit started or ended
  'trax', // their SlickTrax rows changed
  'other',
])

const nameOf = (a) => a?.manifest?.name || a?.name || a?.transportName || 'Unnamed addon'

/**
 * The difference between what an account had and what a sync sent, by the
 * same fingerprint the sync compares with. `staleKeys` are the fingerprints
 * the plan flagged as an old copy of the same addon (a new version or name).
 */
function describeSyncChange(current, desired, fingerprint, staleKeys = []) {
  const cur = (current || []).map((a) => ({ key: fingerprint(a), a }))
  const want = (desired || []).map((a) => ({ key: fingerprint(a), a }))
  const curKeys = new Set(cur.map((x) => x.key))
  const wantKeys = new Set(want.map((x) => x.key))
  const added = want.filter((x) => !curKeys.has(x.key)).map((x) => nameOf(x.a))
  const removed = cur.filter((x) => !wantKeys.has(x.key)).map((x) => nameOf(x.a))
  const stale = new Set(staleKeys || [])
  const updated = want.filter((x) => stale.has(x.key)).map((x) => nameOf(x.a))
  // A new order only counts among the addons that were there before and still are.
  const keptBefore = cur.map((x) => x.key).filter((k) => wantKeys.has(k))
  const keptAfter = want.map((x) => x.key).filter((k) => curKeys.has(k))
  const reordered = keptBefore.length > 1 && keptBefore.some((k, i) => k !== keptAfter[i])
  return { added, removed, updated, reordered }
}

const changed = (c) => !!c && (c.added.length > 0 || c.removed.length > 0 || c.updated.length > 0 || c.reordered)

function cleanSource(source) {
  return SOURCES.has(source) ? source : 'other'
}

/**
 * Records one sign-in's sync outcome. `result` is what syncCredentialsAddons
 * returned (success, error, total, change). Nothing is kept for a sync that
 * changed nothing, or one that did not apply (a person in no group, a
 * Jellyfin sign-in with no addon list).
 */
async function recordSyncOutcome(prisma, { accountId, userId, provider, source, groupName, result }) {
  try {
    if (!prisma?.syncLog || !userId || !result) return
    if (result.unsupported || result.noGroup) return
    const now = new Date()
    const base = { accountId: accountId || 'default', userId, provider: provider || 'stremio' }
    if (result.success) {
      if (!changed(result.change)) return
      const c = result.change
      await prisma.syncLog.create({
        data: {
          ...base,
          source: cleanSource(source),
          groupName: groupName || null,
          ok: true,
          added: c.added.length ? JSON.stringify(c.added) : null,
          removed: c.removed.length ? JSON.stringify(c.removed) : null,
          updated: c.updated.length ? JSON.stringify(c.updated) : null,
          reordered: !!c.reordered,
          total: Number.isFinite(result.total) ? result.total : null,
        },
      })
    } else {
      const error = String(result.error || 'Unknown error').slice(0, 500)
      const last = await prisma.syncLog.findFirst({
        where: { userId, provider: base.provider },
        orderBy: { lastAt: 'desc' },
      })
      if (last && !last.ok && last.error === error) {
        await prisma.syncLog.update({ where: { id: last.id }, data: { repeats: { increment: 1 }, lastAt: now } })
      } else {
        await prisma.syncLog.create({
          data: { ...base, source: cleanSource(source), groupName: groupName || null, ok: false, error },
        })
      }
    }
    const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000)
    await prisma.syncLog.deleteMany({ where: { userId, lastAt: { lt: cutoff } } })
  } catch (e) {
    console.warn('[SyncLog] Could not record a sync:', e?.message)
  }
}

const parseList = (s) => {
  if (!s) return []
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

/** Newest first, ready for the page. */
async function listSyncHistory(prisma, { accountId, userId }) {
  const rows = await prisma.syncLog.findMany({
    where: { accountId: accountId || 'default', userId },
    orderBy: { lastAt: 'desc' },
    take: LIST_LIMIT,
  })
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    lastAt: r.lastAt,
    provider: r.provider,
    source: r.source,
    groupName: r.groupName,
    ok: r.ok,
    added: parseList(r.added),
    removed: parseList(r.removed),
    updated: parseList(r.updated),
    reordered: r.reordered,
    total: r.total,
    error: r.error,
    repeats: r.repeats,
  }))
}

module.exports = { describeSyncChange, recordSyncOutcome, listSyncHistory, SOURCES, KEEP_DAYS }
