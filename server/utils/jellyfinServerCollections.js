// SlickSync catalogs as real collections on a Jellyfin server.
//
// For people who watch on their own Jellyfin server (not AIOStreams or
// AIOMetadata, which have their own collections). The household picks
// catalogs on Catalogs -> Jellyfin Collections; each one switched on becomes
// a Jellyfin collection holding the catalog's titles that the server has -
// matched by IMDb id - and is kept in step every 30 minutes and whenever a
// catalog is switched. A Jellyfin collection is server-wide: everyone on the
// server who can see the titles sees it.
//
// Changes are made through a SlickSync sign-in on that server that is allowed
// to manage collections (an administrator, or a user given collection
// management). SlickSync only ever touches collections it made itself, which
// it keeps a note of: AppAccount.sync.jellyfinCollections[server].
//
// A collection follows its catalog's name and cover too. Jellyfin only lets an
// administrator edit an item or set its picture, so with an administrator's
// sign-in a rename happens in place and the catalog's cover is put on the
// collection; with only collection management, a renamed catalog's collection
// is made again under the new name and the cover is left to Jellyfin.

const fs = require('fs')
const path = require('path')
const { jfRequest, deviceIdFor, displayServer, authorizationHeader, restrictsPrivateAddresses } = require('../providers/jellyfinAuth')

const SYNC_INTERVAL_MS = 30 * 60 * 1000
const INDEX_TTL_MS = 5 * 60 * 1000
const PAGE = 500
// Ids sent per request. Jellyfin takes them in the address, which it caps at
// about 8 KB - roughly 240 ids - so a big catalog goes in batches.
const IDS_PER_REQUEST = 100
const MAX_COVER_BYTES = 10 * 1024 * 1024

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

async function readState(prisma, accountId, server) {
  const cfg = await readSync(prisma, accountId)
  const all = cfg.jellyfinCollections && typeof cfg.jellyfinCollections === 'object' ? cfg.jellyfinCollections : {}
  const state = all[server] && typeof all[server] === 'object' ? all[server] : {}
  return { catalogs: {}, ...state }
}

async function writeState(prisma, accountId, server, state) {
  const cfg = await readSync(prisma, accountId)
  const all = cfg.jellyfinCollections && typeof cfg.jellyfinCollections === 'object' ? cfg.jellyfinCollections : {}
  await writeSync(prisma, accountId, { ...cfg, jellyfinCollections: { ...all, [server]: state } })
}

/**
 * The name to show for a server. Jellyfin names itself after its machine
 * unless someone sets a name, and in Docker that is the container's random
 * 12-character id ("67b9ee89e91a") - meaningless to anyone, so the address is
 * shown instead.
 */
function serverDisplayName(name, address) {
  const n = String(name || '').trim()
  if (!n || /^[0-9a-f]{12}$/i.test(n) || /^[0-9a-f]{64}$/i.test(n)) return address
  return n
}

/** Which server a person is on: its id, or its address when the id is unknown. */
function serverKeyOf(person) {
  return person.jellyfinServerId || displayServer(person.jellyfinServerUrl)
}

/** Everyone SlickSync signs in to real Jellyfin servers as, grouped by server. */
async function serversFor(prisma, accountId) {
  const people = await prisma.user.findMany({
    where: { accountId, isActive: true, providerType: 'jellyfin', jellyfinToken: { not: null }, OR: [{ jellyfinServerKind: 'jellyfin' }, { jellyfinServerKind: null }] },
    select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, jellyfinServerId: true, jellyfinUserId: true, jellyfinToken: true },
    orderBy: { username: 'asc' },
  })
  const servers = new Map()
  for (const p of people) {
    if (!p.jellyfinServerUrl || !p.jellyfinUserId) continue
    const key = serverKeyOf(p)
    if (!servers.has(key)) servers.set(key, { key, url: p.jellyfinServerUrl, address: displayServer(p.jellyfinServerUrl), people: [] })
    servers.get(key).people.push(p)
  }
  return [...servers.values()]
}

function sessionFor(person, decrypt) {
  return {
    person,
    base: person.jellyfinServerUrl,
    userId: person.jellyfinUserId,
    token: decrypt(person.jellyfinToken, { appAccountId: person.accountId || 'default' }),
    deviceId: deviceIdFor(person.jellyfinServerUrl, person.jellyfinUserId),
  }
}

const call = (s, path, opts = {}) => jfRequest(s.base, path, { token: s.token, deviceId: s.deviceId, ...opts })

/**
 * The sign-in changes are made through: an administrator if anyone here signs
 * in as one (they can also rename in place and set covers), else the first
 * person allowed to manage collections. No session when nobody is.
 */
async function findActor(server, decrypt) {
  let serverName = null
  let manager = null
  for (const person of server.people) {
    try {
      const s = sessionFor(person, decrypt)
      const me = await call(s, '/Users/Me')
      if (!serverName) {
        try { serverName = (await call(s, '/System/Info/Public'))?.ServerName || null } catch {}
      }
      const policy = me?.Policy || {}
      if (policy.IsAdministrator) return { session: s, admin: true, serverName }
      if (policy.EnableCollectionManagement && !manager) manager = s
    } catch (e) {
      console.warn(`[JellyfinCollections] could not check ${person.username} on ${server.address}:`, e?.message)
    }
  }
  return { session: manager, admin: false, serverName }
}

// imdb id -> Jellyfin item id, per server, briefly cached so the page stays quick.
const indexCache = new Map()

async function libraryIndex(s, server, { fresh = false } = {}) {
  const hit = indexCache.get(server.key)
  if (!fresh && hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.map
  const map = new Map()
  for (let start = 0; ; start += PAGE) {
    const page = await call(s, `/Items?userId=${encodeURIComponent(s.userId)}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds&StartIndex=${start}&Limit=${PAGE}`, { timeoutMs: 60000 })
    const items = Array.isArray(page?.Items) ? page.Items : []
    for (const item of items) {
      const imdb = item?.ProviderIds?.Imdb || item?.ProviderIds?.IMDB
      if (imdb && /^tt\d+$/.test(imdb) && !map.has(imdb)) map.set(imdb, String(item.Id))
    }
    if (items.length < PAGE) break
  }
  indexCache.set(server.key, { at: Date.now(), map })
  return map
}

function catalogItems(list) {
  let items = []
  try { items = JSON.parse(list.itemsJson || '[]') } catch { items = [] }
  return (Array.isArray(items) ? items : []).filter((i) => i && /^tt\d+$/.test(String(i.id || '')))
}

async function loadLists(prisma, accountId) {
  return prisma.customList.findMany({ where: { accountId }, select: { id: true, name: true, itemsJson: true, coverImageUrl: true }, orderBy: { name: 'asc' } })
}

async function collectionChildren(s, collectionId) {
  const page = await call(s, `/Items?userId=${encodeURIComponent(s.userId)}&ParentId=${encodeURIComponent(collectionId)}&Limit=10000`)
  return (Array.isArray(page?.Items) ? page.Items : []).map((i) => String(i.Id))
}

/** The collection as Jellyfin has it, or null when it's gone. */
async function getCollection(s, collectionId) {
  try {
    const item = await call(s, `/Items/${encodeURIComponent(collectionId)}?userId=${encodeURIComponent(s.userId)}`)
    return item?.Type === 'BoxSet' ? item : null
  } catch (e) {
    if (e.status === 404 || e.status === 400) return null
    throw e
  }
}

const collectionExists = async (s, collectionId) => !!(await getCollection(s, collectionId))

/**
 * A catalog cover's picture: an image SlickSync has stored (/uploads/avatars/
 * <file>), or one on the web. Null when it can't be had.
 */
async function readCover(url) {
  const local = /^\/uploads\/avatars\/([^/?#]+)$/.exec(String(url || ''))
  if (local) {
    const file = path.join(process.cwd(), 'data', 'avatars', path.basename(local[1]))
    const bytes = await fs.promises.readFile(file).catch(() => null)
    if (!bytes || bytes.length > MAX_COVER_BYTES) return null
    const ext = path.extname(file).toLowerCase()
    const type = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/jpeg'
    return { bytes, type }
  }
  if (!/^https?:\/\//i.test(String(url || ''))) return null
  if (restrictsPrivateAddresses()) {
    const { assertSafeUrl } = require('./safeUrl')
    try { await assertSafeUrl(url) } catch { return null }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' })
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim()
    if (!res.ok || !type.startsWith('image/')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    return bytes.length && bytes.length <= MAX_COVER_BYTES ? { bytes, type } : null
  } catch {
    return null
  }
}

/** Put a picture on a collection (administrator only in Jellyfin). */
async function setCollectionPicture(s, collectionId, cover) {
  const res = await fetch(`${s.base}/Items/${encodeURIComponent(collectionId)}/Images/Primary`, {
    method: 'POST',
    headers: { Authorization: authorizationHeader({ token: s.token, deviceId: s.deviceId }), 'Content-Type': cover.type },
    body: cover.bytes.toString('base64'),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw Object.assign(new Error(`Jellyfin would not take the cover (HTTP ${res.status})`), { status: res.status })
}

/** Rename a collection in place (administrator only in Jellyfin). */
async function renameInPlace(s, item, name) {
  await call(s, `/Items/${encodeURIComponent(item.Id)}`, { method: 'POST', body: { ...item, Name: name } })
}

const idsParam = (ids) => ids.map(encodeURIComponent).join(',')

async function addToCollection(s, collectionId, ids) {
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    await call(s, `/Collections/${encodeURIComponent(collectionId)}/Items?ids=${idsParam(ids.slice(i, i + IDS_PER_REQUEST))}`, { method: 'POST' })
  }
}

async function createCollection(s, name, want) {
  const created = await call(s, `/Collections?name=${encodeURIComponent(name)}&ids=${idsParam(want.slice(0, IDS_PER_REQUEST))}&isLocked=false`, { method: 'POST' })
  if (!created?.Id) throw new Error('The server did not make the collection')
  const id = String(created.Id)
  await addToCollection(s, id, want.slice(IDS_PER_REQUEST))
  return id
}

/**
 * The catalog's cover on its collection, when this sign-in may set pictures.
 * Remembers which cover went up, so it is sent once, not every sync.
 */
async function syncCover(s, collectionId, list, entry, admin) {
  const wanted = list.coverImageUrl || null
  if (!admin || !collectionId) return { cover: entry.cover || null }
  if (wanted === (entry.cover || null)) return { cover: entry.cover || null }
  if (!wanted) {
    // The catalog's cover was taken away: back to Jellyfin's own picture.
    try { await call(s, `/Items/${encodeURIComponent(collectionId)}/Images/Primary`, { method: 'DELETE' }) } catch {}
    return { cover: null }
  }
  const picture = await readCover(wanted)
  if (!picture) return { cover: entry.cover || null, coverError: 'The catalog cover could not be read' }
  await setCollectionPicture(s, collectionId, picture)
  return { cover: wanted }
}

/**
 * Bring one catalog's collection in line with the catalog: its titles, its
 * name, and (as an administrator) its cover. Returns what to remember.
 */
async function syncOne(s, list, index, entry, { admin = false } = {}) {
  const want = []
  for (const item of catalogItems(list)) {
    const id = index.get(item.id)
    if (id && !want.includes(id)) want.push(id)
  }
  let existing = entry.collectionId ? await getCollection(s, entry.collectionId) : null
  if (!existing) {
    // Nothing of it on this server: no empty collection on everyone's shelf.
    if (!want.length) return { collectionId: null, matched: 0, cover: null }
    const collectionId = await createCollection(s, list.name, want)
    return { collectionId, matched: want.length, ...(await syncCover(s, collectionId, list, { cover: null }, admin)) }
  }
  let collectionId = String(existing.Id)
  if (existing.Name !== list.name) {
    if (admin) {
      await renameInPlace(s, existing, list.name)
    } else {
      // Without an administrator, a collection can't be renamed - make it
      // again under the new name and take the old one off.
      if (!want.length) {
        await removeCollection(s, collectionId)
        return { collectionId: null, matched: 0, cover: null }
      }
      const fresh = await createCollection(s, list.name, want)
      await removeCollection(s, collectionId)
      return { collectionId: fresh, matched: want.length, ...(await syncCover(s, fresh, list, { cover: null }, admin)) }
    }
  }
  const have = await collectionChildren(s, collectionId)
  const add = want.filter((id) => !have.includes(id))
  const remove = have.filter((id) => !want.includes(id))
  await addToCollection(s, collectionId, add)
  for (let i = 0; i < remove.length; i += IDS_PER_REQUEST) {
    await call(s, `/Collections/${encodeURIComponent(collectionId)}/Items?ids=${idsParam(remove.slice(i, i + IDS_PER_REQUEST))}`, { method: 'DELETE' })
  }
  return { collectionId, matched: want.length, ...(await syncCover(s, collectionId, list, entry, admin)) }
}

/** Take a collection SlickSync made back off the server; emptied if it can't be deleted. */
async function removeCollection(s, collectionId) {
  if (!(await collectionExists(s, collectionId))) return
  try {
    await call(s, `/Items/${encodeURIComponent(collectionId)}`, { method: 'DELETE' })
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e
    const have = await collectionChildren(s, collectionId)
    for (let i = 0; i < have.length; i += IDS_PER_REQUEST) {
      await call(s, `/Collections/${encodeURIComponent(collectionId)}/Items?ids=${idsParam(have.slice(i, i + IDS_PER_REQUEST))}`, { method: 'DELETE' })
    }
  }
}

const inFlight = new Map()

/** One server, start to finish. Records how it went for the page. */
async function syncServer(prisma, decrypt, accountId, server) {
  const key = `${accountId}|${server.key}`
  if (inFlight.has(key)) return inFlight.get(key)
  const run = (async () => {
    const state = await readState(prisma, accountId, server.key)
    const { session, admin } = await findActor(server, decrypt)
    if (!session) {
      await writeState(prisma, accountId, server.key, { ...state, lastError: 'no-permission', lastSyncAt: new Date().toISOString() })
      return
    }
    try {
      const lists = await loadLists(prisma, accountId)
      const byId = new Map(lists.map((l) => [l.id, l]))
      const index = await libraryIndex(session, server, { fresh: true })
      const catalogs = { ...state.catalogs }
      for (const [catalogId, entry] of Object.entries(catalogs)) {
        const list = byId.get(catalogId)
        if (entry.on && list) {
          const done = await syncOne(session, list, index, entry, { admin })
          catalogs[catalogId] = { ...entry, ...done }
        } else {
          // Switched off, or the catalog is gone.
          if (entry.collectionId) await removeCollection(session, entry.collectionId)
          delete catalogs[catalogId]
        }
      }
      await writeState(prisma, accountId, server.key, { catalogs, actorId: session.person.id, lastError: null, lastSyncAt: new Date().toISOString() })
    } catch (e) {
      console.warn(`[JellyfinCollections] sync of ${server.address} failed:`, e?.message)
      await writeState(prisma, accountId, server.key, { ...state, lastError: e?.message || 'failed', lastSyncAt: new Date().toISOString() })
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

/** What the page shows for one server. */
async function describeServer(prisma, decrypt, accountId, server) {
  const [state, lists, actor] = await Promise.all([
    readState(prisma, accountId, server.key),
    loadLists(prisma, accountId),
    findActor(server, decrypt),
  ])
  let index = null
  const reader = actor.session || (server.people[0] ? sessionFor(server.people[0], decrypt) : null)
  if (reader) {
    try { index = await libraryIndex(reader, server) } catch (e) { console.warn('[JellyfinCollections] library read failed:', e?.message) }
  }
  return {
    server: { key: server.key, name: serverDisplayName(actor.serverName, server.address), address: server.address },
    people: server.people.map((p) => ({ id: p.id, username: p.username })),
    actor: actor.session ? { id: actor.session.person.id, username: actor.session.person.username, admin: !!actor.admin } : null,
    lastSyncAt: state.lastSyncAt || null,
    lastError: state.lastError || null,
    catalogs: lists.map((l) => {
      const items = catalogItems(l)
      const entry = state.catalogs?.[l.id] || {}
      return {
        id: l.id,
        name: l.name,
        titles: items.length,
        onServer: index ? items.filter((i) => index.has(i.id)).length : null,
        cover: l.coverImageUrl || items.find((i) => i.poster)?.poster || null,
        coverTitleId: l.coverImageUrl ? null : items.find((i) => i.poster)?.id || null,
        on: !!entry.on,
        inJellyfin: !!entry.collectionId,
      }
    }),
  }
}

/** Switch one catalog on or off for a server, then sync that server. */
async function setCatalog(prisma, decrypt, accountId, server, catalogId, on) {
  const state = await readState(prisma, accountId, server.key)
  const entry = state.catalogs?.[catalogId] || {}
  await writeState(prisma, accountId, server.key, { ...state, catalogs: { ...state.catalogs, [catalogId]: { ...entry, on: !!on } } })
  await syncServer(prisma, decrypt, accountId, server)
}

async function syncAll(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  for (const acc of accounts) {
    let cfg = acc.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    const wanted = cfg?.jellyfinCollections
    if (!wanted || typeof wanted !== 'object' || !Object.keys(wanted).length) continue
    for (const server of await serversFor(prisma, acc.id)) {
      if (wanted[server.key]) await syncServer(prisma, decrypt, acc.id, server)
    }
  }
}

let timer = null
function scheduleServerCollections(prisma, decrypt) {
  if (timer) clearInterval(timer)
  const run = () => syncAll(prisma, decrypt).catch((e) => console.warn('[JellyfinCollections] sync failed:', e?.message))
  setTimeout(run, 3 * 60 * 1000)
  timer = setInterval(run, SYNC_INTERVAL_MS)
}

module.exports = { serverDisplayName, serversFor, describeServer, setCatalog, syncServer, scheduleServerCollections, serverKeyOf, syncOne }
