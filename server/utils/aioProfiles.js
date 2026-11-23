// The people in an AIOStreams configuration, in either of the two shapes
// AIOStreams has kept them in:
//
//   up to 2.38      config.jellyfin.primary (the owner) and
//                   config.jellyfin.personas (everyone else)
//   from Nov 2026   config.profiles, the owner first with id '', then everyone
//                   else (same ids, names, PINs, variants, trackers...)
//
// AIOStreams converts the old shape to the new one on every read and on every
// save, and when `profiles` is already there it throws the old fields away
// without a word. So a change has to go back in the shape the configuration
// was read in: anything added to jellyfin.personas next to a `profiles` list is
// lost. A configuration with nobody in it reads with neither; the old fields
// are fine then, AIOStreams converts them when it saves.
//
// The Jellyfin user ids are the same in both: the owner's is the config uuid,
// everyone else's comes from their id (aioHousehold.personaUserId).

const OWNER_ID = ''

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function usesProfiles(config) {
  return Array.isArray(config?.profiles)
}

/** Everyone but the owner, as the objects in the configuration (edit them in place). */
function othersOf(config) {
  if (usesProfiles(config)) return config.profiles.filter((p) => isObj(p) && p.id !== OWNER_ID)
  return Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas.filter(isObj) : []
}

/** The owner's object, or null. With create, one is made (empty) when there is none. */
function ownerOf(config, { create = false } = {}) {
  if (usesProfiles(config)) {
    let owner = config.profiles.find((p) => isObj(p) && p.id === OWNER_ID) || null
    if (!owner && create) {
      owner = { id: OWNER_ID }
      config.profiles.unshift(owner)
    }
    return owner
  }
  if (isObj(config?.jellyfin?.primary)) return config.jellyfin.primary
  if (!create) return null
  if (!isObj(config.jellyfin)) config.jellyfin = {}
  config.jellyfin.primary = {}
  return config.jellyfin.primary
}

/** Add someone after everyone else. */
function addOther(config, person) {
  if (usesProfiles(config)) {
    config.profiles.push(person)
    return
  }
  if (!isObj(config.jellyfin)) config.jellyfin = {}
  config.jellyfin.personas = [...othersOf(config), person]
}

/** Take away an owner entry that holds nothing, so a write leaves none behind. */
function tidyOwner(config) {
  if (usesProfiles(config)) {
    config.profiles = config.profiles.filter((p) => !(isObj(p) && p.id === OWNER_ID && Object.keys(p).length === 1))
    return
  }
  const j = config?.jellyfin
  if (isObj(j?.primary) && !Object.keys(j.primary).length) delete j.primary
}

/**
 * The configuration in the old shape, for comparing versions: an AIOStreams
 * switching shapes changes nothing anyone set, so it must not look like a
 * change. Never written back.
 */
function inOldShape(config) {
  if (!usesProfiles(config)) return config
  const { profiles, ...rest } = config
  const owner = profiles.find((p) => isObj(p) && p.id === OWNER_ID)
  const others = profiles.filter((p) => isObj(p) && p.id !== OWNER_ID)
  const jellyfin = isObj(rest.jellyfin) ? { ...rest.jellyfin } : {}
  if (owner) {
    const { id: _id, ...fields } = owner
    if (Object.keys(fields).length) jellyfin.primary = fields
  }
  if (others.length) jellyfin.personas = others
  if (Object.keys(jellyfin).length) rest.jellyfin = jellyfin
  return rest
}

/** The instance's household limit from its /api/v1/status settings (renamed in Nov 2026). */
function maxFromStatus(settings) {
  return Number(settings?.jellyfin?.maxProfiles ?? settings?.jellyfin?.maxPersonas) || 0
}

module.exports = { OWNER_ID, usesProfiles, othersOf, ownerOf, addOther, tidyOwner, inOldShape, maxFromStatus }
