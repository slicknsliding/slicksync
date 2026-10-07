const express = require('express')

// The SlickTrax Addon - SlickSync serving the Stremio addon protocol ITSELF,
// instead of only managing other people's addons.
//
// One manifest URL per user (/trax/<token>/manifest.json) serves their
// household's SlickTrax data as real catalog rows inside Stremio and Nuvio:
// Continue Watching (cross-provider - Stremio and Nuvio watches merged,
// which nothing else can offer because nothing else has both pipelines),
// the household Watchlist, and every SlickSync Catalog. Installed once -
// injected automatically by sync when the user's toggle is on (see
// utils/sync.js) - and forever current, because the catalogs are computed
// from live data on every request.
//
// Auth model is Addon.proxyUuid's: the token in the URL is the bearer
// credential, generated on first enable (crypto-random, never derived),
// revocable by regenerating. These routes are allowlisted past the auth
// gate (utils/auth.js) because the caller is a Stremio app with no session -
// exactly the /api/federation/catalog/ precedent, and the same mistake we
// just found on /proxy, which was never allowlisted and therefore 401'd
// every real Stremio fetch on any instance with auth enabled.
//
// Deliberately catalog-only: no streams, no meta resource. Streams are the
// user's own addons' job (and AIOStreams' aggregation job) - this addon adds
// rows, it never touches playback.

// Bumped whenever the catalog layout changes shape. It rides IN THE
// TRANSPORT URL PATH (/trax/<token>/v<this>/manifest.json), because Nuvio
// caches an installed addon's manifest by URL and never refetches while the
// URL is unchanged - confirmed live: three manifest revisions in a row
// never reached the device. A version bump changes the URL, sync sees a
// different addon (fingerprints canonicalize away query strings but not
// paths) and replaces it on the account, and the client fetches fresh.
const TRAX_MANIFEST_VERSION = '1.7.0'

const CACHE_SECONDS = 60 // catalogs recompute cheaply; 60s keeps app scrolling snappy without staleness anyone would notice

// The AIOStreams link's collections: one catalog listing SlickSync's catalogs,
// each a collection with this id prefix.
const COLLECTIONS_CATALOG = 'slicksync-collections'
const COLLECTION_PREFIX = 'slicksync.catalog.'

function metaPreview(id, type, name, poster) {
  return { id, type, name: name || id, poster: poster || undefined }
}

// Serve catalog posters through this instance's own resize/cache proxy
// (/api/img, routes/imageCache.js) instead of handing devices raw upstream
// URLs: rows load resized-to-fit images, repeat views come off this box's
// disk, and one slow upstream art host can't drag a whole row. The base is
// the request's own origin - the same self-learning the transport URL does.
// Fallback behavior is inherited from the proxy itself: anything it can't
// process 302s to the original URL, so a device never sees a broken poster.
function proxiedPoster(base, token, poster) {
  if (!base || !poster || !/^https?:\/\//i.test(poster)) return poster || undefined
  try {
    // Never wrap a URL already served by this instance (e.g. /api/poster's
    // RPDB redirects) - that would just proxy ourselves.
    if (new URL(poster).host === new URL(base).host) return poster
  } catch { return poster }
  // Served from under the addon's own token path rather than /api/img. A
  // device fetching these has no session and cannot get one, so the poster
  // has to live somewhere an addon URL is already guaranteed to reach: an
  // instance behind a login gate exempts /trax/ and everything the rows need
  // comes with it, instead of the artwork silently 302ing to a login page
  // and every tile rendering empty. The token guards it exactly as it guards
  // the catalogs themselves.
  return `${base}/trax/${token}/img?src=${encodeURIComponent(poster)}&w=342`
}

function requestBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return host ? `${String(proto).split(',')[0]}://${host}` : null
}

// --- Each person's rows ---------------------------------------------------
//
// A person can be given only some of the rows, in an order of their own:
// the kids get Continue Watching and "Kids picks", not "Horror Night". Rows
// are named by key - 'continue', 'watchlist', 'list:<catalog id>' - and
// User.traxRowsJson holds { order: [key], hidden: [key] }. A row nobody has
// placed yet (a catalog made later) appears after the placed ones, shown.

function parseTraxRows(json) {
  let raw = null
  try { raw = json ? JSON.parse(json) : null } catch { raw = null }
  const order = Array.isArray(raw?.order) ? raw.order.filter((k) => typeof k === 'string') : []
  const hidden = Array.isArray(raw?.hidden) ? raw.hidden.filter((k) => typeof k === 'string') : []
  return { order, hidden }
}

/** Every row this account can offer, in the default order, with its catalog entries. */
function traxRowCatalog(lists) {
  const rows = [
    // Continue Watching first - it's the row people open the app for. ONE
    // declared entry, not one per type: the row mixes movies and series
    // (each meta carries its own real type, which is what Stremio uses for
    // opening), so declaring both types just rendered two identical-looking
    // "Continue Watching" - ONE mixed row (the handler ignores the
    // requested type and serves movies and series together, most recent
    // first). Declared under 'series' because that is the only universally
    // safe anchor: the mobile client HIDES catalogs of unknown types
    // outright (confirmed live - 'Watching' and 'all' rows vanished once
    // the manifest genuinely reached the device), so clever type strings
    // cost the row its existence. Clients that suffix the declared type
    // onto the header will show "Continue Watching Series"; clients that
    // honor the synced home-catalog preference (nuvioHomePlacement.js) show
    // the exact title and position instead.
    { key: 'continue', name: 'Continue Watching', entries: [{ type: 'series', id: 'slicktrax-continue', name: 'Continue Watching' }] },
    {
      key: 'watchlist',
      name: 'Watchlist',
      entries: [
        { type: 'movie', id: 'slicktrax-watchlist', name: 'Watchlist' },
        { type: 'series', id: 'slicktrax-watchlist', name: 'Watchlist' },
      ],
    },
  ]
  for (const list of lists || []) {
    // Registered under both types and filtered at serve time - a catalog
    // freely mixes movies and series, and Stremio's protocol wants a type
    // per catalog entry. An empty half is legal and renders as nothing.
    rows.push({
      key: `list:${list.id}`,
      name: list.name,
      entries: [
        { type: 'movie', id: `slicktrax-list-${list.id}`, name: list.name },
        { type: 'series', id: `slicktrax-list-${list.id}`, name: list.name },
      ],
    })
  }
  return rows
}

/** The account's rows as this person sees them: placed ones in their order, the rest after. */
function orderedTraxRows(lists, rowsJson) {
  const { order, hidden } = parseTraxRows(rowsJson)
  const all = traxRowCatalog(lists)
  const byKey = new Map(all.map((r) => [r.key, r]))
  const placed = order.map((k) => byKey.get(k)).filter(Boolean)
  const rest = all.filter((r) => !order.includes(r.key))
  const hiddenSet = new Set(hidden)
  return [...placed, ...rest].map((r) => ({ ...r, hidden: hiddenSet.has(r.key) }))
}

/**
 * The version segment of this person's SlickTrax address. Devices cache a
 * manifest by its address, so a change to someone's rows has to change the
 * address too or their phone keeps the old rows: the segment carries a short
 * fingerprint of their choice. The path shim strips it like any version.
 */
function traxPathVersion(user) {
  const { order, hidden } = parseTraxRows(user?.traxRowsJson)
  if (!order.length && !hidden.length) return TRAX_MANIFEST_VERSION
  const rev = require('crypto').createHash('sha1').update(JSON.stringify({ order, hidden })).digest('hex').slice(0, 6)
  return `${TRAX_MANIFEST_VERSION}r${rev}`
}

/**
 * The manifest object, exported separately because sync injects the SAME
 * object inline into the account's addon collection - built in one place so
 * the served manifest and the synced copy can never drift apart.
 */
function buildTraxManifest(user, lists) {
  const catalogs = orderedTraxRows(lists, user?.traxRowsJson)
    .filter((r) => !r.hidden)
    .flatMap((r) => r.entries)
  return {
    id: `vip.slicksync.trax.${user.id}`,
    version: TRAX_MANIFEST_VERSION,
    name: 'SlickTrax',
    description: `SlickTrax for ${user.username || 'this household'} - Continue Watching, Watchlist and Catalogs, live from SlickSync.`,
    logo: 'https://slicksync.vip/android-chrome-192x192.png',
    // Catalogs only. SlickTrax once also declared a stream resource, which
    // put mark-watched / watchlist actions into the stream list of a title's
    // page - the list people open to find something to play. It was removed
    // rather than left as a toggle.
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: false, configurationRequired: false },
  }
}

async function getListsForAccount(prisma, accountId) {
  return prisma.customList.findMany({
    where: { accountId },
    select: { id: true, name: true, itemsJson: true },
    orderBy: { name: 'asc' },
  })
}

module.exports = ({ prisma }) => {
  const router = express.Router()

  // Stremio's web app and some TV builds fetch cross-origin - the addon
  // protocol requires permissive CORS (the same fact that drove the
  // browser-side directory install fallback). These endpoints only ever
  // return catalog previews for a bearer token, so * is appropriate here
  // in a way it wouldn't be on the API.
  // Versioned-path shim: /<token>/v1.5.0/manifest.json (and every resource
  // under it) serves identically to /<token>/manifest.json - the version
  // segment exists purely to give clients a fresh URL to cache against.
  router.use((req, res, next) => {
    req.url = req.url.replace(/^\/([^/]+)\/v[0-9][\w.]*\//, '/$1/')
    next()
  })

  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    // The security middleware stamps every response with
    // Cross-Origin-Resource-Policy: same-origin, which tells a browser to
    // refuse the bytes when the page asking is on another origin - the
    // right default for the dashboard, and exactly wrong here: posters at
    // /<token>/img are shown by Stremio Web, by a Nuvio Collections preview
    // on another SlickSync instance, by anything on any origin. Those
    // <img> loads were being blocked at the browser with the image already
    // downloaded, a blank tile where the catalog itself had loaded fine.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
    next()
  })

  // Pictures uploaded to SlickSync, for the AIOStreams and AIOMetadata apps
  // that show someone's picture from a web address (utils/serverAvatars.js
  // pushPicture). Under /trax/ because a login gate in front of SlickSync
  // lets this path through; each file's random name is the only way to it,
  // as it is at /uploads/avatars.
  router.get('/pictures/:file', (req, res) => {
    const m = /^([a-f0-9-]{36})\.(jpg|png|gif|webp)$/i.exec(String(req.params.file || ''))
    if (!m) return res.status(404).json({ error: 'Not found' })
    const file = require('path').join(require('../utils/serverAvatars').AVATAR_DIR, `${m[1]}.${m[2]}`)
    if (!require('fs').existsSync(file)) return res.status(404).json({ error: 'Not found' })
    res.type(m[2].toLowerCase() === 'jpg' ? 'image/jpeg' : `image/${m[2].toLowerCase()}`)
    res.sendFile(file)
  })

  // The stream addon a paused AIOMetadata user is pointed at while a daily
  // limit or bedtime holds (utils/aiomPause.js): every title has nothing to
  // play, so their apps still browse and the next thing they press play on
  // finds nothing - what a pause does everywhere else. Under /trax/ because
  // AIOMetadata asks for it from its own server, past any login gate. Never
  // cached, so the moment a pause ends nothing stale stands in for it.
  router.get('/paused/manifest.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ id: 'slicksync.paused', version: '1.0.0', name: 'SlickSync - paused', description: 'Streaming is paused', resources: ['stream'], types: ['movie', 'series'], catalogs: [] })
  })
  router.get('/paused/stream/:type/:id.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ streams: [] })
  })

  // The gate a person's stream addons go through while they have a pause set
  // up (utils/streamGate.js): the manifest from here, streams empty while
  // they're paused, everything else redirected to the real addon. Never
  // cached - a remembered redirect would carry on past the start of a pause.
  router.use('/gate/:token/:addonId/:hash', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') return res.status(204).end()
    try {
      const { resolveGate } = require('../utils/streamGate')
      const found = await resolveGate(prisma, req.params.token, req.params.addonId)
      if (!found) return res.status(404).json({ error: 'Not found' })
      const rest = req.path.replace(/^\/+/, '')
      if (!rest || rest === 'manifest.json') return res.json(found.manifest)
      if (rest.startsWith('stream/') && await require('../utils/screenTime').isStreamingPaused(prisma, found.accountId, found.personId)) {
        return res.json({ streams: [] })
      }
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
      res.redirect(302, `${found.upstreamBase}/${rest}${query}`)
    } catch (e) {
      console.error('[TraxAddon] gate failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  async function resolveUser(token) {
    if (!token || typeof token !== 'string' || token.length < 16) return null
    const user = await prisma.user.findFirst({ where: { traxToken: token, traxAddonEnabled: true } })
    return user || null
  }

  // The poster proxy, reachable wherever the addon itself is. Same image
  // cache as /api/img - this is a second doorway to it, not a second copy -
  // with the token checked first so it is not an open proxy.
  const imageProxy = require('./imageCache')()
  router.use('/:token/img', async (req, res, next) => {
    try {
      const user = await resolveUser(req.params.token)
      if (!user) return res.status(404).json({ error: 'Not found' })
      next()
    } catch {
      res.status(500).json({ error: 'Internal error' })
    }
  }, imageProxy)

  router.get('/:token/manifest.json', async (req, res) => {
    try {
      const user = await resolveUser(req.params.token)
      if (!user) return res.status(404).json({ error: 'Not found' })
      const lists = await getListsForAccount(prisma, user.accountId)
      res.json(buildTraxManifest(user, lists))
    } catch (e) {
      console.error('[TraxAddon] manifest failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // --- Watch State, for AIOStreams (utils/watchState.js) -------------------
  //
  // A separate link from the one sync installs into Stremio and Nuvio: this
  // one declares only the `watch_state` resource and no catalogs, and it is
  // added by hand to an AIOStreams configuration. Keeping it apart means
  // Stremio and Nuvio never see a resource they do not understand, and an
  // AIOStreams household does not get SlickTrax's rows twice over.
  //
  // It answers only while the link owner's own Watch State switch is on;
  // the token is the same credential the main link uses.
  async function resolveWatchStateOwner(token) {
    if (!token || typeof token !== 'string' || token.length < 16) return null
    return prisma.user.findFirst({ where: { traxToken: token, watchStateEnabled: true } })
  }

  // A household profile's own link (/p/<profile id>/) - set on that profile in
  // AIOStreams by a variant - serves that profile's collections. Watch
  // history on it works as on the plain link: AIOStreams still names the
  // viewer on every watch-state request. Someone else's profile, or one that
  // is gone, falls back to the login's collections rather than failing.
  async function collectionsProfile(owner, profile) {
    if (!profile) return null
    const row = await prisma.jellyfinProfile.findFirst({ where: { id: String(profile), ownerUserId: owner.id }, select: { id: true } })
    return row ? row.id : null
  }

  // Never cached: these answers change with every viewing, and a shared cache
  // in front would hand one household's history to whoever asked next.
  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store')
  }

  router.get(['/:token/aio/manifest.json', '/:token/aio/p/:profile/manifest.json'], async (req, res) => {
    noStore(res)
    try {
      const owner = await resolveWatchStateOwner(req.params.token)
      if (!owner) return res.status(404).json({ error: 'Not found' })
      const { manifestBlock } = require('../utils/watchState')
      res.json({
        id: `vip.slicksync.trax.watchstate.${owner.id}`,
        version: TRAX_MANIFEST_VERSION,
        name: 'SlickTrax watch history',
        description: `Keeps ${owner.username || 'this household'}'s watch history in SlickSync in step with AIOStreams - what you watch here is recorded there, and what you watched anywhere else shows up here. SlickSync's catalogs come along as collections.`,
        logo: 'https://slicksync.vip/android-chrome-192x192.png',
        types: ['movie', 'series'],
        idPrefixes: ['tt', COLLECTION_PREFIX],
        // SlickSync's catalogs, as AIOStreams collections: a catalog whose
        // entries are all collections is a Collections library in its apps
        // and in every Jellyfin app signed in to it (see the collection
        // routes below).
        catalogs: [{ type: 'movie', id: COLLECTIONS_CATALOG, name: 'SlickSync catalogs' }],
        resources: [
          { name: 'catalog', types: ['movie'] },
          { name: 'meta', types: ['movie'], idPrefixes: [COLLECTION_PREFIX] },
          { name: 'watch_state', types: ['movie', 'series'], idPrefixes: ['tt'] },
        ],
        watchState: manifestBlock(),
        behaviorHints: { configurable: false, configurationRequired: false },
      })
    } catch (e) {
      console.error('[TraxAddon] watch-state manifest failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post(['/:token/aio/watch_state/push/:type/:id.json', '/:token/aio/p/:profile/watch_state/push/:type/:id.json'], async (req, res) => {
    noStore(res)
    try {
      const owner = await resolveWatchStateOwner(req.params.token)
      // Off means nothing is recorded. A 401/403 would make AIOStreams hold
      // the backlog and deliver it once this is turned back on; any other 4xx
      // has it drop the event, which is what off promises.
      if (!owner) return res.status(410).json({ error: 'Watch State is off for this link' })
      // AIOStreams is still sending - for the "nothing for a week" check (utils/aioSlickTrax.js).
      require('../utils/aioSlickTrax').notePush(prisma, owner).catch(() => {})
      const { resolveViewer, handlePush } = require('../utils/watchState')
      const user = await resolveViewer(prisma, owner, req.query.viewer)
      // An unknown profile is answered 404, which drops that event without a
      // retry - the protocol's prescribed answer, and never a wrong attribution.
      if (!user) return res.status(404).json({ error: 'Unknown viewer' })
      const status = await handlePush(prisma, user, req.params.type, req.params.id, req.body)
      res.status(status).json({ ok: status < 300 })
    } catch (e) {
      console.error('[TraxAddon] watch-state push failed:', e?.message)
      res.status(503).json({ error: 'Try again later' })
    }
  })

  router.get(['/:token/aio/watch_state/pull.json', '/:token/aio/p/:profile/watch_state/pull.json'], async (req, res) => {
    noStore(res)
    try {
      const owner = await resolveWatchStateOwner(req.params.token)
      if (!owner) return res.status(410).json({ error: 'Watch State is off for this link' })
      const { resolveViewer, buildPull } = require('../utils/watchState')
      const user = await resolveViewer(prisma, owner, req.query.viewer)
      if (!user) return res.status(404).json({ error: 'Unknown viewer' })
      res.json(await buildPull(prisma, user, typeof req.query.since === 'string' ? req.query.since : null))
    } catch (e) {
      console.error('[TraxAddon] watch-state pull failed:', e?.message)
      res.status(503).json({ error: 'Try again later' })
    }
  })

  // --- SlickSync's catalogs as AIOStreams collections ----------------------
  //
  // On the AIOStreams link only. Each catalog is one collection whose
  // members are its titles; AIOStreams fills in their details from its own
  // metadata addons, so a member opens and plays like it does anywhere else.

  // The collections and their order come from utils/aioCollections.js: one
  // per catalog until the household arranges them on the AIOStreams
  // Collections page.
  function collectionPreview(base, token, collection, cover) {
    return {
      id: `${COLLECTION_PREFIX}${collection.id}`,
      type: 'movie',
      name: collection.name,
      poster: proxiedPoster(base, token, cover),
      posterShape: 'poster',
      // Marks the entry as a collection without opening it, as the protocol asks.
      collection: {},
    }
  }

  router.get(['/:token/aio/catalog/:type/:id.json', '/:token/aio/p/:profile/catalog/:type/:id.json'], async (req, res) => {
    noStore(res)
    try {
      const owner = await resolveWatchStateOwner(req.params.token)
      if (!owner) return res.status(404).json({ error: 'Not found' })
      if (req.params.id !== COLLECTIONS_CATALOG) return res.json({ metas: [] })
      const base = requestBase(req)
      const { loadCollections, membersOf, coverOf } = require('../utils/aioCollections')
      const profileId = await collectionsProfile(owner, req.params.profile)
      const { collections, lists } = await loadCollections(prisma, owner.accountId, owner.id, profileId)
      const metas = []
      for (const c of collections) {
        if (c.hidden) continue
        const members = membersOf(c, lists)
        if (members.length) metas.push(collectionPreview(base, req.params.token, c, coverOf(c, lists, members)))
      }
      res.json({ metas })
    } catch (e) {
      console.error('[TraxAddon] collections catalog failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get(['/:token/aio/meta/:type/:id.json', '/:token/aio/p/:profile/meta/:type/:id.json'], async (req, res) => {
    noStore(res)
    try {
      const owner = await resolveWatchStateOwner(req.params.token)
      if (!owner) return res.status(404).json({ error: 'Not found' })
      const id = String(req.params.id || '')
      if (!id.startsWith(COLLECTION_PREFIX)) return res.status(404).json({ error: 'Not found' })
      const { loadCollections, membersOf, coverOf } = require('../utils/aioCollections')
      const profileId = await collectionsProfile(owner, req.params.profile)
      const { collections, lists } = await loadCollections(prisma, owner.accountId, owner.id, profileId)
      const collection = collections.find((c) => c.id === id.slice(COLLECTION_PREFIX.length))
      if (!collection) return res.status(404).json({ error: 'Not found' })
      const base = requestBase(req)
      const members = membersOf(collection, lists)
      const first = lists.find((l) => l.id === collection.catalogIds[0])
      res.json({
        meta: {
          ...collectionPreview(base, req.params.token, collection, coverOf(collection, lists, members)),
          ...(collection.catalogIds.length === 1 && first?.description ? { description: first.description } : {}),
          collection: {
            items: members.map((i) => ({
              id: String(i.id),
              type: i.type === 'series' ? 'series' : 'movie',
              name: i.name || String(i.id),
              ...(i.poster ? { poster: proxiedPoster(base, req.params.token, i.poster) } : {}),
            })),
          },
        },
      })
    } catch (e) {
      console.error('[TraxAddon] collection meta failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get('/:token/catalog/:type/:id.json', async (req, res) => {
    try {
      const user = await resolveUser(req.params.token)
      if (!user) return res.status(404).json({ error: 'Not found' })
      const type = req.params.type === 'series' ? 'series' : 'movie'
      const catalogId = req.params.id
      const base = requestBase(req)

      if (catalogId === 'slicktrax-continue') {
        // One MIXED row: movies and shows together, most recent first -
        // exactly the order you stopped watching things in. The requested
        // type is ignored (the manifest declares this catalog once under
        // 'series' as its protocol anchor; accounts still carrying the old
        // two-entry manifest get the same mixed row for either request).
        const { getContinueWatching } = require('../utils/continueWatching')
        const entries = await getContinueWatching(prisma, user.accountId, 40)
        const metas = entries
          .filter((e) => e.userId === user.id && /^tt\d+$/.test(e.showId || ''))
          .map((e) => metaPreview(e.showId, e.contentType === 'movie' ? 'movie' : 'series', e.showName, proxiedPoster(base, req.params.token, e.poster)))
        return res.json({ metas })
      }

      if (catalogId === 'slicktrax-watchlist') {
        // Honours the manual ranking set in SlickSync (sortOrder ascending,
        // unranked newest-first behind it), so the row on the device reads
        // in the order the household actually chose rather than by add date.
        const all = await prisma.watchlistItem.findMany({
          where: { accountId: user.accountId, itemType: type },
          orderBy: { addedAt: 'desc' },
          take: 200,
        })
        const items = [
          ...all.filter((i) => Number.isInteger(i.sortOrder)).sort((a, b) => a.sortOrder - b.sortOrder),
          ...all.filter((i) => !Number.isInteger(i.sortOrder)),
        ].slice(0, 100)
        return res.json({ metas: items.filter((i) => /^tt\d+$/.test(i.itemId)).map((i) => metaPreview(i.itemId, type, i.name, proxiedPoster(base, req.params.token, i.poster))) })
      }

      if (catalogId.startsWith('slicktrax-list-')) {
        const listId = catalogId.slice('slicktrax-list-'.length)
        const list = await prisma.customList.findFirst({ where: { id: listId, accountId: user.accountId } })
        if (!list) return res.json({ metas: [] })
        let items = []
        try { items = JSON.parse(list.itemsJson || '[]') } catch { items = [] }
        const metas = (Array.isArray(items) ? items : [])
          // Untyped items (hand-added before types were tracked) default to
          // the movie half rather than vanishing from both.
          .filter((i) => i && /^tt\d+$/.test(String(i.id || '')) && ((i.type || 'movie') === type))
          .slice(0, 200)
          .map((i) => metaPreview(String(i.id), type, i.name, proxiedPoster(base, req.params.token, i.poster)))
        return res.json({ metas })
      }

      return res.json({ metas: [] })
    } catch (e) {
      console.error('[TraxAddon] catalog failed:', e?.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })


  return router
}

module.exports.buildTraxManifest = buildTraxManifest
module.exports.getListsForAccount = getListsForAccount
module.exports.TRAX_MANIFEST_VERSION = TRAX_MANIFEST_VERSION
module.exports.traxPathVersion = traxPathVersion
module.exports.orderedTraxRows = orderedTraxRows
module.exports.parseTraxRows = parseTraxRows
