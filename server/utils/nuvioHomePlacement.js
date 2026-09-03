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

  let profiles = []
  try {
    profiles = await provider.getProfiles()
  } catch { return }

  for (const profile of profiles) {
    const profileId = profile?.profile_index
    if (!Number.isInteger(profileId)) continue

    // Read every bucket first. The platform list [mobile, desktop] is
    // literally named LEGACY_SYNC_PLATFORMS in the client - older builds
    // read ONLY their own platform blob and never the shared bucket
    // (confirmed live: shared carried the preference, the phone's own
    // 'mobile' bucket was empty, and the phone "preserved local" forever).
    // So the preference must exist in EVERY bucket, with missing ones
    // seeded from the richest existing blob so no arrangement is lost.
    const blobs = {}
    for (const platform of PLATFORMS) {
      try {
        const rows = await provider.getHomeCatalogSettings(profileId, platform)
        blobs[platform] = parseSettings(rows?.[0]?.settings_json)
      } catch {
        blobs[platform] = undefined // pull failed - do not blindly overwrite
      }
    }
    const richest = PLATFORMS.map((pf) => blobs[pf]).filter(Boolean)
      .sort((a, b) => (Array.isArray(b.items) ? b.items.length : 0) - (Array.isArray(a.items) ? a.items.length : 0))[0] || null

    for (const platform of PLATFORMS) {
      if (blobs[platform] === undefined) continue // unreadable - leave alone
      const base = blobs[platform] || richest || { show_catalog_type: true, hide_unreleased_content: false, items: [] }
      const items = Array.isArray(base.items) ? base.items : []
      if (blobs[platform] && items.some((i) => i && i.key === catalogKey)) continue // human's row, human's order

      const minOrder = items.reduce((m, i) => (Number.isFinite(i?.order) && i.order < m ? i.order : m), 0)
      const next = {
        ...base,
        items: items.some((i) => i && i.key === catalogKey)
          ? items
          : [
              { key: catalogKey, customTitle: 'Continue Watching', enabled: true, heroSourceEnabled: false, order: minOrder - 1 },
              ...items,
            ],
      }
      try {
        await provider.pushHomeCatalogSettings(profileId, platform, next)
        console.log(`[NuvioHomePlacement] Continue Watching placed on top (profile ${profileId}, ${platform})`)
      } catch (e) {
        console.warn('[NuvioHomePlacement] push failed:', e?.message)
      }
    }
  }
}

module.exports = { ensureTraxHomePlacement }
