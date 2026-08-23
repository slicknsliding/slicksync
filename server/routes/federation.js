const express = require('express');
const crypto = require('crypto');

// Cross-instance catalog subscription.
//
// One household publishes a catalog; another subscribes to it by URL. What
// crosses the wire is the ITEM LIST and nothing else - no credentials, no
// addon manifests, no user identity, no watch state. The subscriber resolves
// those titles through its OWN addons and debrid, so the curation is shared
// and the streams never are.
//
// This router is deliberately the only publicly reachable part: it is
// allowlisted past the auth gate (see utils/auth.js) because the caller is
// another server, not a logged-in browser. The catalog's federationToken is
// what authorizes the read, so every handler here must verify it before
// returning anything - there is no session behind these requests to fall
// back on.
//
// The subscriber side needed almost no new code: a federation URL is just
// another importable source (see utils/listImport.js), so once imported it
// reuses "Refresh from source", the diff, autoRefresh and the daily worker
// exactly as a TMDb or MDBList catalog does.
module.exports = ({ prisma }) => {
  const router = express.Router();

  // Constant-time compare so a wrong token can't be narrowed by timing.
  // Length is checked first because timingSafeEqual throws on a mismatch.
  const tokenMatches = (provided, expected) => {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  };

  const parseItems = (raw) => {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  // GET /api/federation/catalog/:id?key=<token>
  //
  // Returns the same "not found" for a missing catalog, an unpublished one and
  // a wrong token. Distinguishing them would let anyone with a catalog id
  // probe whether it exists and whether it is published.
  router.get('/catalog/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const key = typeof req.query.key === 'string' ? req.query.key : '';
      if (!id || !key) return res.status(404).json({ message: 'Not found' });

      const list = await prisma.customList.findUnique({ where: { id } });
      if (!list || !list.federationToken) return res.status(404).json({ message: 'Not found' });
      if (!tokenMatches(key, list.federationToken)) return res.status(404).json({ message: 'Not found' });

      const items = parseItems(list.itemsJson).map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        year: item.year,
        poster: item.poster,
      }));

      // Cached briefly: a subscriber polls on a schedule, and several
      // subscribers on the same source shouldn't each cost a fresh read.
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        // Version the payload from day one - a subscriber on an older release
        // needs to be able to tell that it is talking to a newer publisher.
        federation: 1,
        name: list.name,
        description: list.description || null,
        // Lets the subscriber show "unchanged since last pull" without
        // diffing the whole array.
        updatedAt: list.updatedAt,
        itemCount: items.length,
        items,
      });
    } catch (error) {
      console.error('Federation read failed:', error?.message);
      res.status(500).json({ message: 'Failed to read catalog' });
    }
  });

  return router;
};
