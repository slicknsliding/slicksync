// What kind of login a person has, answered the same way everywhere.
//
// Stremio and Nuvio were the only two for a long time, so plenty of code
// asked "is it Nuvio? otherwise Stremio". A person signed in to a
// Jellyfin-compatible server is neither, and those either-or checks call
// them a disconnected Stremio account. These helpers know all three.

const JELLYFIN_KIND_LABELS = { jellyfin: 'Jellyfin', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }

/** The app's name for a person or a providerType ('stremio' | 'nuvio' | 'jellyfin'). */
function providerLabel(userOrType, serverKind) {
  const type = typeof userOrType === 'string' ? userOrType : (userOrType?.providerType || 'stremio')
  if (type === 'nuvio') return 'Nuvio'
  if (type === 'jellyfin') {
    const kind = serverKind || (typeof userOrType === 'object' ? userOrType?.jellyfinServerKind : null)
    return JELLYFIN_KIND_LABELS[kind] || 'Jellyfin'
  }
  return 'Stremio'
}

/** Whether the person's row holds a usable login. Needs the provider's own columns selected. */
function isProviderConnected(user) {
  if (!user) return false
  const type = user.providerType || 'stremio'
  if (type === 'nuvio') return !!(user.nuvioRefreshToken && user.nuvioUserId)
  if (type === 'jellyfin') return !!(user.jellyfinToken && user.jellyfinServerUrl && user.jellyfinUserId)
  return !!user.stremioAuthKey
}

/** Whether SlickSync manages an addon list for this person. */
function hasAddonList(userOrType) {
  const type = typeof userOrType === 'string' ? userOrType : (userOrType?.providerType || 'stremio')
  return type !== 'jellyfin'
}

/** The columns isProviderConnected() and providerLabel() read, for a Prisma select. */
const PROVIDER_SELECT = {
  providerType: true,
  stremioAuthKey: true,
  nuvioRefreshToken: true,
  nuvioUserId: true,
  jellyfinServerUrl: true,
  jellyfinServerKind: true,
  jellyfinUserId: true,
  jellyfinToken: true,
}

module.exports = { providerLabel, isProviderConnected, hasAddonList, PROVIDER_SELECT }
