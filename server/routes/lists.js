const express = require('express');

// Custom lists (roadmap #7): named, account-scoped collections of titles -
// the tier above the single personal Watchlist (routes/watchlist.js). An admin
// can keep any number ("Halloween Marathon", "Best of 2025", ...), add titles
// from any Discover poster or the MediaDetailModal, and open a list to browse
// its contents through the same modal used everywhere else.
//
// Items live as a stringified JSON array on CustomList.itemsJson (SQLite has no
// Json type - see the schema note), each { id, type, name, poster?, year? }, so
// a list renders without a Cinemeta round-trip per item (same pattern as the
// *WatchHistory / watchlist rows).
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  const parseItems = (raw) => {
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  };
  const shape = (list) => ({
    id: list.id,
    name: list.name,
    description: list.description || null,
    items: parseItems(list.itemsJson),
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  });
  // Normalize an incoming item to the stored shape; null if it's not usable.
  const normalizeItem = (body) => {
    const id = body?.id || body?.itemId;
    const type = body?.type || body?.itemType;
    const name = body?.name;
    if (!id || !name) return null;
    if (type !== 'movie' && type !== 'series') return null;
    return { id: String(id), type, name: String(name), poster: body.poster || null, year: body.year || null };
  };

  // GET /api/lists — all lists for this account, newest-updated first.
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const lists = await prisma.customList.findMany({
        where: { accountId },
        orderBy: { updatedAt: 'desc' },
      });
      res.json(lists.map(shape));
    } catch (e) {
      console.error('Error fetching custom lists:', e);
      res.status(500).json({ error: 'Failed to fetch lists' });
    }
  });

  // POST /api/lists — create a list. { name, description? }
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const list = await prisma.customList.create({
        data: { accountId, name, description: (req.body?.description || '').trim() || null, itemsJson: '[]' },
      });
      res.status(201).json(shape(list));
    } catch (e) {
      console.error('Error creating custom list:', e);
      res.status(500).json({ error: 'Failed to create list' });
    }
  });

  // PATCH /api/lists/:id — rename / re-describe. { name?, description? }
  router.patch('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const data = {};
      if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
      if (typeof req.body?.description === 'string') data.description = req.body.description.trim() || null;
      const list = await prisma.customList.update({ where: { id: existing.id }, data });
      res.json(shape(list));
    } catch (e) {
      console.error('Error updating custom list:', e);
      res.status(500).json({ error: 'Failed to update list' });
    }
  });

  // DELETE /api/lists/:id — remove the whole list.
  router.delete('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      await prisma.customList.delete({ where: { id: existing.id } });
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting custom list:', e);
      res.status(500).json({ error: 'Failed to delete list' });
    }
  });

  // POST /api/lists/:id/items — add a title. De-duped by item id (re-adding a
  // title already in the list is a no-op rather than a duplicate row).
  router.post('/:id/items', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const item = normalizeItem(req.body || {});
      if (!item) return res.status(400).json({ error: 'id, name, and a valid type are required' });
      const items = parseItems(existing.itemsJson);
      if (!items.some((i) => i.id === item.id)) items.push(item);
      const list = await prisma.customList.update({
        where: { id: existing.id },
        data: { itemsJson: JSON.stringify(items) },
      });
      res.json(shape(list));
    } catch (e) {
      console.error('Error adding item to custom list:', e);
      res.status(500).json({ error: 'Failed to add item' });
    }
  });

  // DELETE /api/lists/:id/items/:itemId — remove a title from the list.
  router.delete('/:id/items/:itemId', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const items = parseItems(existing.itemsJson).filter((i) => i.id !== req.params.itemId);
      const list = await prisma.customList.update({
        where: { id: existing.id },
        data: { itemsJson: JSON.stringify(items) },
      });
      res.json(shape(list));
    } catch (e) {
      console.error('Error removing item from custom list:', e);
      res.status(500).json({ error: 'Failed to remove item' });
    }
  });

  return router;
};
