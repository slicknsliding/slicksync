const express = require('express');

// SlickSync's own personal-watchlist API + a batched "have I watched this?"
// lookup that Discover uses to overlay ✓ badges on poster cards.
//
// Watchlist: account-scoped bookmark list of things you want to watch.
// Add from any Discover poster or the MediaDetailModal; remove anytime.
// The stored `name` + `poster` mean the list renders without a Cinemeta
// round-trip per item (same pattern as *WatchHistory rows).
//
// Watched-status: batch a list of IMDb ids against MovieWatchHistory and
// EpisodeWatchHistory (any user on this account counts as "watched by us")
// and return a { id: true } map. Batched because Discover asks about a
// whole grid at once — 100+ ids per request.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  // GET /api/watchlist — list, newest-added first.
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const items = await prisma.watchlistItem.findMany({
        where: { accountId },
        orderBy: { addedAt: 'desc' },
      });
      res.json(items);
    } catch (e) {
      console.error('Error fetching watchlist:', e);
      res.status(500).json({ error: 'Failed to fetch watchlist' });
    }
  });

  // POST /api/watchlist — add an item. Upserts so a repeat add is a no-op
  // (matches the "one row per (account, itemId)" unique constraint).
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { itemId, itemType, name, poster } = req.body || {};
      if (!itemId || !itemType || !name) {
        return res.status(400).json({ error: 'itemId, itemType, and name are required' });
      }
      if (itemType !== 'movie' && itemType !== 'series') {
        return res.status(400).json({ error: 'itemType must be movie or series' });
      }
      const entry = await prisma.watchlistItem.upsert({
        where: { accountId_itemId: { accountId, itemId } },
        create: { accountId, itemId, itemType, name, poster: poster || null },
        // Refresh display fields on re-add in case the title / poster changed
        // upstream; the addedAt timestamp is preserved so re-adding doesn't
        // silently bump items back to the top.
        update: { name, poster: poster || null, itemType },
      });
      res.status(201).json(entry);
    } catch (e) {
      console.error('Error adding to watchlist:', e);
      res.status(500).json({ error: 'Failed to add to watchlist' });
    }
  });

  // DELETE /api/watchlist/:itemId — remove.
  router.delete('/:itemId', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      await prisma.watchlistItem.deleteMany({ where: { accountId, itemId: req.params.itemId } });
      res.json({ success: true });
    } catch (e) {
      console.error('Error removing from watchlist:', e);
      res.status(500).json({ error: 'Failed to remove from watchlist' });
    }
  });

  // POST /api/watchlist/watched-status — body: { ids: string[] }
  // Returns { [id]: true } for any id that exists in EpisodeWatchHistory or
  // MovieWatchHistory for this account (any user counts). POST (not GET)
  // because the id list can be 100+ entries; keeping it out of the URL avoids
  // referer/log leakage and query-string length caps.
  router.post('/watched-status', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
      // Cap batch size so a runaway request can't scan the whole table.
      const ids = raw.slice(0, 500).filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) return res.json({});
      const [movies, episodes] = await Promise.all([
        prisma.movieWatchHistory.findMany({
          where: { accountId, itemId: { in: ids } },
          select: { itemId: true },
          distinct: ['itemId'],
        }),
        prisma.episodeWatchHistory.findMany({
          where: { accountId, showId: { in: ids } },
          select: { showId: true },
          distinct: ['showId'],
        }),
      ]);
      const out = {};
      for (const m of movies) out[m.itemId] = true;
      for (const e of episodes) out[e.showId] = true;
      res.json(out);
    } catch (e) {
      console.error('Error checking watched status:', e);
      res.status(500).json({ error: 'Failed to check watched status' });
    }
  });

  return router;
};
