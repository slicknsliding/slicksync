// Sync utilities: factories for user and group sync-status helpers

/**
 * Get addons from the user's provider (Stremio or Nuvio)
 */
async function getUserAddons(user, req, { decrypt, StremioAPIClient, createProvider }) {
  // Provider path: routes to Stremio or Nuvio based on user.providerType.
  // Providers return collection shape ({ addons: [...] }) which callers already handle.
  if (createProvider) {
    try {
      const provider = createProvider(user, { decrypt, req })
      if (!provider) {
        return { success: false, addons: [], error: 'User not connected to a provider' }
      }
      const result = await provider.getAddons()
      return { success: true, addons: result, error: null }
    } catch (error) {
      return { success: false, addons: [], error: error.message || 'Failed to fetch addons' }
    }
  }

  // Legacy path: direct StremioAPIClient usage (backward compat if no factory injected)
  if (!user.stremioAuthKey) {
    return { success: false, addons: [], error: 'User not connected to Stremio' }
  }

  try {
    const authKeyPlain = decrypt(user.stremioAuthKey, req)
    const apiClient = new StremioAPIClient({ endpoint: 'https://api.strem.io', authKey: authKeyPlain })
    const collection = await apiClient.request('addonCollectionGet', {})

    // CRITICAL FIX: If collection.addons is null (corrupted account), repair it immediately
    // Stremio expects addons to always be an array, never null
    if (collection && collection.addons === null) {
      console.warn('⚠️ Detected corrupted addon collection (addons: null), repairing...')
      try {
        // Repair by clearing addons
        const { clearAddons } = require('./addonHelpers')
        await clearAddons(apiClient)
        // Re-fetch to get the repaired collection
        const repairedCollection = await apiClient.request('addonCollectionGet', {})
        if (repairedCollection && repairedCollection.addons !== null) {
          console.log('✅ Successfully repaired corrupted addon collection')
          // Use the repaired collection
          Object.assign(collection, repairedCollection)
        }
      } catch (repairError) {
        console.error('❌ Failed to repair corrupted addon collection:', repairError)
        // Continue with null handling below
      }
    }

    // Handle the case where collection.addons might be null (empty account) or not an array
    // Use the same logic as /stremio-addons endpoint: try collection.addons first, then fall back to collection itself
    const rawAddons = collection?.addons !== undefined ? collection.addons : collection
    let addonsArray = []
    
    if (rawAddons !== null && rawAddons !== undefined) {
      if (Array.isArray(rawAddons)) {
        addonsArray = rawAddons
      } else if (typeof rawAddons === 'object') {
        // If it's an object (not an array), try to convert it to an array
        addonsArray = Object.values(rawAddons)
      }
    }

    // Ensure addons is always an array in the response (never null)
    const sanitized = {
      ...collection,
      addons: addonsArray.map((addon) => {
        const manifest = addon?.manifest
        if (manifest && typeof manifest === 'object') {
          const { manifestUrl, ...restManifest } = manifest
          return { ...addon, manifest: restManifest, transportName: "" }
        }
        return { ...addon, transportName: "" }
      })
    }

    // Final safety check: ensure addons is always an array
    if (sanitized.addons === null || sanitized.addons === undefined) {
      sanitized.addons = []
    }

    return { success: true, addons: sanitized, error: null }
  } catch (error) {
    return { success: false, addons: [], error: error.message || 'Failed to fetch Stremio addons' }
  }
}

/**
 * Get desired addons for a user (group addons + protected addons from Stremio)
 */
async function getDesiredAddons(user, req, { prisma, getAccountId, decrypt, parseAddonIds, parseProtectedAddons, canonicalizeManifestUrl, StremioAPIClient, createProvider, unsafeMode = false, useCustomFields = true, _prefetchedUserAddons = null }) {
  try {
    // Get group addons
    const groups = await prisma.group.findMany({
      where: {
        accountId: getAccountId(req),
        userIds: {
          contains: user.id
        }
      },
      include: {
        addons: {
          include: {
            addon: true
          }
        }
      }
    })

    const { getGroupAddons } = require('../utils/helpers')
    // groupAddons are returned in collection shape: { transportUrl, transportName, manifest }
    const groupAddons = groups.length > 0 ? await getGroupAddons(prisma, groups[0].id, req) : []

    // Use prefetched user addons if provided, otherwise fetch from Stremio
    // This avoids making duplicate API calls which can return inconsistent results
    let userAddons = []
    if (_prefetchedUserAddons && Array.isArray(_prefetchedUserAddons)) {
      userAddons = _prefetchedUserAddons
    } else {
      // Get user's addons from their provider
      const { success, addons: userAddonsResponse, error } = await getUserAddons(user, req, { decrypt, StremioAPIClient, createProvider })
      if (!success) {
        return { success: false, addons: [], error }
      }
      
      // Extract the addons array from the complete response (collection shape)
      // Ensure we always get an array, even if the response structure is unexpected
      if (Array.isArray(userAddonsResponse)) {
        userAddons = userAddonsResponse
      } else if (userAddonsResponse && typeof userAddonsResponse === 'object') {
        // Handle collection shape: { addons: [...] }
        if (Array.isArray(userAddonsResponse.addons)) {
          userAddons = userAddonsResponse.addons
        }
      }
    }

    // Parse excluded addons (DB addon IDs)
    const excludedAddons = parseAddonIds(user.excludedAddons)
    // Parse protected addons as PLAINTEXT NAMES from DB
    let protectedNames = []
    try {
      protectedNames = user.protectedAddons ? JSON.parse(user.protectedAddons) : []
    } catch {
      protectedNames = []
    }
    
    
    // Include default addons as protected addons (names, only in safe mode)
    const { defaultAddons } = require('../utils/config')
    const normalizeName = (n) => String(n || '').trim().toLowerCase()
    const defaultProtectedNames = unsafeMode ? [] : (defaultAddons.names || [])
    const protectedNameSet = new Set([
      ...protectedNames.map(normalizeName),
      ...defaultProtectedNames.map(normalizeName)
    ])
    

    // Helper function to check if an addon is protected (by name)
    const isProtected = (addon) => {
      const n = addon?.manifest?.name || addon?.transportName || addon?.name
      return n && protectedNameSet.has(normalizeName(n))
    }

    // Parse excluded addons - these are database IDs stored in the database
    const excludedAddonIds = (excludedAddons || []).map(id => String(id).trim()).filter(Boolean)
    const excludedAddonIdSet = new Set(excludedAddonIds)
    
    const groupAddonsFiltered = groupAddons.filter(groupAddon => {
      const addonId = groupAddon?.id
      const isExcluded = addonId && excludedAddonIdSet.has(addonId)
      return !isExcluded
    })
    
    // Strip database fields from filtered group addons for clean JSON
    // Ensure manifest.name and manifest.description match the addon name and description from DB
    const cleanGroupAddons = groupAddonsFiltered.map((addon, index) => {
      const manifestObj = (addon && addon.manifest && typeof addon.manifest === 'object')
        ? { ...addon.manifest }
        : addon?.manifest ? addon.manifest : {}
      
      if (addon && manifestObj && typeof manifestObj === 'object') {
        // Use custom name and description from DB if useCustomFields is enabled
        if (useCustomFields && typeof addon.name === 'string') {
          manifestObj.name = addon.name
        }
        // Update description if useCustomFields is enabled and it exists (even if empty string, preserve it)
        if (useCustomFields && addon.description !== undefined && addon.description !== null) {
          manifestObj.description = addon.description
        }
        // Apply custom logo if it exists (only set logo field, like the original manifest)
        if (addon.customLogo && addon.customLogo.trim()) {
          manifestObj.logo = addon.customLogo.trim()
        }
      }
      
      return {
        transportUrl: addon.transportUrl,
        transportName: addon.transportName,
        manifest: manifestObj
      }
    })

    // 2) Keep only protected addons from userAddons
    // Ensure userAddons is an array before filtering
    const userAddonsArray = Array.isArray(userAddons) ? userAddons : []
    const protectedUserAddons = userAddonsArray.filter(addon => isProtected(addon))

    // Build a protected NAME set from userAddons (normalized)
    const protectedUserNameSet = new Set(
      protectedUserAddons
        .map(a => normalizeName(a?.manifest?.name || a?.transportName || a?.name))
        .filter(Boolean)
    )

    // 3) If an addon is protected and also present in groupAddons, remove it from groupAddons (compare by NAME)
    const nonProtectedGroupAddons = cleanGroupAddons.filter(groupAddon => {
      const n = normalizeName(groupAddon?.manifest?.name || groupAddon?.transportName || groupAddon?.name)
      return n && !protectedUserNameSet.has(n)
    })
    

    // Build locked positions map for protected addons from current Stremio account (by name)
    // IMPORTANT: positions must be taken from the FULL userAddons list
    const lockedByUrl = new Map()
    for (let i = 0; i < userAddons.length; i++) {
      const cur = userAddons[i]
      const name = normalizeName(cur?.manifest?.name || cur?.transportName || cur?.name)
      if (name && isProtected(cur)) {
        lockedByUrl.set(name, i)
      }
    }

    // Start with an array sized to current addons length
    const finalLength = userAddons.length
    const finalDesiredCollection = new Array(finalLength).fill(null)

    // Place protected addons at their original positions
    for (const addon of protectedUserAddons) {
      const name = normalizeName(addon?.manifest?.name || addon?.transportName || addon?.name)
      if (name && lockedByUrl.has(name)) {
        const pos = lockedByUrl.get(name)
        if (pos < finalLength) {
          finalDesiredCollection[pos] = addon
        }
      }
    }

    // Fill remaining positions with non-protected group addons
    let groupAddonIndex = 0
    for (let i = 0; i < finalLength && groupAddonIndex < nonProtectedGroupAddons.length; i++) {
      if (finalDesiredCollection[i] === null) {
        finalDesiredCollection[i] = nonProtectedGroupAddons[groupAddonIndex++]
      }
    }

    // Add any remaining group addons at the end
    while (groupAddonIndex < nonProtectedGroupAddons.length) {
      finalDesiredCollection.push(nonProtectedGroupAddons[groupAddonIndex++])
    }

    // If current is empty (finalLength = 0), ensure we still add all group addons
    if (finalLength === 0 && nonProtectedGroupAddons.length > 0) {
      // When current is empty, just return all non-protected group addons
      return { success: true, addons: nonProtectedGroupAddons, error: null }
    }

    // Remove nulls and return
    const finalDesiredAddons = finalDesiredCollection.filter(Boolean)
    
    return { success: true, addons: finalDesiredAddons, error: null }
  } catch (error) {
    return { success: false, addons: [], error: error.message || 'Failed to get desired addons' }
  }
}

function createGetUserSyncStatus({ prisma, getAccountId, decrypt, parseAddonIds, parseProtectedAddons, getDecryptedManifestUrl, canonicalizeManifestUrl, StremioAPIClient, createProvider }) {
  const normalizeUrl = (u) => {
    try {
      return canonicalizeManifestUrl ? canonicalizeManifestUrl(u) : String(u || '').trim().toLowerCase()
    } catch (e) {
      return String(u || '').trim().toLowerCase()
    }
  }

  return async function getUserSyncStatus(userId, { groupId = undefined, unsafe = false } = {}, req) {
    const user = await prisma.user.findFirst({
      where: { id: userId, accountId: getAccountId(req) },
      select: { id: true, stremioAuthKey: true, isActive: true, excludedAddons: true, protectedAddons: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
    })
    if (!user) return { status: 'error', isSynced: false, message: 'User not found' }
    const hasCredentials = user.stremioAuthKey || (user.nuvioRefreshToken && user.nuvioUserId)
    if (!hasCredentials) return { isSynced: false, status: 'connect', message: 'User not connected to a provider' }

    // Derive unsafe and useCustomFields from DB-backed account sync (single source of truth)
    let useCustomFields = true
    try {
      const acc = await prisma.appAccount.findFirst({ where: { id: getAccountId(req) }, select: { sync: true } })
      let cfg = acc?.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.safe === 'boolean') unsafe = !cfg.safe
        if (typeof cfg.useCustomFields === 'boolean') {
          useCustomFields = cfg.useCustomFields
        } else if (typeof cfg.useCustomNames === 'boolean') {
          // Backward compatibility: migrate old useCustomNames to useCustomFields
          useCustomFields = cfg.useCustomNames
        } else {
          useCustomFields = true
        }
      }
    } catch {}

    // Get user's current addons from their provider
    const { success: userAddonsSuccess, addons: userAddonsResponse, error: userAddonsError } = await getUserAddons(user, req, { decrypt, StremioAPIClient, createProvider })
    if (!userAddonsSuccess) {
      // If the error is related to authentication, treat it as "connect" status
      if (userAddonsError && (
        userAddonsError.includes('Unsupported state or unable to authenticate') ||
        userAddonsError.includes('authentication') ||
        userAddonsError.includes('auth') ||
        userAddonsError.includes('invalid') ||
        userAddonsError.includes('corrupted') ||
        userAddonsError.includes('PROVIDER_AUTH_EXPIRED')
      )) {
        return { isSynced: false, status: 'connect', message: 'Provider connection invalid - please reconnect' }
      }
      return { isSynced: false, status: 'error', message: userAddonsError }
    }
    
    // Extract the addons array from the complete response
    // Ensure we always get an array, even if the response structure is unexpected
    let userAddons = []
    if (Array.isArray(userAddonsResponse)) {
      userAddons = userAddonsResponse
    } else if (userAddonsResponse && typeof userAddonsResponse === 'object') {
      // Handle collection shape: { addons: [...] }
      if (Array.isArray(userAddonsResponse.addons)) {
        userAddons = userAddonsResponse.addons
      }
    }

    // Get desired addons (group addons + protected addons)
    // IMPORTANT: Pass the already-fetched userAddons to avoid making a second Stremio API call
    // Making two separate calls can return different results due to race conditions, causing inconsistent sync status
    const { success: desiredAddonsSuccess, addons: desiredAddons, error: desiredAddonsError } = await getDesiredAddons(user, req, {
      prisma,
      getAccountId,
      decrypt,
      parseAddonIds,
      parseProtectedAddons,
      canonicalizeManifestUrl,
      StremioAPIClient,
      createProvider,
      unsafeMode: unsafe,
      useCustomFields,
      _prefetchedUserAddons: userAddons
    })
    if (!desiredAddonsSuccess) {
      return { isSynced: false, status: 'error', message: desiredAddonsError }
    }

    // Unified comparison using manifest fingerprint (order-sensitive).
    // Nuvio (and other non-Stremio providers) store only URLs — SlickSync controls the
    // URL set — so compare by URL only rather than full manifest content.
    const urlOnly = (user.providerType || 'stremio') !== 'stremio'
    const fingerprint = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly })
    const currentKeys = userAddons.map(fingerprint)
    const desiredKeys = desiredAddons.map(fingerprint)
    // Order-insensitive comparison: sort both key lists first so pure reordering
    // (e.g. user reordered addons in the Stremio app) doesn't falsely report
    // "unsynced" - only an actual difference in the addon set should.
    const sortedCurrent = [...currentKeys].sort()
    const sortedDesired = [...desiredKeys].sort()
    const isSynced = sortedCurrent.length === sortedDesired.length && sortedCurrent.every((k, i) => k === sortedDesired[i])

    return {
      isSynced,
      status: isSynced ? 'synced' : 'unsynced',
      stremioAddonsCount: userAddons.length,
      groupAddonsCount: desiredAddons.length,
      excludedAddons: parseAddonIds(user.excludedAddons),
      protectedAddons: parseProtectedAddons(user.protectedAddons, req),
    }
  }
}

function createGetGroupSyncStatus(deps) {
  const getUserSyncStatus = createGetUserSyncStatus(deps)
  const { prisma, getAccountId } = deps
  return async function getGroupSyncStatus(groupId, req) {
    const group = await prisma.group.findFirst({ where: { id: groupId, accountId: getAccountId(req) } })
    if (!group) return { error: 'Group not found' }
    let userIds = []
    try { userIds = Array.isArray(group.userIds) ? group.userIds : JSON.parse(group.userIds || '[]') } catch {}
    const userStatuses = []
    for (const uid of userIds) {
      try {
        const status = await getUserSyncStatus(uid, { groupId: groupId }, req)
        userStatuses.push({ userId: uid, ...status })
      } catch (e) {
        userStatuses.push({ userId: uid, status: 'error', isSynced: false, message: e?.message || 'Failed' })
      }
    }
    const groupStatus = userStatuses.every(s => s.status === 'synced') ? 'synced' : 'unsynced'
    return { groupStatus, userStatuses }
  }
}

/**
 * Compute a user's sync plan (shared by sync-status and actual sync)
 * Returns: { alreadySynced, current, desired }
 */
async function computeUserSyncPlan(user, req, { prisma, getAccountId, decrypt, parseAddonIds, parseProtectedAddons, canonicalizeManifestUrl, StremioAPIClient, createProvider, unsafeMode = false, useCustomFields = true, useCustomNames = undefined }) {
  // Backward compatibility: support both useCustomFields (new) and useCustomNames (old)
  const useCustomFieldsValue = useCustomFields !== undefined ? useCustomFields : (useCustomNames !== undefined ? useCustomNames : true)
  
  // 1) Current - getUserAddons already has repair logic built in
  const currentRes = await getUserAddons(user, req, { decrypt, StremioAPIClient, createProvider })
  if (!currentRes.success) return { success: false, error: currentRes.error, alreadySynced: false, current: [], desired: [] }
  const current = currentRes.addons?.addons || currentRes.addons || []
  // 2) Desired - pass prefetched current addons to avoid duplicate provider API calls
  const desiredRes = await getDesiredAddons(user, req, { prisma, getAccountId, decrypt, parseAddonIds, parseProtectedAddons, canonicalizeManifestUrl, StremioAPIClient, createProvider, unsafeMode, useCustomFields: useCustomFieldsValue, _prefetchedUserAddons: current })
  if (!desiredRes.success) return { success: false, error: desiredRes.error, alreadySynced: false, current, desired: [] }
  const desired = desiredRes.addons || []
  
  // Ensure desired is always an array, never null
  const safeDesired = Array.isArray(desired) ? desired : []
  // 3) Compare (set + order) using manifest fingerprint; URL-only mode for non-Stremio providers
  const urlOnly = (user.providerType || 'stremio') !== 'stremio'
  const fingerprint = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly })
  const aKeys = current.map(fingerprint)
  const bKeys = desired.map(fingerprint)
  // Order-insensitive, matching getUserSyncStatus's comparison above - a
  // pure reorder (e.g. user reordered addons in the Stremio app) must not
  // count as "not synced" here either, otherwise this function's
  // alreadySynced verdict can disagree with the badge's.
  const sortedA = [...aKeys].sort()
  const sortedB = [...bKeys].sort()
  const alreadySynced = sortedA.length === sortedB.length && sortedA.every((k, i) => k === sortedB[i])
  return { success: true, alreadySynced, current, desired }
}

// Build a stable fingerprint (identity) for an addon entry, used to compare
// a user's current addons against their desired set. Both branches compare
// by ID/URL only, not manifest content - see the comment at the bottom of
// this function for why the Stremio branch also dropped deep manifest
// comparison.
function createManifestFingerprint(canonicalizeManifestUrl, { urlOnly = false } = {}) {
  const normalizeUrl = (u) => {
    try { return canonicalizeManifestUrl ? canonicalizeManifestUrl(u) : String(u || '').trim().toLowerCase() } catch { return String(u || '').trim().toLowerCase() }
  }

  return (addon) => {
    // URL-only mode: canonical URL is the identity (non-Stremio providers)
    if (urlOnly) {
      return normalizeUrl(addon?.transportUrl || addon?.manifestUrl || addon?.url || '')
    }
    // Extract just the addon ID from the URL path (e.g., /stremio/b2341edd-01be-4317-97b0-ba7afb1e1326/...)
    // The URL may contain encrypted tokens that change on each request, so we can't use the full URL
    let url = addon?.transportUrl || addon?.manifestUrl || addon?.url || ''
    try {
      const urlObj = new URL(url)
      const pathParts = urlObj.pathname.split('/').filter(Boolean) // split and remove empty
      // Find the addon ID (UUID format: 8-4-4-4-12)
      const uuidMatch = pathParts.find(part => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(part))
      if (uuidMatch) {
        url = uuidMatch
      } else if (pathParts.length > 0) {
        // Use the last path segment as identifier
        url = pathParts[pathParts.length - 1]
      } else {
        url = normalizeUrl(url)
      }
    } catch {
      url = normalizeUrl(url)
    }
    
    // ID-only identity, same as urlOnly mode above (not a deep manifest diff).
    // A prior version compared the full manifest JSON here, which meant
    // "Synced" for a Stremio user depended on the DB's *cached* manifest
    // copy being byte-identical to what's actually installed - but that
    // cache gets silently refreshed by the background addon health checker
    // (reloadAddon) independent of anything the admin did, flipping the
    // status to "Unsynced" for changes the user never needs to act on.
    // Sync status should answer "does this user have the right set of
    // addons", not "is our manifest cache stale" - the full manifest
    // content is still what actually gets pushed during a real sync, this
    // only affects what counts as already-synced for status/skip purposes.
    return url
  }
}

module.exports = {
  getUserAddons,
  getDesiredAddons,
  createGetUserSyncStatus,
  createGetGroupSyncStatus,
  computeUserSyncPlan,
  createManifestFingerprint,
}


