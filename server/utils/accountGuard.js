// Account Guard - detects when a provider account's addon set is changed by
// something OTHER than SlickSync.
//
// The problem this solves is real and recurred twice before it had a name:
// users reverting to "Unsynced" hours after a clean sync, and Nuvio
// collections vanishing - both eventually diagnosed, manually and slowly, as
// ANOTHER logged-in client overwriting the account (last-write-wins). SlickSync
// could see the drift ("unsynced") but not the crucial fact that it wasn't the
// admin's own doing, so every incident started as a suspected SlickSync bug.
//
// Mechanism: every deliberate SlickSync write to an account's addon collection
// records a fingerprint of what it wrote (the "asserted" state, per provider).
// A periodic sweep re-fetches each connected user's live collection and
// compares. Three outcomes:
//   - matches asserted           -> quiet (and clears any stale alarm)
//   - no asserted state recorded -> adopt silently (first sight = baseline;
//                                    alerting on day one would cry wolf for
//                                    every existing install)
//   - differs from asserted      -> external writer. Record the diff, alert
//                                    ONCE per distinct foreign state (bell
//                                    always, push when configured), and keep
//                                    the old baseline so the operator decides:
//                                    re-assert (sync) or accept (adopt).
//
// What this is NOT: it never writes to the provider account on its own. The
// scheduled sync already re-asserts on its own cadence when enabled; the
// guard's job is only to make the foreign write VISIBLE before something
// silently stomps it (or before it silently stomps the sync).
//
// The fingerprint deliberately reuses createManifestFingerprint from sync.js
// with the same urlOnly rule and order-insensitive sorting as sync status -
// if the two ever disagreed, the guard would alert on states sync calls
// "synced" (or vice versa), and that inconsistency would be worse than no
// guard at all.

const crypto = require('crypto')

const BETWEEN_USERS_MS = 250 // gentle on provider APIs when sweeping many users

function parseGuardState(raw) {
  if (!raw) return {}
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function describeAddon(a) {
  return {
    url: a?.transportUrl || a?.manifestUrl || a?.url || '',
    name: a?.manifest?.name || a?.transportName || a?.name || '',
  }
}

function computeFingerprint(addons, providerType) {
  const { canonicalizeManifestUrl } = require('./validation')
  const { createManifestFingerprint } = require('./sync')
  const urlOnly = (providerType || 'stremio') !== 'stremio'
  const fp = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly })
  const keys = (Array.isArray(addons) ? addons : []).map(fp).sort()
  const hash = crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16)
  return { keys, hash }
}

/**
 * Record what SlickSync just wrote to (or confirmed on) a provider account.
 * Called from every deliberate collection write. Clears any standing external
 * alarm for that provider - a fresh SlickSync write IS the resolution.
 * Best-effort by design: a guard bookkeeping failure must never fail a sync.
 */
async function recordAssertedState(prisma, userId, providerType, addons) {
  try {
    const user = await prisma.user.findFirst({ where: { id: userId }, select: { guardStateJson: true } })
    if (!user) return
    const state = parseGuardState(user.guardStateJson)
    const provider = providerType || 'stremio'
    const { keys, hash } = computeFingerprint(addons, provider)
    state.byProvider = state.byProvider || {}
    state.byProvider[provider] = {
      keys,
      hash,
      addons: (Array.isArray(addons) ? addons : []).map(describeAddon),
      assertedAt: new Date().toISOString(),
    }
    if (state.external && state.external.provider === provider) delete state.external
    await prisma.user.update({ where: { id: userId }, data: { guardStateJson: JSON.stringify(state) } })
  } catch (e) {
    console.warn('[AccountGuard] recordAssertedState failed:', e?.message)
  }
}

/**
 * Adopt the account's CURRENT live state as the new baseline and clear the
 * alarm - the operator saying "that outside change was fine, keep it".
 * Returns false when there was nothing to accept.
 */
async function acceptExternalState(prisma, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { guardStateJson: true } })
  if (!user) return false
  const state = parseGuardState(user.guardStateJson)
  const ext = state.external
  if (!ext) return false
  state.byProvider = state.byProvider || {}
  state.byProvider[ext.provider] = {
    keys: ext.currentKeys || [],
    hash: ext.currentHash || '',
    addons: ext.currentAddons || [],
    assertedAt: new Date().toISOString(),
  }
  delete state.external
  await prisma.user.update({ where: { id: userId }, data: { guardStateJson: JSON.stringify(state) } })
  return true
}

/** Compact summary for API payloads - null when no standing alarm. */
function summarizeExternal(guardStateJson) {
  const state = parseGuardState(guardStateJson)
  const ext = state.external
  if (!ext) return null
  return {
    provider: ext.provider,
    detectedAt: ext.detectedAt,
    added: ext.added || [],
    removed: ext.removed || [],
  }
}

/**
 * Check one user's live collection against the asserted baseline.
 * Returns { verdict, liveAddons, external }: verdict is one of 'alerted' |
 * 'changed-silent' | 'match' | 'adopted' | 'skipped'; liveAddons is the
 * fetched collection (so the caller can reuse it - the Sync Guardian passes
 * it straight into getUserSyncStatus, one provider call serving both);
 * external is the standing alarm after this check, or null.
 */
async function checkUser(prisma, user, req, deps, { prefetchedAddons = null } = {}) {
  const { decrypt, StremioAPIClient, createProvider } = deps
  const { canonicalizeManifestUrl } = require('./validation')
  const provider = user.providerType || 'stremio'
  const state = parseGuardState(user.guardStateJson)
  const asserted = state.byProvider?.[provider]

  let live = prefetchedAddons
  if (!Array.isArray(live)) {
    const { getUserAddons } = require('./sync')
    const result = await getUserAddons(user, req, { decrypt, StremioAPIClient, createProvider })
    if (!result.success) return { verdict: 'skipped', liveAddons: null, external: null }
    live = result.addons
    if (live && !Array.isArray(live) && Array.isArray(live.addons)) live = live.addons
  }
  if (!Array.isArray(live)) return { verdict: 'skipped', liveAddons: null, external: null }

  const { keys: currentKeys, hash: currentHash } = computeFingerprint(live, provider)
  const currentAddons = live.map(describeAddon)

  // First sight: adopt quietly as the baseline.
  if (!asserted) {
    state.byProvider = state.byProvider || {}
    state.byProvider[provider] = { keys: currentKeys, hash: currentHash, addons: currentAddons, assertedAt: new Date().toISOString() }
    await prisma.user.update({ where: { id: user.id }, data: { guardStateJson: JSON.stringify(state) } })
    return { verdict: 'adopted', liveAddons: live, external: null }
  }

  if (currentHash === asserted.hash) {
    // Back in line (either it never left, or a foreign change was reverted).
    if (state.external && state.external.provider === provider) {
      delete state.external
      await prisma.user.update({ where: { id: user.id }, data: { guardStateJson: JSON.stringify(state) } })
    }
    return { verdict: 'match', liveAddons: live, external: null }
  }

  // Foreign state. Diff against the baseline for the human-readable alert.
  const assertedKeySet = new Set(asserted.keys || [])
  const currentKeySet = new Set(currentKeys)
  let added = []
  let removed = []
  try {
    const { createManifestFingerprint } = require('./sync')
    const fp = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly: provider !== 'stremio' })
    const byKey = new Map()
    // Baseline stores {url,name} - rebuild enough of an addon shape for the
    // fingerprint so removed entries can be identified by key.
    for (const a of asserted.addons || []) {
      const key = fp({ transportUrl: a.url, manifest: { name: a.name } })
      if (!byKey.has(key)) byKey.set(key, a)
    }
    for (const a of live) {
      const key = fp(a)
      if (!byKey.has(key)) byKey.set(key, describeAddon(a))
    }
    added = currentKeys.filter((k) => !assertedKeySet.has(k)).map((k) => byKey.get(k) || { url: '', name: '(unknown)' })
    removed = (asserted.keys || []).filter((k) => !currentKeySet.has(k)).map((k) => byKey.get(k) || { url: '', name: '(unknown)' })
  } catch { /* diff is display sugar - detection stands without it */ }

  const alreadyAlerted = state.external && state.external.provider === provider && state.external.currentHash === currentHash
  state.external = {
    provider,
    detectedAt: alreadyAlerted ? state.external.detectedAt : new Date().toISOString(),
    currentHash,
    currentKeys,
    currentAddons,
    added,
    removed,
  }
  await prisma.user.update({ where: { id: user.id }, data: { guardStateJson: JSON.stringify(state) } })
  return { verdict: alreadyAlerted ? 'changed-silent' : 'alerted', liveAddons: live, external: state.external }
}

async function dispatchAlert(prisma, accountId, user, state) {
  const ext = state
  const parts = []
  if (ext.added?.length) parts.push(`${ext.added.length} addon${ext.added.length === 1 ? '' : 's'} added`)
  if (ext.removed?.length) parts.push(`${ext.removed.length} removed`)
  const providerName = ext.provider === 'nuvio' ? 'Nuvio' : 'Stremio'
  const title = `${user.username}'s ${providerName} account was changed outside SlickSync`
  const body = `${parts.join(', ') || 'The addon set changed'} - most likely another logged-in session. Open the user to re-assert SlickSync's setup or accept the change.`
  const url = `/users/${user.id}`
  try {
    const { createNotification } = require('./notificationStore')
    // Bell always - a foreign write to a managed account is never noise.
    // dedupeKey makes re-detection across restarts idempotent.
    await createNotification(prisma, accountId, {
      type: 'sync',
      title,
      body,
      url,
      dedupeKey: `guard:${user.id}:${ext.currentHash}`,
    })
  } catch (e) {
    console.warn('[AccountGuard] bell dispatch failed:', e?.message)
  }
  try {
    const { isPushEnabled, sendPushToAccount } = require('./pushNotifications')
    if (isPushEnabled()) {
      await sendPushToAccount(prisma, accountId, { title, body, url })
    }
  } catch (e) {
    console.warn('[AccountGuard] push dispatch failed:', e?.message)
  }
}

/**
 * One detection pass. Sweeps every account by default (the scheduled path);
 * pass onlyAccountId to scope it to one account (the manual "check now"
 * route - on a public instance one tenant must never trigger provider API
 * calls for everyone else's users).
 */
async function runGuardSweep(prisma, deps, { onlyAccountId = null } = {}) {
  const accounts = onlyAccountId
    ? [{ id: onlyAccountId }]
    : await prisma.appAccount.findMany({ select: { id: true } })
  const summary = { checked: 0, alerted: 0, adopted: 0, skipped: 0 }
  for (const account of accounts) {
    const req = { appAccountId: account.id }
    const users = await prisma.user.findMany({
      where: {
        accountId: account.id,
        isActive: true,
        OR: [{ stremioAuthKey: { not: null } }, { nuvioRefreshToken: { not: null } }],
      },
      select: {
        id: true, username: true, guardStateJson: true, providerType: true,
        stremioAuthKey: true, nuvioRefreshToken: true, nuvioUserId: true,
        isActive: true, excludedAddons: true, protectedAddons: true, accountId: true,
      },
    })
    for (const user of users) {
      try {
        const { verdict, external } = await checkUser(prisma, user, req, deps)
        summary.checked++
        if (verdict === 'alerted') {
          summary.alerted++
          if (external) await dispatchAlert(prisma, account.id, user, external)
        } else if (verdict === 'adopted') summary.adopted++
        else if (verdict === 'skipped') summary.skipped++
      } catch (e) {
        summary.skipped++
        console.warn(`[AccountGuard] check failed for ${user.username}:`, e?.message)
      }
      await new Promise((r) => setTimeout(r, BETWEEN_USERS_MS))
    }
  }
  return summary
}

// No scheduler of its own: detection runs inside the Sync Guardian's
// 5-minute loop (see syncGuardian.js), reusing its per-user provider fetch -
// a second poller here would double both the API calls and the alerts.
module.exports = {
  recordAssertedState,
  acceptExternalState,
  summarizeExternal,
  checkUser,
  dispatchAlert,
  runGuardSweep,
}
