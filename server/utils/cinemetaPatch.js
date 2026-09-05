/**
 * Patching Cinemeta.
 *
 * Cinemeta is the default metadata addon every Stremio and Nuvio account
 * ships with, and it is not always wanted in full: its catalogs occupy the
 * top of the home screen, its search results compete with better sources,
 * and its metadata overrides addons people installed specifically to replace
 * it. Doing anything about that has meant a separate tool.
 *
 * There is no special API for this - the "patch" is simply the account's own
 * Cinemeta entry with parts of its manifest removed, written back through
 * the same addon-collection write every sync already uses. Both providers
 * store the manifest alongside the transport URL, so the same edit works for
 * Stremio and Nuvio.
 *
 * The original manifest is kept verbatim before the first patch. Reset
 * restores THAT, rather than rebuilding what Cinemeta's manifest probably
 * looked like - it is someone else's addon and its shape is theirs to
 * change.
 */

// Cinemeta identifies itself consistently across both providers; matching on
// the id first and the URL second avoids depending on a display name a user
// can rename.
const CINEMETA_ID = 'com.linvo.cinemeta'
const CINEMETA_URL_MARKER = 'cinemeta'

function isCinemeta(addon) {
  const id = addon?.manifest?.id || ''
  if (id === CINEMETA_ID) return true
  const url = addon?.transportUrl || addon?.manifestUrl || addon?.url || ''
  return CINEMETA_URL_MARKER.length > 0 && url.toLowerCase().includes(CINEMETA_URL_MARKER)
}

function findCinemeta(addons) {
  const list = Array.isArray(addons) ? addons : (addons?.addons || [])
  const index = list.findIndex(isCinemeta)
  return { list, index, addon: index >= 0 ? list[index] : null }
}

/**
 * Applies the requested removals to a manifest, returning a new one.
 *
 * Search is not a resource in its own right - it is an `extra` on a catalog
 * ("search"), which is why removing search means editing catalogs rather
 * than the resources array. Removing catalogs entirely therefore also
 * removes search, and the two toggles stay independent by design: someone
 * may want Cinemeta's catalogs on the home screen but not its search
 * results.
 */
function applyPatch(originalManifest, patch) {
  const manifest = JSON.parse(JSON.stringify(originalManifest || {}))

  if (patch.removeCatalogs) {
    manifest.catalogs = []
  } else if (patch.removeSearch && Array.isArray(manifest.catalogs)) {
    manifest.catalogs = manifest.catalogs.map((c) => {
      const clone = { ...c }
      if (Array.isArray(clone.extra)) {
        clone.extra = clone.extra.filter((e) => (e?.name || e) !== 'search')
      }
      if (Array.isArray(clone.extraSupported)) {
        clone.extraSupported = clone.extraSupported.filter((e) => e !== 'search')
      }
      if (Array.isArray(clone.extraRequired)) {
        clone.extraRequired = clone.extraRequired.filter((e) => e !== 'search')
      }
      return clone
    })
  }

  if (patch.removeMeta && Array.isArray(manifest.resources)) {
    manifest.resources = manifest.resources.filter((r) => {
      const name = typeof r === 'string' ? r : (r && (r.name || r.type))
      return name !== 'meta'
    })
  }

  // A manifest that declares catalogs while claiming no catalog resource is
  // internally inconsistent, and clients handle that inconsistently. Keep
  // the two in step.
  if (Array.isArray(manifest.resources) && Array.isArray(manifest.catalogs) && manifest.catalogs.length === 0) {
    manifest.resources = manifest.resources.filter((r) => {
      const name = typeof r === 'string' ? r : (r && (r.name || r.type))
      return name !== 'catalog'
    })
  }

  return manifest
}

/** What a patch has actually removed, for the UI to read back. */
function describePatch(patch) {
  const parts = []
  if (patch?.removeSearch) parts.push('search')
  if (patch?.removeCatalogs) parts.push('catalogs')
  if (patch?.removeMeta) parts.push('metadata')
  return parts.length === 0 ? 'nothing removed' : `${parts.join(', ')} removed`
}

module.exports = { isCinemeta, findCinemeta, applyPatch, describePatch, CINEMETA_ID }
