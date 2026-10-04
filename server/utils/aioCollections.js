// SlickSync's catalogs as AIOStreams collections, arranged per AIOStreams
// account.
//
// Each AIOStreams login reaches SlickSync through its own link
// (routes/traxAddon.js), which serves a "SlickSync catalogs" library whose
// entries are collections. Out of the box every catalog with titles in it is
// one collection. Once someone arranges a login's collections on the
// AIOStreams Collections page, that arrangement is used for it: an ordered
// list of collections, each with a name, an optional cover, and the catalogs
// whose titles it holds. Every profile on one login sees that login's
// collections - AIOStreams names the profile on watch-history requests only,
// never when it fetches catalogs.
//
// Kept with the account's settings: AppAccount.sync.aioCollections.byUser
// [userId]. An older account-wide arrangement (aioCollections.collections)
// is where a login that was never arranged on its own starts from; null for a
// login means it was put back to one collection per catalog.

const crypto = require('crypto')

const MAX_COLLECTIONS = 60
const MAX_ITEMS = 500

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  return cfg && typeof cfg === 'object' ? cfg : {}
}

async function writeSync(prisma, accountId, cfg) {
  try { await prisma.appAccount.update({ where: { id: accountId }, data: { sync: cfg } }) }
  catch { await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(cfg) } }) }
}

function itemsOf(list) {
  let items = []
  try { items = JSON.parse(list.itemsJson || '[]') } catch { items = [] }
  return (Array.isArray(items) ? items : []).filter((i) => i && /^tt\d+$/.test(String(i.id || '')))
}

async function loadLists(prisma, accountId) {
  return prisma.customList.findMany({
    where: { accountId },
    select: { id: true, name: true, description: true, itemsJson: true, coverImageUrl: true },
    orderBy: { name: 'asc' },
  })
}

/** The arrangement a login uses: its own, else the account-wide one, else none. */
function storedFor(cfg, userId) {
  const all = cfg.aioCollections && typeof cfg.aioCollections === 'object' ? cfg.aioCollections : {}
  const byUser = all.byUser && typeof all.byUser === 'object' ? all.byUser : {}
  if (userId && Object.prototype.hasOwnProperty.call(byUser, userId)) return byUser[userId]
  return Array.isArray(all.collections) ? all : null
}

/**
 * One login's collections in the order they show, each resolved against the
 * catalogs that still exist. `configured` says whether they were arranged;
 * when not, it is one collection per catalog that has titles.
 */
async function loadCollections(prisma, accountId, userId) {
  const [cfg, lists] = await Promise.all([readSync(prisma, accountId), loadLists(prisma, accountId)])
  const byId = new Map(lists.map((l) => [l.id, l]))
  const stored = storedFor(cfg, userId)
  if (!stored || !Array.isArray(stored.collections)) {
    const collections = lists
      .filter((l) => itemsOf(l).length > 0)
      .map((l) => ({ id: l.id, name: l.name, coverUrl: l.coverImageUrl || null, catalogIds: [l.id], hidden: false }))
    return { configured: false, collections, lists }
  }
  const collections = stored.collections
    .map((c) => ({ ...c, catalogIds: (c.catalogIds || []).filter((id) => byId.has(id)) }))
    .filter((c) => c.catalogIds.length > 0)
  return { configured: true, collections, lists }
}

/**
 * One collection's titles: its catalogs' titles, in order, each once. A
 * collection built from several catalogs can carry its own `order` (title
 * ids, dragged on its page); titles it doesn't mention keep their place after.
 */
function membersOf(collection, lists) {
  const byId = new Map(lists.map((l) => [l.id, l]))
  const seen = new Set()
  let out = []
  for (const id of collection.catalogIds) {
    const list = byId.get(id)
    if (!list) continue
    for (const item of itemsOf(list)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  if (Array.isArray(collection.order) && collection.order.length > 0) {
    const rank = new Map(collection.order.map((id, i) => [id, i]))
    out = out
      .map((item, i) => ({ item, key: rank.has(item.id) ? rank.get(item.id) : collection.order.length + i }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item)
  }
  return out.slice(0, MAX_ITEMS)
}

/** The cover a collection shows: its own, its first catalog's, or its first title's poster. */
function coverOf(collection, lists, members) {
  if (collection.coverUrl) return collection.coverUrl
  const first = lists.find((l) => l.id === collection.catalogIds[0])
  return first?.coverImageUrl || members.find((m) => m.poster)?.poster || null
}

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Keep a login's arrangement, or put it back to one collection per catalog (null). */
async function saveCollections(prisma, accountId, userId, collections) {
  if (!userId) throw new Error('Which AIOStreams account these collections are for is missing')
  const cfg = await readSync(prisma, accountId)
  const all = cfg.aioCollections && typeof cfg.aioCollections === 'object' ? cfg.aioCollections : {}
  const byUser = all.byUser && typeof all.byUser === 'object' ? all.byUser : {}
  const write = (value) => writeSync(prisma, accountId, { ...cfg, aioCollections: { ...all, byUser: { ...byUser, [userId]: value } } })
  if (collections === null) {
    await write(null)
    return
  }
  const lists = await loadLists(prisma, accountId)
  const valid = new Set(lists.map((l) => l.id))
  const clean = (Array.isArray(collections) ? collections : []).slice(0, MAX_COLLECTIONS).map((c) => {
    const coverUrl = cleanText(c.coverUrl, 2000)
    return {
      id: /^[\w-]{1,40}$/.test(String(c.id || '')) ? String(c.id) : `c-${crypto.randomBytes(5).toString('hex')}`,
      name: cleanText(c.name, 80) || 'Collection',
      coverUrl: /^https?:\/\//i.test(coverUrl) ? coverUrl : null,
      catalogIds: [...new Set((c.catalogIds || []).map(String).filter((id) => valid.has(id)))],
      hidden: c.hidden === true,
      ...(Array.isArray(c.order) && c.order.length > 0
        ? { order: [...new Set(c.order.map(String).filter((id) => /^tt\d+$/.test(id)))].slice(0, MAX_ITEMS) }
        : {}),
    }
  }).filter((c) => c.catalogIds.length > 0)
  await write({ collections: clean, updatedAt: new Date().toISOString() })
}

module.exports = { loadCollections, membersOf, coverOf, saveCollections }
