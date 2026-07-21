const express = require('express');

// Trakt integration API. Lets an account register a Trakt app (client_id/
// secret), authorize via device code, and scrobble SlickSync's own watch
// record to Trakt. Secrets/tokens live in AppAccount.sync.trakt and are never
// returned to the client — only the public status view is. See
// utils/trakt.js for the why.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();
  const trakt = require('../utils/trakt');

  const acct = (req) => getAccountId(req) || 'default';

  // GET /api/trakt/status — configured/connected/username/lastSync/pending.
  router.get('/status', async (req, res) => {
    try {
      const cfg = await trakt.getTraktConfig(prisma, acct(req));
      res.json(trakt.publicStatus(cfg));
    } catch (e) {
      res.status(500).json({ error: 'Failed to read Trakt status' });
    }
  });

  // POST /api/trakt/credentials — save Client ID + Secret. Passing empty
  // strings clears them (and disconnects).
  router.post('/credentials', async (req, res) => {
    try {
      const { clientId, clientSecret } = req.body || {};
      const cid = typeof clientId === 'string' ? clientId.trim() : '';
      const csec = typeof clientSecret === 'string' ? clientSecret.trim() : '';
      if (!cid || !csec) {
        await trakt.disconnect(prisma, acct(req));
        await trakt.patchTraktConfig(prisma, acct(req), { clientId: undefined, clientSecret: undefined });
        return res.json(trakt.publicStatus(await trakt.getTraktConfig(prisma, acct(req))));
      }
      await trakt.patchTraktConfig(prisma, acct(req), { clientId: cid, clientSecret: csec });
      res.json(trakt.publicStatus(await trakt.getTraktConfig(prisma, acct(req))));
    } catch (e) {
      res.status(500).json({ error: 'Failed to save Trakt credentials' });
    }
  });

  // POST /api/trakt/connect — start device auth. Returns the code the user
  // enters at trakt.tv/activate.
  router.post('/connect', async (req, res) => {
    try {
      const started = await trakt.startDeviceAuth(prisma, acct(req));
      res.json(started);
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Failed to start Trakt authorization' });
    }
  });

  // POST /api/trakt/connect/poll — the client polls this until authorized.
  router.post('/connect/poll', async (req, res) => {
    try {
      const result = await trakt.pollDeviceToken(prisma, acct(req));
      const status = trakt.publicStatus(await trakt.getTraktConfig(prisma, acct(req)));
      res.json({ phase: result.status, status });
    } catch (e) {
      res.status(500).json({ error: 'Failed to check Trakt authorization' });
    }
  });

  // POST /api/trakt/disconnect — drop tokens (keeps client_id/secret so the
  // user can reconnect without re-pasting).
  router.post('/disconnect', async (req, res) => {
    try {
      await trakt.disconnect(prisma, acct(req));
      res.json(trakt.publicStatus(await trakt.getTraktConfig(prisma, acct(req))));
    } catch (e) {
      res.status(500).json({ error: 'Failed to disconnect Trakt' });
    }
  });

  // GET /api/trakt/watchlist — the connected account's Trakt watchlist,
  // shaped like DiscoverItem[] for the Discover grid. 409 if not connected.
  router.get('/watchlist', async (req, res) => {
    try {
      const items = await trakt.getTraktWatchlist(prisma, acct(req));
      if (items === null) return res.status(409).json({ error: 'Trakt is not connected' });
      res.json(items);
    } catch (e) {
      res.status(502).json({ error: e?.message || 'Failed to fetch Trakt watchlist' });
    }
  });

  // POST /api/trakt/sync-now — run a scrobble sweep immediately.
  router.post('/sync-now', async (req, res) => {
    try {
      const result = await trakt.scrobbleNewWatches(prisma, acct(req));
      if (result === null) return res.status(400).json({ error: 'Trakt is not connected' });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(502).json({ error: e?.message || 'Trakt sync failed' });
    }
  });

  return router;
};
