// Daily sweep for VaultEntry.autoRemoveEnabled (real_debrid/torbox only) -
// deletes a torrent from the provider's own account once it's finished and
// has sat idle past autoRemoveAfterDays. Off by default per-entry (this is
// a real deletion on the provider's side, not a local record), and every
// entry is independently opted in. Same scheduling shape as
// contentRatingEnforcement.js.

let enforcementTimer = null
const INTERVAL_HOURS = 24

async function runDebridAutoRemove(prisma, decrypt) {
  try {
    const { listEligibleTorrents, deleteTorrent } = require('./debridUsage')
    const entries = await prisma.vaultEntry.findMany({
      where: {
        autoRemoveEnabled: true,
        isActive: true,
        testType: { in: ['real_debrid', 'torbox'] },
      },
    })

    let removedTotal = 0
    for (const entry of entries) {
      try {
        // Deliberately does NOT follow the entry's backup key, unlike every
        // read-only consumer of failover. Auto-remove DELETES torrents from
        // the provider account the key belongs to. Vault entries are
        // account-scoped with no owner field, so a "backup" may well be a
        // different person's debrid account - failing over here would start
        // deleting their torrents, on this entry's schedule, without either
        // of them asking for it. Reading a quota with the wrong key is a
        // harmless mistake; deleting with the wrong key is not.
        //
        // If the spare account should also be swept, it has its own entry
        // and its own auto-remove toggle - which is the honest way to say so.
        const apiKey = decrypt(entry.encryptedSecret, { appAccountId: entry.accountId })
        if (!apiKey) continue

        const eligible = await listEligibleTorrents(entry.testType, apiKey, entry.autoRemoveAfterDays)
        let removedForEntry = 0
        for (const torrent of eligible) {
          const ok = await deleteTorrent(entry.testType, apiKey, torrent.id)
          if (ok) removedForEntry++
        }

        if (removedForEntry > 0) {
          removedTotal += removedForEntry
          console.log(`[DebridAutoRemove] "${entry.name}": removed ${removedForEntry} finished torrent(s) idle past ${entry.autoRemoveAfterDays}d`)
        }
        await prisma.vaultEntry.update({ where: { id: entry.id }, data: { lastAutoRemoveAt: new Date() } }).catch(() => {})
      } catch (err) {
        console.warn(`[DebridAutoRemove] Failed for entry ${entry.id} (${entry.name}):`, err?.message || err)
      }
    }
    if (removedTotal > 0) console.log(`[DebridAutoRemove] ${removedTotal} torrent(s) removed across ${entries.length} opted-in entr${entries.length === 1 ? 'y' : 'ies'}`)
  } catch (err) {
    console.warn('[DebridAutoRemove] Run failed:', err?.message || err)
  }
}

function scheduleDebridAutoRemove(prisma, decrypt) {
  if (enforcementTimer) {
    clearInterval(enforcementTimer)
    enforcementTimer = null
  }
  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000
  // Staggered past the other boot-time schedulers, then daily.
  setTimeout(() => runDebridAutoRemove(prisma, decrypt), 130 * 1000)
  enforcementTimer = setInterval(() => runDebridAutoRemove(prisma, decrypt), intervalMs)
  console.log(`[DebridAutoRemove] Scheduled every ${INTERVAL_HOURS}h`)
}

module.exports = { scheduleDebridAutoRemove, runDebridAutoRemove }
