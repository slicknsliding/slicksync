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
    coverImageUrl: list.coverImageUrl || null,
    coverColorIndex: list.coverColorIndex ?? null,
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

  // POST /api/lists/import — create a list from a pasted TMDb or MDBList URL.
  // { url, name? } - name overrides the source list's own name if given.
  // Provider is auto-detected from the URL host, so this is the only import
  // entry point (no separate per-provider routes/UI).
  router.post('/import', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const url = String(req.body?.url || '').trim();
      if (!url) return res.status(400).json({ error: 'url is required' });

      const { detectProvider, importFromTmdb, importFromMdblist, resolveTmdbKey, resolveMdblistKey } = require('../utils/listImport');
      const provider = detectProvider(url);
      if (!provider) {
        return res.status(400).json({ error: 'Unrecognized list URL - paste a TMDb (themoviedb.org/list/...) or MDBList (mdblist.com/lists/...) list URL' });
      }

      let result;
      if (provider === 'tmdb') {
        const key = await resolveTmdbKey(prisma, getAccountId, req);
        result = await importFromTmdb(key, url);
      } else {
        const key = await resolveMdblistKey(prisma, getAccountId, req);
        result = await importFromMdblist(key, url);
      }

      if (result.items.length === 0) {
        return res.status(422).json({ error: 'That list has no importable titles (or none could be resolved to an IMDb id)' });
      }

      const name = (req.body?.name || '').trim() || result.name;
      const list = await prisma.customList.create({
        data: { accountId, name, itemsJson: JSON.stringify(result.items) },
      });
      res.status(201).json({ ...shape(list), truncated: !!result.truncated, totalAvailable: result.totalAvailable });
    } catch (e) {
      console.error('Error importing list:', e);
      res.status(400).json({ error: e?.message || 'Failed to import list' });
    }
  });

  // PATCH /api/lists/:id — rename / re-describe / set cover art.
  // { name?, description?, coverImageUrl?, coverColorIndex? } - cover fields
  // accept `null` explicitly to clear back to the auto-collage fallback.
  router.patch('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const body = req.body || {};
      const data = {};
      if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
      if (typeof body.description === 'string') data.description = body.description.trim() || null;
      if ('coverImageUrl' in body) data.coverImageUrl = body.coverImageUrl ? String(body.coverImageUrl) : null;
      if ('coverColorIndex' in body) data.coverColorIndex = body.coverColorIndex === null || body.coverColorIndex === undefined ? null : Number(body.coverColorIndex);
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

  // PATCH /api/lists/:id/items/reorder — persist a manual drag-reorder.
  // { orderedIds: string[] } must contain EXACTLY the list's current item
  // ids (same set, any order) - rejected otherwise, since itemsJson is one
  // opaque JSON blob with no relational position column to reconcile a
  // partial/stale reorder against (e.g. a client that missed a concurrent
  // add/remove in another tab).
  router.patch('/:id/items/reorder', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(String) : null;
      if (!orderedIds) return res.status(400).json({ error: 'orderedIds must be an array' });

      const items = parseItems(existing.itemsJson);
      const currentIds = new Set(items.map((i) => i.id));
      const sameSet = orderedIds.length === items.length
        && new Set(orderedIds).size === items.length
        && orderedIds.every((id) => currentIds.has(id));
      if (!sameSet) {
        return res.status(400).json({ error: 'orderedIds must match the list\'s current items exactly (it may have changed since you loaded it)' });
      }

      const byId = new Map(items.map((i) => [i.id, i]));
      const reordered = orderedIds.map((id) => byId.get(id));
      const list = await prisma.customList.update({
        where: { id: existing.id },
        data: { itemsJson: JSON.stringify(reordered) },
      });
      res.json(shape(list));
    } catch (e) {
      console.error('Error reordering custom list items:', e);
      res.status(500).json({ error: 'Failed to reorder items' });
    }
  });

  // GET /api/lists/:id/suggest?query= — propose titles for this catalog by
  // theme (TMDb keyword search, seeded from the catalog's own name unless
  // ?query= overrides it). Read-only: returns candidates for the caller to
  // review and add one-by-one via the existing POST .../items - nothing is
  // ever added automatically by this endpoint itself.
  router.get('/:id/suggest', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });

      const { suggestTitlesForCatalog, resolveTmdbKey } = require('../utils/listImport');
      const key = await resolveTmdbKey(prisma, getAccountId, req);
      const query = (typeof req.query.query === 'string' && req.query.query.trim()) ? req.query.query.trim() : existing.name;
      const existingIds = parseItems(existing.itemsJson).map((i) => i.id);
      const suggestions = await suggestTitlesForCatalog(key, query, existingIds);
      res.json({ suggestions, query });
    } catch (e) {
      console.error('Error suggesting catalog titles:', e);
      res.status(400).json({ error: e?.message || 'Failed to suggest titles' });
    }
  });

  // POST /api/lists/:id/export-mdblist — create a brand-new MDBList list
  // from this catalog's current items. One-way: this app can create the
  // list, but wiring it into a Stremio/Nuvio addon (e.g. AIOMetadata) as a
  // catalog source is a manual step in that addon's own config afterward.
  router.post('/:id/export-mdblist', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.customList.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      const items = parseItems(existing.itemsJson);
      if (items.length === 0) return res.status(422).json({ error: 'This catalog has no titles to export' });

      const { exportListToMdblist, resolveMdblistKey } = require('../utils/listImport');
      const key = await resolveMdblistKey(prisma, getAccountId, req);
      const result = await exportListToMdblist(key, existing.name, items);
      res.json(result);
    } catch (e) {
      console.error('Error exporting list to MDBList:', e);
      res.status(400).json({ error: e?.message || 'Failed to export to MDBList' });
    }
  });

  return router;
};
