// Collections Guard: Account Guard's philosophy applied to Nuvio's
// home-screen collections. Collections live ONLY in Nuvio's backend, and
// its sync is last-write-wins - another logged-in client pushing a stale
// (or empty) state silently erases what the user built, with no history to
// recover from. Confirmed real incident, not hypothetical: a whole set of
// collections vanished this way and the only fix was rebuilding by hand.
//
// So the guard keeps rolling snapshots and raises an alarm - push + bell,
// per the notification priority rule - when a read looks like an external
// overwrite: collections gone entirely, or more than half of them vanished
// since the last good snapshot. It never auto-restores (a restore is
// itself a last-write-wins push, so a human confirms it); the Nuvio
// Collections page shows Restore / Accept, mirroring Account Guard's
// Re-assert / Accept verbs.
//
// The guard's own reads are the snapshot source. SlickSync's own
// setCollections writes call recordOwnWrite() so a deliberate edit made
// HERE (including deleting collections in the manager) becomes the new
// baseline immediately and never alarms.

const GUARD_INTERVAL_MS = 60 * 60 * 1000 // hourly - vanish detection doesn't need sync's 5-min cadence
const BOOT_DELAY_MS = 3 * 60 * 1000 // stagger past boot-time schedulers, same pattern as dbMaintenance
const KEEP_GOOD_SNAPSHOTS = 12

function summarize(collections) {
  const list = Array.isArray(collections) ? collections : []
  const sourceCount = list.reduce((n, c) => {
    const folders = Array.isArray(c?.folders) ? c.folders : []
    return n + folders.reduce((m, f) => m + (Array.isArray(f?.sources) ? f.sources.length : 0), 0)
  }, 0)
  return { collectionCount: list.length, sourceCount }
}

async function saveSnapshot(prisma, accountId, userId, profileId, collections, alarmed = false) {
  const { collectionCount, sourceCount } = summarize(collections)
  await prisma.nuvioCollectionsSnapshot.create({
    data: {
      accountId: accountId || 'default', userId, profileId,
      collectionCount, sourceCount,
      dataJson: JSON.stringify(collections || []),
      alarmed,
    },
  })
  // Retention: cap the good rows; alarmed rows are superseded naturally
  // (an alarm older than a good row is history) so they ride the same cap.
  const stale = await prisma.nuvioCollectionsSnapshot.findMany({
    where: { userId, profileId },
    orderBy: { createdAt: 'desc' },
    skip: KEEP_GOOD_SNAPSHOTS,
    select: { id: true },
  })
  if (stale.length > 0) {
    await prisma.nuvioCollectionsSnapshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
  }
}

async function latestSnapshots(prisma, userId, profileId) {
  const rows = await prisma.nuvioCollectionsSnapshot.findMany({
    where: { userId, profileId },
    orderBy: { createdAt: 'desc' },
    take: KEEP_GOOD_SNAPSHOTS,
  })
  return {
    newest: rows[0] || null,
    newestGood: rows.find((r) => !r.alarmed) || null,
  }
}

function looksOverwritten(prevGood, collections) {
  if (!prevGood || prevGood.collectionCount === 0) return false
  const { collectionCount } = summarize(collections)
  if (collectionCount === 0) return true
  return collectionCount <= prevGood.collectionCount / 2
}

/** SlickSync's own collection writes are the new baseline - called from the
 * setCollections route after a successful push, so deliberate edits made
 * here never read as foreign. */
async function recordOwnWrite(prisma, accountId, userId, profileId, collections) {
  try {
    await saveSnapshot(prisma, accountId, userId, profileId, collections, false)
  } catch (e) {
    console.warn('[CollectionsGuard] own-write snapshot failed:', e?.message)
  }
}

async function checkUser(prisma, accountId, user, provider) {
  let profiles = []
  try { profiles = await provider.getProfiles() } catch { return }
  for (const profile of profiles) {
    const profileId = profile?.profile_index
    if (!Number.isInteger(profileId)) continue
    let collections
    try { collections = await provider.getCollections(profileId) } catch { continue }
    if (!Array.isArray(collections)) continue

    const { newest, newestGood } = await latestSnapshots(prisma, user.id, profileId)
    if (looksOverwritten(newestGood, collections)) {
      // Already alarmed for this state? Don't re-write the same alarm row
      // every hour - the dedupeKey keeps the bell to one row regardless.
      if (!newest || !newest.alarmed) {
        await saveSnapshot(prisma, accountId, user.id, profileId, collections, true)
      }
      const { collectionCount } = summarize(collections)
      try {
        const { createNotification } = require('./notificationStore')
        await createNotification(prisma, accountId || 'default', {
          type: 'sync',
          title: 'Nuvio collections may have been overwritten',
          body: `${user.username || 'A Nuvio user'}'s profile ${profileId} went from ${newestGood.collectionCount} collections to ${collectionCount}. Another logged-in Nuvio app pushing a stale state does exactly this. Open Nuvio Collections to Restore the last good snapshot or Accept the new state.`,
          url: '/catalogs/nuvio-collections',
          dedupeKey: `collections-guard-${user.id}-${profileId}`,
        })
        const { sendPushToAccount: push } = require('./pushNotifications')
        await push(prisma, accountId || 'default', {
          title: 'Nuvio collections may have been overwritten',
          body: `${newestGood.collectionCount} collections dropped to ${collectionCount} on ${user.username || 'a Nuvio account'}. One tap in SlickSync restores them.`,
          url: '/catalogs/nuvio-collections',
        }).catch(() => {})
      } catch (e) {
        console.warn('[CollectionsGuard] alert failed:', e?.message)
      }
      console.warn(`[CollectionsGuard] suspicious drop for user ${user.id} profile ${profileId}: ${newestGood.collectionCount} -> ${summarize(collections).collectionCount}`)
    } else {
      await saveSnapshot(prisma, accountId, user.id, profileId, collections, false)
    }

    // Same pass, second guard: the profile's home-row arrangement.
    if (provider.getHomeCatalogSettings && provider.pushHomeCatalogSettings) {
      try {
        await checkUserLayout(prisma, accountId, user, provider, profileId)
      } catch (e) {
        console.warn(`[CollectionsGuard] layout check failed for user ${user.id} profile ${profileId}:`, e?.message)
      }
    }
  }
}

// ---- Home-row layout guard (same pattern, second table) ----
//
// The home-catalog settings blobs (row order, renames, hidden rows - one
// blob per platform bucket) are just as losable as collections: ONE
// malformed write makes the client silently discard an ENTIRE blob, which
// is exactly what SlickSync's own first placement write did during
// development. Snapshots ride the same hourly pass and the same
// Restore/Accept verbs; dataJson holds { [platform]: blob }.

const LAYOUT_PLATFORMS = ['home_catalog_shared', 'mobile', 'desktop']

function parseLayoutBlob(raw) {
  if (!raw) return null
  let v = raw
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
  return v && typeof v === 'object' ? v : null
}

function layoutItemCount(data) {
  return Object.values(data || {}).reduce((n, blob) => n + (Array.isArray(blob?.items) ? blob.items.length : 0), 0)
}

async function readLayout(provider, profileId) {
  const data = {}
  for (const platform of LAYOUT_PLATFORMS) {
    try {
      const rows = await provider.getHomeCatalogSettings(profileId, platform)
      const blob = parseLayoutBlob(rows?.[0]?.settings_json)
      if (blob) data[platform] = blob
    } catch { /* bucket unreadable - treated as absent */ }
  }
  return data
}

async function saveLayoutSnapshot(prisma, accountId, userId, profileId, data, alarmed = false) {
  await prisma.nuvioHomeLayoutSnapshot.create({
    data: {
      accountId: accountId || 'default', userId, profileId,
      itemCount: layoutItemCount(data),
      dataJson: JSON.stringify(data || {}),
      alarmed,
    },
  })
  const stale = await prisma.nuvioHomeLayoutSnapshot.findMany({
    where: { userId, profileId },
    orderBy: { createdAt: 'desc' },
    skip: KEEP_GOOD_SNAPSHOTS,
    select: { id: true },
  })
  if (stale.length > 0) {
    await prisma.nuvioHomeLayoutSnapshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
  }
}

async function latestLayoutSnapshots(prisma, userId, profileId) {
  const rows = await prisma.nuvioHomeLayoutSnapshot.findMany({
    where: { userId, profileId },
    orderBy: { createdAt: 'desc' },
    take: KEEP_GOOD_SNAPSHOTS,
  })
  return { newest: rows[0] || null, newestGood: rows.find((r) => !r.alarmed) || null }
}

async function checkUserLayout(prisma, accountId, user, provider, profileId) {
  const data = await readLayout(provider, profileId)
  const count = layoutItemCount(data)
  const { newest, newestGood } = await latestLayoutSnapshots(prisma, user.id, profileId)
  const suspicious = newestGood && newestGood.itemCount > 0 && (count === 0 || count <= newestGood.itemCount / 2)
  if (suspicious) {
    if (!newest || !newest.alarmed) {
      await saveLayoutSnapshot(prisma, accountId, user.id, profileId, data, true)
    }
    try {
      const { createNotification } = require('./notificationStore')
      await createNotification(prisma, accountId || 'default', {
        type: 'sync',
        title: 'Nuvio home-row layout may have been wiped',
        body: `${user.username || 'A Nuvio user'}'s profile ${profileId} home arrangement went from ${newestGood.itemCount} rows to ${count}. One bad write from any client erases the whole arrangement. Open Nuvio Collections to Restore the last good layout or Accept the new one.`,
        url: '/catalogs/nuvio-collections',
        dedupeKey: `layout-guard-${user.id}-${profileId}`,
      })
      const { sendPushToAccount } = require('./pushNotifications')
      await sendPushToAccount(prisma, accountId || 'default', {
        title: 'Nuvio home rows may have been wiped',
        body: `${newestGood.itemCount} rows dropped to ${count} on ${user.username || 'a Nuvio account'}. One tap in SlickSync restores the layout.`,
        url: '/catalogs/nuvio-collections',
      }).catch(() => {})
    } catch (e) {
      console.warn('[CollectionsGuard] layout alert failed:', e?.message)
    }
    console.warn(`[CollectionsGuard] suspicious layout drop for user ${user.id} profile ${profileId}: ${newestGood.itemCount} -> ${count}`)
  } else {
    await saveLayoutSnapshot(prisma, accountId, user.id, profileId, data, false)
  }
}

/** Push every platform blob from the newest good layout snapshot back. */
async function restoreLayoutSnapshot(prisma, accountId, userId, profileId, provider) {
  const { newestGood } = await latestLayoutSnapshots(prisma, userId, profileId)
  if (!newestGood) throw new Error('No good layout snapshot exists to restore from')
  let data
  try { data = JSON.parse(newestGood.dataJson) } catch { throw new Error('Stored layout snapshot is unreadable') }
  for (const [platform, blob] of Object.entries(data || {})) {
    await provider.pushHomeCatalogSettings(profileId, platform, blob)
  }
  await saveLayoutSnapshot(prisma, accountId, userId, profileId, data, false)
  return { restoredItems: layoutItemCount(data), from: newestGood.createdAt }
}

/** Adopt the current on-account layout as the new baseline. */
async function acceptLayoutCurrent(prisma, accountId, userId, profileId, provider) {
  const data = await readLayout(provider, profileId)
  await saveLayoutSnapshot(prisma, accountId, userId, profileId, data, false)
  return { acceptedItems: layoutItemCount(data) }
}

/** Copy one profile's whole home-row arrangement onto another - reads the
 * source live and overwrites every platform bucket on the target. Both
 * profiles get fresh baselines so the guard treats it as our own write. */
async function copyLayout(prisma, accountId, userId, fromProfileId, toProfileId, provider) {
  const data = await readLayout(provider, fromProfileId)
  if (layoutItemCount(data) === 0) throw new Error('The source profile has no synced home-row arrangement to copy')
  for (const [platform, blob] of Object.entries(data)) {
    await provider.pushHomeCatalogSettings(toProfileId, platform, blob)
  }
  await saveLayoutSnapshot(prisma, accountId, userId, toProfileId, data, false)
  return { copiedItems: layoutItemCount(data) }
}

/** Active alarms for the UI banner: the newest snapshot is alarmed. */
async function getAlarms(prisma, accountId) {
  const alarms = []
  const collect = (rows, kind, countOf) => {
    const seen = new Set()
    for (const row of rows) {
      const key = `${row.userId}:${row.profileId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!row.alarmed) continue
      const good = rows.find((r) => r.userId === row.userId && r.profileId === row.profileId && !r.alarmed)
      alarms.push({
        kind,
        userId: row.userId,
        profileId: row.profileId,
        currentCount: countOf(row),
        lastGoodCount: good ? countOf(good) : null,
        lastGoodAt: good ? good.createdAt : null,
        detectedAt: row.createdAt,
      })
    }
  }
  const where = { accountId: accountId || 'default' }
  collect(await prisma.nuvioCollectionsSnapshot.findMany({ where, orderBy: { createdAt: 'desc' } }), 'collections', (r) => r.collectionCount)
  try {
    collect(await prisma.nuvioHomeLayoutSnapshot.findMany({ where, orderBy: { createdAt: 'desc' } }), 'layout', (r) => r.itemCount)
  } catch { /* table may not exist yet mid-upgrade */ }
  return alarms
}

/** Push the newest good snapshot back to the account. Returns what was restored. */
async function restoreSnapshot(prisma, accountId, userId, profileId, provider) {
  const { newestGood } = await latestSnapshots(prisma, userId, profileId)
  if (!newestGood) throw new Error('No good snapshot exists to restore from')
  let collections
  try { collections = JSON.parse(newestGood.dataJson) } catch { throw new Error('Stored snapshot is unreadable') }
  await provider.setCollections(profileId, collections)
  // The restore is our own write - baseline it, which also retires the alarm.
  await saveSnapshot(prisma, accountId, userId, profileId, collections, false)
  return { restoredCount: Array.isArray(collections) ? collections.length : 0, from: newestGood.createdAt }
}

/** Adopt whatever is on the account right now as the new baseline. */
async function acceptCurrent(prisma, accountId, userId, profileId, provider) {
  const collections = await provider.getCollections(profileId)
  await saveSnapshot(prisma, accountId, userId, profileId, Array.isArray(collections) ? collections : [], false)
  return { acceptedCount: Array.isArray(collections) ? collections.length : 0 }
}

let timer = null

async function runGuardPass(prisma, { createProvider, decrypt }) {
  let users
  try {
    users = await prisma.user.findMany({
      where: { providerType: 'nuvio', isActive: true, nuvioRefreshToken: { not: null } },
      select: { id: true, accountId: true, username: true, providerType: true, stremioAuthKey: true, nuvioRefreshToken: true, nuvioUserId: true },
    })
  } catch (e) {
    // Table may not exist yet on an instance mid-upgrade - never crash the scheduler.
    console.warn('[CollectionsGuard] pass skipped:', e?.message)
    return
  }
  for (const user of users) {
    try {
      // Synthetic req, same shape syncGuardian uses for headless provider
      // work - public mode's per-account decryption reads appAccountId off it.
      const req = { appAccountId: user.accountId, headers: {}, body: {} }
      const provider = createProvider(user, { decrypt, req })
      if (!provider?.getCollections) continue
      await checkUser(prisma, user.accountId, user, provider)
    } catch (e) {
      console.warn(`[CollectionsGuard] check failed for user ${user.id}:`, e?.message)
    }
  }
}

function scheduleCollectionsGuard(prisma, deps) {
  if (timer) { clearInterval(timer); timer = null }
  setTimeout(() => runGuardPass(prisma, deps).catch(() => {}), BOOT_DELAY_MS)
  timer = setInterval(() => runGuardPass(prisma, deps).catch(() => {}), GUARD_INTERVAL_MS)
}

module.exports = {
  scheduleCollectionsGuard, runGuardPass, recordOwnWrite, getAlarms, restoreSnapshot, acceptCurrent,
  restoreLayoutSnapshot, acceptLayoutCurrent, copyLayout,
}
