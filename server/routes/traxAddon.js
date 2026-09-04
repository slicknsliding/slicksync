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
const TRAX_MANIFEST_VERSION = '1.6.0'

const CACHE_SECONDS = 60 // catalogs recompute cheaply; 60s keeps app scrolling snappy without staleness anyone would notice

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
function proxiedPoster(base, poster) {
  if (!base || !poster || !/^https?:\/\//i.test(poster)) return poster || undefined
  try {
    // Never wrap a URL already served by this instance (e.g. /api/poster's
    // RPDB redirects) - that would just proxy ourselves.
    if (new URL(poster).host === new URL(base).host) return poster
  } catch { return poster }
  return `${base}/api/img?src=${encodeURIComponent(poster)}&w=342`
}

function requestBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return host ? `${String(proto).split(',')[0]}://${host}` : null
}

/**
 * The manifest object, exported separately because sync injects the SAME
 * object inline into the account's addon collection - built in one place so
 * the served manifest and the synced copy can never drift apart.
 */
function buildTraxManifest(user, lists) {
  const catalogs = [
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
    { type: 'series', id: 'slicktrax-continue', name: 'Continue Watching' },
    { type: 'movie', id: 'slicktrax-watchlist', name: 'Watchlist' },
    { type: 'series', id: 'slicktrax-watchlist', name: 'Watchlist' },
  ]
  for (const list of lists || []) {
    // Registered under both types and filtered at serve time - a catalog
    // freely mixes movies and series, and Stremio's protocol wants a type
    // per catalog entry. An empty half is legal and renders as nothing.
    catalogs.push({ type: 'movie', id: `slicktrax-list-${list.id}`, name: list.name })
    catalogs.push({ type: 'series', id: `slicktrax-list-${list.id}`, name: list.name })
  }
  return {
    id: `vip.slicksync.trax.${user.id}`,
    version: TRAX_MANIFEST_VERSION,
    name: 'SlickTrax',
    description: `SlickTrax for ${user.username || 'this household'} - Continue Watching, Watchlist and Catalogs, live from SlickSync.`,
    logo: 'https://slicksync.vip/android-chrome-192x192.png',
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
    res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
    next()
  })

  async function resolveUser(token) {
    if (!token || typeof token !== 'string' || token.length < 16) return null
    const user = await prisma.user.findFirst({ where: { traxToken: token, traxAddonEnabled: true } })
    return user || null
  }

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
          .map((e) => metaPreview(e.showId, e.contentType === 'movie' ? 'movie' : 'series', e.showName, proxiedPoster(base, e.poster)))
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
        return res.json({ metas: items.filter((i) => /^tt\d+$/.test(i.itemId)).map((i) => metaPreview(i.itemId, type, i.name, proxiedPoster(base, i.poster))) })
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
          .map((i) => metaPreview(String(i.id), type, i.name, proxiedPoster(base, i.poster)))
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
