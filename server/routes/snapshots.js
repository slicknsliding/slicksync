const express = require('express');

// Addon snapshots ("library"): save a named, portable copy of a user's or group's
// current addon set, and deploy it back to any user or group later.
//
// Storage note: manifestUrl values are stored encrypted (same convention as the
// Addon model) so a snapshot dump doesn't leak raw addon URLs/keys at rest.
module.exports = ({ prisma, getAccountId, encrypt, decrypt, createProvider }) => {
  const router = express.Router();

  // GET /api/snapshots - list snapshots for this account
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const snapshots = await prisma.addonSnapshot.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
      });
      const result = snapshots.map(s => {
        let addons = [];
        try { addons = JSON.parse(s.addonsJson || '[]'); } catch {}
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          sourceType: s.sourceType,
          sourceId: s.sourceId,
          addonCount: addons.length,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        };
      });
      res.json(result);
    } catch (error) {
      console.error('Error listing snapshots:', error);
      res.status(500).json({ error: 'Failed to list snapshots' });
    }
  });

  // GET /api/snapshots/:id - full snapshot detail (decrypted addon list)
  router.get('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const snapshot = await prisma.addonSnapshot.findFirst({
        where: { id: req.params.id, accountId },
      });
      if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

      let addons = [];
      try { addons = JSON.parse(snapshot.addonsJson || '[]'); } catch {}
      const decrypted = addons.map(a => ({
        ...a,
        manifestUrl: a.manifestUrl ? safeDecrypt(a.manifestUrl) : null,
      }));

      res.json({ ...snapshot, addons: decrypted, addonsJson: undefined });
    } catch (error) {
      console.error('Error fetching snapshot:', error);
      res.status(500).json({ error: 'Failed to fetch snapshot' });
    }

    function safeDecrypt(v) {
      try { return decrypt(v, req); } catch { return null; }
    }
  });

  // POST /api/snapshots - capture the current addon set of a user or group
  // body: { name, description?, sourceType: 'user'|'group', sourceId }
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { name, description, sourceType, sourceId } = req.body || {};

      if (!name || !sourceType || !sourceId) {
        return res.status(400).json({ error: 'name, sourceType, and sourceId are required' });
      }
      if (!['user', 'group'].includes(sourceType)) {
        return res.status(400).json({ error: "sourceType must be 'user' or 'group'" });
      }

      let addonList = [];

      if (sourceType === 'user') {
        const user = await prisma.user.findFirst({ where: { id: sourceId, accountId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const provider = createProvider(user, { decrypt, req });
        if (!provider) {
          return res.status(400).json({ error: 'User is not connected to a provider (no auth key/token on file)' });
        }
        const result = await provider.getAddons();
        const liveAddons = result?.addons || [];
        addonList = liveAddons.map(a => ({
          name: a.manifest?.name || a.transportName || 'Unknown',
          manifestUrl: a.transportUrl ? encrypt(a.transportUrl, req) : null,
          stremioAddonId: a.manifest?.id || null,
          version: a.manifest?.version || null,
        }));
      } else {
        const group = await prisma.group.findFirst({ where: { id: sourceId, accountId } });
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const groupAddons = await prisma.groupAddon.findMany({
          where: { groupId: group.id, isEnabled: true },
          include: { addon: true },
          orderBy: { position: 'asc' },
        });
        addonList = groupAddons.map(ga => ({
          name: ga.addon.name,
          manifestUrl: ga.addon.manifestUrl || null, // already encrypted at rest on Addon
          stremioAddonId: ga.addon.stremioAddonId || null,
          version: ga.addon.version || null,
        }));
      }

      const snapshot = await prisma.addonSnapshot.create({
        data: {
          accountId,
          name,
          description: description || null,
          sourceType,
          sourceId,
          addonsJson: JSON.stringify(addonList),
        },
      });

      res.status(201).json({ id: snapshot.id, name: snapshot.name, addonCount: addonList.length });
    } catch (error) {
      console.error('Error creating snapshot:', error);
      res.status(500).json({ error: 'Failed to create snapshot' });
    }
  });

  // POST /api/snapshots/:id/deploy - push a snapshot's addon set onto a target user
  // body: { targetUserId }
  router.post('/:id/deploy', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { targetUserId } = req.body || {};
      if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });

      const snapshot = await prisma.addonSnapshot.findFirst({
        where: { id: req.params.id, accountId },
      });
      if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

      const targetUser = await prisma.user.findFirst({ where: { id: targetUserId, accountId } });
      if (!targetUser) return res.status(404).json({ error: 'Target user not found' });

      let addons = [];
      try { addons = JSON.parse(snapshot.addonsJson || '[]'); } catch {}

      const urls = addons
        .map(a => {
          try { return a.manifestUrl ? decrypt(a.manifestUrl, req) : null; } catch { return null; }
        })
        .filter(Boolean);

      // Re-fetch each manifest fresh (addons may have updated since the snapshot was taken)
      // rather than deploying stale cached manifest data.
      const collection = [];
      const failed = [];
      for (const url of urls) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) { failed.push(url); continue; }
          const manifest = await resp.json();
          collection.push({ transportUrl: url, transportName: '', manifest });
        } catch {
          failed.push(url);
        }
      }

      const provider = createProvider(targetUser, { decrypt, req });
      if (!provider) {
        return res.status(400).json({ error: 'Target user is not connected to a provider (no auth key/token on file)' });
      }
      await provider.setAddons(collection);

      res.json({ deployed: collection.length, failed: failed.length, targetUserId });
    } catch (error) {
      console.error('Error deploying snapshot:', error);
      res.status(500).json({ error: 'Failed to deploy snapshot' });
    }
  });

  // DELETE /api/snapshots/:id
  router.delete('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const snapshot = await prisma.addonSnapshot.findFirst({
        where: { id: req.params.id, accountId },
      });
      if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

      await prisma.addonSnapshot.delete({ where: { id: snapshot.id } });
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting snapshot:', error);
      res.status(500).json({ error: 'Failed to delete snapshot' });
    }
  });

  return router;
};
