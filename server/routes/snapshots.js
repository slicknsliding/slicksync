const { safeFetch, instancePolicy } = require('../utils/safeUrl');
const { publicMessage } = require('../utils/publicError');
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
          where: { groupId: group.id, isEnabled: true, addon: { accountId } },
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

  // POST /api/snapshots/import - create a snapshot directly from an addon
  // list instead of reading a live user/group. Exists for share codes
  // (client/lib/shareCodes.ts SSA1:): the code carries plaintext manifest
  // URLs from the exporting instance; they're encrypted at rest HERE with
  // this instance's own key, same as user-sourced snapshots.
  router.post('/import', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { name, description, addons } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!Array.isArray(addons) || addons.length === 0) {
        return res.status(400).json({ error: 'addons array is required' });
      }
      if (addons.length > 200) {
        return res.status(400).json({ error: 'Too many addons (max 200)' });
      }
      const addonList = addons
        .filter((a) => a && typeof a === 'object' && typeof a.name === 'string')
        .map((a) => ({
          name: a.name,
          manifestUrl: typeof a.manifestUrl === 'string' && /^(https?|stremio):\/\//i.test(a.manifestUrl)
            ? encrypt(a.manifestUrl.replace(/^stremio:\/\//i, 'https://'), req)
            : null,
          stremioAddonId: typeof a.stremioAddonId === 'string' ? a.stremioAddonId : null,
          version: typeof a.version === 'string' ? a.version : null,
        }));
      if (addonList.length === 0) {
        return res.status(400).json({ error: 'No valid addons in the list' });
      }

      const snapshot = await prisma.addonSnapshot.create({
        data: {
          accountId,
          name: name.trim(),
          description: typeof description === 'string' && description.trim() ? description.trim() : null,
          sourceType: 'import',
          sourceId: 'share-code',
          addonsJson: JSON.stringify(addonList),
        },
      });
      res.status(201).json({ id: snapshot.id, name: snapshot.name, addonCount: addonList.length });
    } catch (error) {
      console.error('Error importing snapshot:', error);
      res.status(500).json({ error: 'Failed to import template' });
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

      // Re-fetch each manifest fresh (addons may have updated since the snapshot was taken)
      // rather than deploying stale cached manifest data. An address this server cannot reach
      // (Stremio's Local Files addon lives on the person's own computer) falls back to the
      // manifest the template carries, and is left out when there is none. `failed` holds the
      // names of the addons left out (never their addresses, which carry keys).
      const collection = [];
      const failed = [];
      for (const a of addons) {
        // An entry saved without an address has nothing to fetch and never counted as a failure.
        if (!a?.manifestUrl) continue;
        const label = (typeof a.name === 'string' && a.name) || 'Unknown';
        let url = null;
        try { url = decrypt(a.manifestUrl, req); } catch { url = null; }
        if (!url) { failed.push(label); continue; }
        let manifest = null;
        try {
          const resp = await safeFetch(url, {}, instancePolicy());
          if (resp.ok) manifest = await resp.json();
        } catch {
          manifest = null;
        }
        if (!manifest && a.manifest && typeof a.manifest === 'object' && !Array.isArray(a.manifest)) {
          manifest = a.manifest;
        }
        if (!manifest) { failed.push(label); continue; }
        collection.push({ transportUrl: url, transportName: '', manifest });
      }

      // A template that names addons must never be written as an empty list: that would
      // take everything off their account. Anything less than that is deployed as it was at
      // HEAD, with the addons that could not be fetched left out and named in the answer.
      if (addons.length > 0 && collection.length === 0) {
        return res.status(502).json({
          error: 'None of the addons in this template could be fetched, so nothing was changed on their account',
          failed,
        });
      }

      const provider = createProvider(targetUser, { decrypt, req });
      if (!provider) {
        return res.status(400).json({ error: 'Target user is not connected to a provider (no auth key/token on file)' });
      }
      await provider.setAddons(collection);
      await require('../utils/accountGuard').recordAssertedState(prisma, targetUserId, targetUser.providerType, collection);

      const answer = { deployed: collection.length, failed: failed.length, targetUserId };
      if (failed.length > 0) answer.leftOut = failed;
      res.json(answer);
    } catch (error) {
      console.error('Error deploying snapshot:', error);
      // Their list may have been left empty, which the admin has to act on, so this
      // message goes through as it is.
      if (error?.code === 'ADDON_LIST_NOT_RESTORED') return res.status(500).json({ error: publicMessage(error, 'Something went wrong') });
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
