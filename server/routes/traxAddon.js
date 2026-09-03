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

const CACHE_SECONDS = 60 // catalogs recompute cheaply; 60s keeps app scrolling snappy without staleness anyone would notice

function metaPreview(id, type, name, poster) {
  return { id, type, name: name || id, poster: poster || undefined }
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
    // "Continue Watching" rows. Declared once under 'all' (the handler has
    // ignored the requested type since the rows merged). Nuvio renders row
    // headers as name + type and appends new rows last - both are fixed
    // through its own synced home-catalog settings instead of protocol
    // tricks: sync writes a preference for this row with customTitle
    // "Continue Watching" and top position (utils/nuvioHomePlacement.js).
    { type: 'all', id: 'slicktrax-continue', name: 'Continue Watching' },
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
    // Bumped when the catalog layout changes shape - clients refresh
    // manifests from the transport URL on their own, and a changed version
    // makes the refresh stick.
    version: '1.4.0',
    name: 'SlickTrax',
    description: `SlickTrax for ${user.username || 'this household'} - Continue Watching, Watchlist and Catalogs, live from SlickSync.`,
    logo: 'https://slicksync.vip/android-chrome-192x192.png',
    resources: ['catalog'],
    types: ['movie', 'series', 'all'],
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
          .map((e) => metaPreview(e.showId, e.contentType === 'movie' ? 'movie' : 'series', e.showName, e.poster))
        return res.json({ metas })
      }

      if (catalogId === 'slicktrax-watchlist') {
        const items = await prisma.watchlistItem.findMany({
          where: { accountId: user.accountId, itemType: type },
          orderBy: { addedAt: 'desc' },
          take: 100,
        })
        return res.json({ metas: items.filter((i) => /^tt\d+$/.test(i.itemId)).map((i) => metaPreview(i.itemId, type, i.name, i.poster)) })
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
          .map((i) => metaPreview(String(i.id), type, i.name, i.poster))
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
