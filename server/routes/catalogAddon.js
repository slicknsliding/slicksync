const express = require('express')

// Serves an opt-in catalog (CustomList.addonEnabled) as a real, installable
// Stremio/Nuvio addon - genuinely public and unauthenticated, same as every
// Stremio addon has to be (Stremio has no login concept when fetching a
// catalog). Every catalog feature already built (import, auto-refresh, NL
// building, Suggest Titles, content-rating allowlist) previously died at
// the browser; this is the payoff - whatever a catalog contains now shows
// up natively inside Stremio/Nuvio's own Discover, kept in sync with
// whatever SlickSync's own UI last saved to it.
//
// Two resource endpoints per Stremio's addon protocol:
//   GET /addon/catalog/:listId/manifest.json
//   GET /addon/catalog/:listId/catalog/:type/:catalogId.json
// catalogId is always :listId itself (one catalog id, offered under both
// 'movie' and 'series' types in the manifest) - Stremio calls back with
// whichever type the user is browsing.
module.exports = ({ prisma }) => {
  const router = express.Router()

  const parseItems = (raw) => {
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] }
    catch { return [] }
  }

  async function loadEnabledList(listId) {
    const list = await prisma.customList.findFirst({ where: { id: listId, addonEnabled: true } })
    return list
  }

  router.get('/:listId/manifest.json', async (req, res) => {
    try {
      const list = await loadEnabledList(req.params.listId)
      if (!list) return res.status(404).json({ error: 'This catalog is not available as an addon' })

      res.json({
        id: `com.slicksync.catalog.${list.id}`,
        version: '1.0.0',
        name: list.name,
        description: list.description || `A SlickSync catalog: ${list.name}`,
        resources: ['catalog'],
        types: ['movie', 'series'],
        catalogs: [
          { type: 'movie', id: list.id, name: list.name },
          { type: 'series', id: list.id, name: list.name },
        ],
        // No idPrefixes restriction - items carry real imdb-style ids
        // already, same as every other real Stremio addon.
        behaviorHints: { configurable: false },
      })
    } catch (error) {
      console.error('Error serving catalog addon manifest:', error)
      res.status(500).json({ error: 'Failed to build manifest' })
    }
  })

  router.get('/:listId/catalog/:type/:catalogId.json', async (req, res) => {
    try {
      const { listId, type } = req.params
      if (type !== 'movie' && type !== 'series') return res.json({ metas: [] })

      const list = await loadEnabledList(listId)
      if (!list) return res.status(404).json({ error: 'This catalog is not available as an addon' })

      const items = parseItems(list.itemsJson).filter((i) => i.type === type)
      const metas = items.map((i) => ({
        id: i.id,
        type: i.type,
        name: i.name,
        poster: i.poster || undefined,
        releaseInfo: i.year ? String(i.year) : undefined,
      }))
      res.json({ metas })
    } catch (error) {
      console.error('Error serving catalog addon catalog response:', error)
      res.status(500).json({ error: 'Failed to build catalog' })
    }
  })

  return router
}
