// Which profile a title is watched under, for the "Playing in Nuvio · Kids"
// line on Now Playing, Continue Watching and a person's own Home.
//
// One Nuvio account can hold several profiles that all count as one person
// until they are separated, so the person's newest history label is only the
// profile they used last, not necessarily the one playing now. The library
// read records, per title, the profile that played it most recently
// (state.nuvioProfile, see providers/nuvio.js); that is the one to name.

// Labels history rows carry to say where a watch came from rather than which
// profile watched it (Activity shows them as sources, never as profiles).
const SOURCE_MARKERS = ['Imported', 'Caught up', 'Scrobbled', 'AIOStreams']

/** A title's id without the episode part (tt123:1:2 -> tt123). */
const baseId = (id) => /^tt\d+/.exec(String(id || ''))?.[0] || String(id || '')

/** The library item for a title (an episode's id finds its show), or null. */
function libraryItemFor(library, itemId) {
  if (!Array.isArray(library) || !itemId) return null
  const want = baseId(itemId)
  return library.find((i) => baseId(i?._id || i?.id) === want) || null
}

/** The Nuvio profile that last played this title, from the library read, or null. */
function nuvioProfileFor(library, itemId) {
  const name = libraryItemFor(library, itemId)?.state?.nuvioProfile
  return typeof name === 'string' && name.trim() ? name : null
}

/** A history label when it names a profile, null when it is a source marker or empty. */
function profileName(label) {
  return typeof label === 'string' && label.trim() && !SOURCE_MARKERS.includes(label) ? label : null
}

/** Each person's newest history label that names a profile: Map userId -> label. */
async function latestProfileLabels(prisma, accountId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const rows = await prisma.watchActivity.findMany({
    where: { accountId, userId: { in: ids }, profileLabel: { not: null, notIn: SOURCE_MARKERS } },
    orderBy: { createdAt: 'desc' },
    distinct: ['userId'],
    select: { userId: true, profileLabel: true },
  })
  return new Map(rows.map((r) => [r.userId, r.profileLabel]))
}

module.exports = { SOURCE_MARKERS, baseId, libraryItemFor, nuvioProfileFor, profileName, latestProfileLabels }
