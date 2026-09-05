// Reading and writing a Nuvio profile's HOME-ROW ARRANGEMENT for the editor.
//
// This is the same synced per-profile blob that nuvioHomePlacement.js writes
// a single row into, and that collectionsGuard.js snapshots - see those
// files for how the shape was established. The short version, all of it
// learned the hard way against a real client:
//
//   - Items are SyncCatalogItem: { addon_id, type, catalog_id, enabled,
//     order, custom_title, collection_id, is_collection } - snake_case, and
//     with NO 'key' field. Push anything else and the client's strict
//     decoder throws on the first bad item and silently discards the ENTIRE
//     blob, taking every other row's arrangement with it.
//   - `order` is GLOBAL across all rows, not per addon.
//   - `custom_title` overrides the row header; blank means the client's own
//     name-plus-type default.
//   - There are three buckets: the client reads its own platform
//     ('mobile'/'desktop') and falls back to 'home_catalog_shared'. An edit
//     is written to every bucket that exists plus the shared one, so it
//     lands wherever a given device happens to look.

const PLATFORMS = ['home_catalog_shared', 'mobile', 'desktop']

function parseBlob(raw) {
  if (!raw) return null
  let v = raw
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
  return v && typeof v === 'object' ? v : null
}

function isValidItem(i) {
  return i && typeof i.addon_id === 'string' && typeof i.catalog_id === 'string'
}

/** Reads every bucket, returning the blobs plus which one has the most rows. */
async function readAllBuckets(provider, profileId) {
  const buckets = {}
  for (const platform of PLATFORMS) {
    try {
      const rows = await provider.getHomeCatalogSettings(profileId, platform)
      const blob = parseBlob(rows?.[0]?.settings_json)
      if (blob) buckets[platform] = blob
    } catch { /* unreadable bucket - treated as absent */ }
  }
  // The richest bucket is the honest source of truth: a device that has
  // never synced leaves an empty blob behind, and editing from that would
  // present an empty home screen as if it were the real arrangement.
  let source = null
  for (const [platform, blob] of Object.entries(buckets)) {
    const n = Array.isArray(blob.items) ? blob.items.filter(isValidItem).length : 0
    if (!source || n > source.count) source = { platform, blob, count: n }
  }
  return { buckets, source }
}

// Addon manifests, fetched from their transport URLs and cached briefly.
// Same approach routes/users.js already uses when enriching Nuvio addons -
// the provider's own addon list carries no catalogs at all.
const manifestCache = new Map()
const MANIFEST_TTL_MS = 10 * 60 * 1000

async function fetchManifest(transportUrl) {
  if (!transportUrl) return null
  const hit = manifestCache.get(transportUrl)
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.value
  const url = transportUrl.endsWith('.json') ? transportUrl : `${transportUrl.replace(/\/$/, '')}/manifest.json`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const json = await res.json()
    manifestCache.set(transportUrl, { value: json, at: Date.now() })
    return json
  } catch {
    // A slow or dead addon just means that row keeps its raw id - never a
    // failure of the whole editor.
    return null
  }
}

/**
 * The editor's view: the arranged rows in order, each labelled with the
 * addon and catalog it belongs to, followed by any catalog the account
 * currently installs that the arrangement has never mentioned.
 */
async function readLayoutForEdit(provider, profileId, liveAddons) {
  const { buckets, source } = await readAllBuckets(provider, profileId)
  const arranged = (Array.isArray(source?.blob?.items) ? source.blob.items : []).filter(isValidItem)

  // addon id -> { name, catalogs: Map(type:catalogId -> catalog name) }
  //
  // Built from each addon's REAL manifest, fetched from its transport URL.
  // That fetch is not optional: Nuvio stores only { url, name } per addon
  // ("urlOnly" sync), so the provider hands back a stub whose `id` is the
  // transport URL and whose `catalogs` array is empty - while the layout
  // blob keys rows by the addon's true manifest id ("aio-metadata"). Those
  // two can never match, which is why every row previously showed a raw
  // catalog id and claimed the addon wasn't installed.
  const addonList = Array.isArray(liveAddons)
    ? liveAddons
    : (Array.isArray(liveAddons?.addons) ? liveAddons.addons : [])
  const manifests = await Promise.all(addonList.map((a) => fetchManifest(a?.transportUrl)))
  const byAddon = new Map()
  addonList.forEach((addon, i) => {
    // Prefer the fetched manifest; fall back to whatever the provider gave.
    const manifest = manifests[i] || addon?.manifest || addon
    const addonId = manifest?.id
    if (!addonId) return
    const catalogs = new Map()
    for (const c of Array.isArray(manifest?.catalogs) ? manifest.catalogs : []) {
      if (c?.id) catalogs.set(`${c.type}:${c.id}`, c.name || c.id)
    }
    byAddon.set(addonId, { name: manifest?.name || addon?.transportName || addonId, catalogs })
  })

  const label = (item) => {
    const addon = byAddon.get(item.addon_id)
    return {
      addonName: addon?.name || item.addon_id,
      catalogName: addon?.catalogs?.get(`${item.type}:${item.catalog_id}`) || item.catalog_id,
      // A row whose addon is no longer installed still renders in the editor
      // (removing it is a decision, not something to do behind their back).
      orphaned: !addon,
    }
  }

  const seen = new Set(arranged.map((i) => `${i.addon_id}:${i.type}:${i.catalog_id}`))
  const items = arranged
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map((i) => ({
      addon_id: i.addon_id,
      type: i.type,
      catalog_id: i.catalog_id,
      enabled: i.enabled !== false,
      custom_title: typeof i.custom_title === 'string' ? i.custom_title : '',
      collection_id: typeof i.collection_id === 'string' ? i.collection_id : '',
      is_collection: i.is_collection === true,
      arranged: true,
      ...label(i),
    }))

  const unarranged = []
  for (const [addonId, addon] of byAddon.entries()) {
    for (const [key, name] of addon.catalogs.entries()) {
      const [type, catalogId] = key.split(':')
      if (seen.has(`${addonId}:${type}:${catalogId}`)) continue
      unarranged.push({
        addon_id: addonId, type, catalog_id: catalogId,
        enabled: true, custom_title: '', collection_id: '', is_collection: false,
        arranged: false, addonName: addon.name, catalogName: name, orphaned: false,
      })
    }
  }

  return {
    items,
    unarranged,
    sourcePlatform: source?.platform || null,
    buckets: Object.keys(buckets),
    hideCatalogUnderline: source?.blob?.hide_catalog_underline === true,
    hideUnreleasedContent: source?.blob?.hide_unreleased_content === true,
  }
}

/**
 * Writes the edited arrangement. The incoming array's ORDER is the truth -
 * `order` is renumbered 0..n from it, so the UI never has to compute the
 * global ordering itself. Every item is rebuilt field-by-field into the
 * exact SyncCatalogItem shape rather than spread from the request, because
 * one stray field is enough for the client to discard the whole blob.
 */
async function writeLayout(provider, profileId, items) {
  const clean = []
  items.forEach((raw, index) => {
    if (!isValidItem(raw)) return
    clean.push({
      addon_id: String(raw.addon_id),
      type: String(raw.type || 'movie'),
      catalog_id: String(raw.catalog_id),
      enabled: raw.enabled !== false,
      order: index,
      custom_title: typeof raw.custom_title === 'string' ? raw.custom_title.slice(0, 200) : '',
      collection_id: typeof raw.collection_id === 'string' ? raw.collection_id : '',
      is_collection: raw.is_collection === true,
    })
  })
  if (clean.length === 0) throw new Error('Refusing to write an empty home layout')

  const { buckets } = await readAllBuckets(provider, profileId)
  // Write to every bucket that exists, and always seed the shared one, so
  // the edit reaches whichever bucket a given device reads.
  const targets = new Set([...Object.keys(buckets), 'home_catalog_shared'])
  let written = 0
  for (const platform of targets) {
    const existing = buckets[platform] || {}
    await provider.pushHomeCatalogSettings(profileId, platform, {
      ...existing,
      items: clean,
      hide_catalog_underline: existing.hide_catalog_underline === true,
      hide_unreleased_content: existing.hide_unreleased_content === true,
    })
    written++
  }
  return { rows: clean.length, buckets: written }
}

module.exports = { readLayoutForEdit, writeLayout, readAllBuckets }
