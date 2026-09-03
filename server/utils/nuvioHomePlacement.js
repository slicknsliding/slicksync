// Nuvio home-row placement for the SlickTrax Continue Watching row.
//
// Nuvio's home screen order and row titles are NOT protocol-driven - they
// live in per-profile "home catalog settings" synced through the same
// Supabase backend the collections ride (RPCs sync_pull/push_home_catalog_
// settings; confirmed by disassembling the desktop client's
// HomeCatalogSettingsSyncService/StoredHomeCatalogPreference). Each row has
// a preference { key, customTitle, enabled, heroSourceEnabled, order }:
//  - key       = `${manifest.id}:${catalog.type}:${catalog.id}`
//  - order     = position (a NEW key gets appended last - which is exactly
//                why the merged Continue Watching row sank to the bottom)
//  - customTitle = display override (blank -> the client's own
//                name-plus-type default, e.g. "Continue Watching All")
//
// So instead of fighting the protocol, SlickSync writes the preference the
// user would have had to create by hand: our row's key, order above every
// existing row, customTitle "Continue Watching". Written ONCE per key -
// if a preference for the key already exists (including one the client
// auto-created, or one the user has since moved), it is left alone: the
// human's arrangement always wins over ours.
//
// Platforms: the client reads its own platform blob ('mobile'/'desktop')
// and falls back to 'home_catalog_shared'. Every existing blob gets the
// upsert; the shared blob is created when nothing exists at all.

const PLATFORMS = ['home_catalog_shared', 'mobile', 'desktop']

// Once per user per process - syncs run often, and the skip-if-present
// check inside still makes repeats harmless, just not free.
const placedThisBoot = new Set()

function parseSettings(raw) {
  if (!raw) return null
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  return v && typeof v === 'object' ? v : null
}

async function ensureTraxHomePlacement(provider, user, catalogKey) {
  if (!provider?.getHomeCatalogSettings || !provider?.pushHomeCatalogSettings) return
  if (placedThisBoot.has(user.id)) return
  placedThisBoot.add(user.id)

  // catalogKey is `<addonId>:<type>:<catalogId>` - split into the fields the
  // REAL sync item schema uses. Learned the hard way: items are
  // SyncCatalogItem { addon_id, type, catalog_id, enabled, order,
  // custom_title, collection_id, is_collection } (snake_case, no 'key'
  // field), confirmed against a client-written blob. The first version
  // pushed stored-preference-shaped items instead; the client's strict
  // decoder throws on the first malformed item and silently discards the
  // ENTIRE blob - so those writes didn't just fail to place the row, they
  // poisoned arrangement sync for every row until repaired here.
  const [addonId, catalogType, catalogId] = (() => {
    const parts = String(catalogKey).split(':')
    return [parts.slice(0, -2).join(':'), parts[parts.length - 2], parts[parts.length - 1]]
  })()

  let profiles = []
  try {
    profiles = await provider.getProfiles()
  } catch { return }

  for (const profile of profiles) {
    const profileId = profile?.profile_index
    if (!Number.isInteger(profileId)) continue

    let anyBlobSeen = false
    for (const platform of PLATFORMS) {
      let rows
      try {
        rows = await provider.getHomeCatalogSettings(profileId, platform)
      } catch { continue }
      const settings = parseSettings(rows?.[0]?.settings_json)
      if (!settings) continue
      anyBlobSeen = true

      // Repair: drop every malformed item (anything without addon_id -
      // that's the poison from the first version of this file).
      const items = (Array.isArray(settings.items) ? settings.items : []).filter((i) => i && typeof i.addon_id === 'string')

      const ours = items.find((i) => i.addon_id === addonId && i.catalog_id === catalogId)
      if (ours && ours.custom_title === 'Continue Watching') {
        // Already placed by us on a previous pass - if the human has moved
        // it since, that arrangement is theirs to keep.
        if ((Array.isArray(settings.items) ? settings.items.length : 0) === items.length) continue
        // (Malformed leftovers still need purging even when ours is fine.)
        try {
          await provider.pushHomeCatalogSettings(profileId, platform, { ...settings, items })
        } catch (e) { console.warn('[NuvioHomePlacement] repair push failed:', e?.message) }
        continue
      }

      const others = items.filter((i) => !(i.addon_id === addonId && i.catalog_id === catalogId))
      // Placed at the HEAD OF ITS OWN ADDON'S GROUP, not the global top -
      // order min-1 put the row 28 slots above its family (Watchlist, the
      // user's packs), which read as lost, not promoted (user feedback).
      // Target = the lowest order among the addon's OTHER rows; everything
      // at or after that slot shifts down one to make room.
      const siblingOrders = others.filter((i) => i.addon_id === addonId).map((i) => (Number.isFinite(i?.order) ? i.order : 0))
      const target = siblingOrders.length > 0
        ? Math.min(...siblingOrders)
        : others.reduce((m, i) => (Number.isFinite(i?.order) && i.order > m ? i.order : m), -1) + 1 // no siblings yet - append
      const shifted = others.map((i) => (Number.isFinite(i?.order) && i.order >= target ? { ...i, order: i.order + 1 } : i))
      const placed = {
        addon_id: addonId,
        type: catalogType,
        catalog_id: catalogId,
        enabled: true,
        order: target,
        custom_title: 'Continue Watching',
        collection_id: '',
        is_collection: false,
      }
      try {
        await provider.pushHomeCatalogSettings(profileId, platform, { ...settings, items: [placed, ...shifted] })
        console.log(`[NuvioHomePlacement] Continue Watching placed at the head of its group (profile ${profileId}, ${platform})`)
      } catch (e) {
        console.warn('[NuvioHomePlacement] push failed:', e?.message)
      }
    }

    if (!anyBlobSeen) {
      // Nothing synced for this profile yet: seed the shared bucket in the
      // client's own observed top-level shape.
      try {
        await provider.pushHomeCatalogSettings(profileId, 'home_catalog_shared', {
          items: [{
            addon_id: addonId, type: catalogType, catalog_id: catalogId,
            enabled: true, order: 0, custom_title: 'Continue Watching',
            collection_id: '', is_collection: false,
          }],
          hide_catalog_underline: false,
          hide_unreleased_content: false,
        })
        console.log(`[NuvioHomePlacement] seeded shared settings (profile ${profileId})`)
      } catch (e) {
        console.warn('[NuvioHomePlacement] seed failed:', e?.message)
      }
    }
  }
}

module.exports = { ensureTraxHomePlacement }
