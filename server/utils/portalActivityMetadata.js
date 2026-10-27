// Titles and posters for a person's own Home (Most Watched, binges, their
// activity list). These come from the account's library cache, which is only
// warm once the Library page has been opened since the server started - cold,
// every title showed as its id ("tt2661044"). Titles missing from the cache
// are looked up directly, the most-watched first and a bounded number per
// request. Reads only: nothing is synced or written to any provider.

const MAX_LOOKUPS = 12

const baseId = (id) => /^tt\d+/.exec(String(id))?.[0] || String(id)

async function portalActivityMetadata(library, activities, fetchMetadata = require('./notify').fetchMetadata) {
  const map = new Map()
  for (const item of library || []) {
    const id = item?._id || item?.id
    if (id) map.set(baseId(id), item)
  }
  const ranked = new Map()
  for (const a of activities || []) {
    const id = baseId(a.itemId)
    const entry = ranked.get(id) || { id, type: a.itemType, duration: 0 }
    entry.duration += a.watchTimeSeconds || 0
    ranked.set(id, entry)
  }
  const missing = [...ranked.values()]
    .filter((r) => {
      const known = map.get(r.id)
      return !known?.name || known.name === r.id || !known.poster
    })
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_LOOKUPS)
  await Promise.all(missing.map(async (r) => {
    try {
      const meta = await fetchMetadata(r.id, r.type, null)
      if (meta?.title) {
        const known = map.get(r.id)
        map.set(r.id, { ...known, name: meta.title, poster: known?.poster || meta.poster || null })
      }
    } catch { /* a metadata service being down must not break their Home */ }
  }))
  return { get: (id) => map.get(baseId(id)), size: map.size }
}

module.exports = { portalActivityMetadata }
