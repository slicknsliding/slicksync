/**
 * Real titles for titles that arrive named by their id.
 *
 * A Jellyfin-compatible server answers with whatever name its library holds,
 * and AIOStreams' answers with the IMDb id itself ("tt4468740") when its
 * metadata has no title for an item. That name was then saved as-is and
 * shown everywhere a title shows - Activity, the bell, history, Continue
 * Watching - as "tt4468740" instead of "Paddington 2". The id names a real
 * title, so Cinemeta is asked for it.
 *
 * Lookups are kept (titles don't change), misses too for a while, so a
 * poll every minute costs nothing after the first.
 */

const ID_NAME = /^(tt\d{5,}|tmdb:\d+|tvdb:\d+|kitsu:\d+)(:\d+){0,2}$/i
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 60 * 60 * 1000
const cache = new Map() // `${type}|${id}` -> { at, name }

/** No name at all, or a name that is only an id. */
function looksLikeIdName(name, id) {
  const n = String(name || '').trim()
  return !n || (id != null && n === String(id)) || ID_NAME.test(n)
}

/** The IMDb id inside an id-shaped name or item id ("tt123:1:2" -> "tt123"). */
function imdbIdOf(...candidates) {
  for (const c of candidates) {
    const m = /^(tt\d{5,})/i.exec(String(c || '').trim())
    if (m) return m[1].toLowerCase()
  }
  return null
}

async function lookupName(imdbId, type, fetchImpl = fetch) {
  if (!imdbId) return null
  const kind = type === 'movie' ? 'movie' : 'series'
  const key = `${kind}|${imdbId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < (hit.name ? HIT_TTL_MS : MISS_TTL_MS)) return hit.name
  let name = null
  try {
    const res = await fetchImpl(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { signal: AbortSignal.timeout(8000) })
    if (res.ok) name = (await res.json())?.meta?.name || null
    // A movie id asked for as a series (or the other way) still has a title.
    if (!name) {
      const other = kind === 'movie' ? 'series' : 'movie'
      const res2 = await fetchImpl(`https://v3-cinemeta.strem.io/meta/${other}/${imdbId}.json`, { signal: AbortSignal.timeout(8000) })
      if (res2.ok) name = (await res2.json())?.meta?.name || null
    }
  } catch { /* a miss, kept for a while */ }
  if (cache.size > 5000) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), name })
  return name
}

/**
 * Fill in real titles where a list has ids for names. `fields` says where
 * the name lives on each item and which id/type to look up by.
 */
async function fillNames(items, { getName, setName, getId, getType }, fetchImpl = fetch) {
  const todo = []
  for (const item of items || []) {
    if (!item) continue
    const id = getId(item)
    if (!looksLikeIdName(getName(item), id)) continue
    const imdb = imdbIdOf(getName(item), id)
    if (imdb) todo.push({ item, imdb })
  }
  if (!todo.length) return 0
  let filled = 0
  await require('./mapLimit').mapLimit(todo.slice(0, 300), 6, async ({ item, imdb }) => {
    const name = await lookupName(imdb, getType(item), fetchImpl)
    if (name) { setName(item, name); filled += 1 }
  })
  return filled
}

/**
 * Saved rows whose title is only an id get their real title: history,
 * viewings, ratings and reactions, the AIOStreams cursor, and the bell's
 * notifications ("MAIN watched tt4468740"). Safe to run any time.
 */
async function repairStoredNames(prisma, fetchImpl = fetch) {
  let fixed = 0
  const idLike = { OR: [{ startsWith: 'tt' }, { startsWith: 'tmdb:' }, { startsWith: 'kitsu:' }, { startsWith: 'tvdb:' }] }
  const where = (field) => ({ OR: idLike.OR.map((c) => ({ [field]: c })) })
  const plan = [
    { model: 'movieWatchHistory', field: 'itemName', id: 'itemId', type: () => 'movie' },
    { model: 'episodeWatchHistory', field: 'showName', id: 'showId', type: () => 'series' },
    { model: 'watchSession', field: 'itemName', id: 'itemId', type: (r) => r.itemType },
    { model: 'watchStateCursor', field: 'itemName', id: 'itemId', type: (r) => r.itemType },
    { model: 'titleRating', field: 'itemName', id: 'itemId', type: (r) => r.itemType },
    { model: 'titleReaction', field: 'itemName', id: 'itemId', type: (r) => r.itemType },
  ]
  for (const p of plan) {
    const table = prisma[p.model]
    if (!table?.findMany) continue
    let rows = []
    try {
      rows = await table.findMany({ where: where(p.field), select: { id: true, [p.field]: true, [p.id]: true, ...(p.model === 'watchSession' || p.model.startsWith('title') || p.model === 'watchStateCursor' ? { itemType: true } : {}) }, take: 2000 })
    } catch { continue } // a table without these columns on this database
    const byName = new Map()
    for (const r of rows) {
      if (!looksLikeIdName(r[p.field], r[p.id])) continue
      const imdb = imdbIdOf(r[p.field], r[p.id])
      if (!imdb) continue
      const k = `${p.type(r)}|${imdb}`
      if (!byName.has(k)) byName.set(k, { imdb, type: p.type(r), ids: [] })
      byName.get(k).ids.push(r.id)
    }
    for (const { imdb, type, ids } of byName.values()) {
      const name = await lookupName(imdb, type, fetchImpl)
      if (!name) continue
      const res = await table.updateMany({ where: { id: { in: ids } }, data: { [p.field]: name } }).catch(() => null)
      fixed += res?.count || 0
    }
  }
  // The bell: titles and bodies that carry the bare id.
  try {
    const notes = await prisma.notification.findMany({
      where: { OR: [{ title: { contains: 'tt' } }, { body: { contains: 'tt' } }] },
      select: { id: true, title: true, body: true },
      take: 2000,
    })
    for (const n of notes) {
      let title = n.title
      let body = n.body
      for (const m of new Set([...`${title} ${body}`.matchAll(/\btt\d{5,}\b/g)].map((x) => x[0]))) {
        const name = await lookupName(m, 'movie', fetchImpl)
        if (!name) continue
        title = title.split(m).join(name)
        body = body.split(m).join(name)
      }
      if (title !== n.title || body !== n.body) {
        await prisma.notification.update({ where: { id: n.id }, data: { title, body } }).catch(() => {})
        fixed += 1
      }
    }
  } catch { /* the bell is optional */ }
  return fixed
}

/** Repairs once soon after start, then every six hours. */
function scheduleNameRepair(prisma) {
  const run = () => {
    repairStoredNames(prisma)
      .then((n) => { if (n) console.log(`[titleNames] gave ${n} saved row(s) their real title`) })
      .catch(() => {})
  }
  setTimeout(run, 45 * 1000).unref?.()
  setInterval(run, 6 * 60 * 60 * 1000).unref?.()
}

module.exports = { looksLikeIdName, imdbIdOf, lookupName, fillNames, repairStoredNames, scheduleNameRepair }
