const express = require('express');
const { runCheck } = require('../utils/vaultCheckers');

const CATEGORIES = [
  'debrid', 'usenet_provider', 'usenet_indexer', 'stremio', 'nuvio',
  'metadata', 'ai', 'vpn', 'aiostreams', 'custom'
];

module.exports = ({ prisma, getAccountId, encrypt, decrypt }) => {
  const router = express.Router();

  // GET /api/vault - list entries (secrets never included in list view)
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { category } = req.query;
      const entries = await prisma.vaultEntry.findMany({
        where: { accountId, ...(category ? { category } : {}) },
        orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
      });

      const counts = {};
      const all = await prisma.vaultEntry.findMany({ where: { accountId }, select: { category: true } });
      for (const c of CATEGORIES) counts[c] = 0;
      for (const e of all) counts[e.category] = (counts[e.category] || 0) + 1;

      res.json({
        total: all.length,
        categories: counts,
        entries: entries.map(e => ({
          id: e.id, name: e.name, category: e.category, provider: e.provider,
          dashboardUrl: e.dashboardUrl, expiresAt: e.expiresAt, notifyDaysBefore: e.notifyDaysBefore,
          lastCheckedAt: e.lastCheckedAt, lastCheckStatus: e.lastCheckStatus, lastCheckMessage: e.lastCheckMessage,
          isActive: e.isActive, testType: e.testType, secretLabel: e.secretLabel, updatedAt: e.updatedAt,
          position: e.position,
        })),
      });
    } catch (error) {
      console.error('Error listing vault entries:', error);
      res.status(500).json({ error: 'Failed to list vault entries' });
    }
  });

  // GET /api/vault/:id - detail (secret masked; use /reveal for the real value)
  router.get('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const entry = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!entry) return res.status(404).json({ error: 'Vault entry not found' });
      const { encryptedSecret, testConfig, ...rest } = entry;
      res.json({ ...rest, testConfig: testConfig ? JSON.parse(testConfig) : null, secretMasked: '••••••••••••••••' });
    } catch (error) {
      console.error('Error fetching vault entry:', error);
      res.status(500).json({ error: 'Failed to fetch vault entry' });
    }
  });

  // GET /api/vault/:id/reveal - decrypt and return the real secret value
  router.get('/:id/reveal', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const entry = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!entry) return res.status(404).json({ error: 'Vault entry not found' });
      let secret;
      try { secret = decrypt(entry.encryptedSecret, req); } catch { return res.status(500).json({ error: 'Failed to decrypt secret' }); }
      res.json({ secret });
    } catch (error) {
      console.error('Error revealing vault entry:', error);
      res.status(500).json({ error: 'Failed to reveal vault entry' });
    }
  });

  // POST /api/vault - create entry
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const {
        name, category, provider, secretLabel, secret,
        testType, testConfig, dashboardUrl, expiresAt, notifyDaysBefore,
      } = req.body || {};

      if (!name || !category || !secret) {
        return res.status(400).json({ error: 'name, category, and secret are required' });
      }
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
      }

      const maxPositionEntry = await prisma.vaultEntry.findFirst({
        where: { accountId, category },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const nextPosition = (maxPositionEntry?.position ?? -1) + 1;

      const entry = await prisma.vaultEntry.create({
        data: {
          accountId,
          name,
          category,
          provider: provider || null,
          secretLabel: secretLabel || 'API Key',
          encryptedSecret: encrypt(secret, req),
          testType: testType || 'manual',
          testConfig: testConfig ? JSON.stringify(testConfig) : null,
          dashboardUrl: dashboardUrl || null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          notifyDaysBefore: typeof notifyDaysBefore === 'number' ? notifyDaysBefore : 3,
          position: nextPosition,
        },
      });

      res.status(201).json({ id: entry.id, name: entry.name });
    } catch (error) {
      console.error('Error creating vault entry:', error);
      res.status(500).json({ error: 'Failed to create vault entry' });
    }
  });

  // PUT /api/vault/reorder - persist drag-and-drop order within a single category
  // body: { category, orderedIds: string[] }
  // NOTE: must be registered before PUT /:id, otherwise Express matches "reorder"
  // as the :id parameter and this handler never gets reached.
  router.put('/reorder', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { category, orderedIds } = req.body || {};

      if (!category || !Array.isArray(orderedIds) || orderedIds.length === 0) {
        return res.status(400).json({ error: 'category and orderedIds are required' });
      }

      // Confirm every id actually belongs to this account + category before touching anything
      const existing = await prisma.vaultEntry.findMany({
        where: { id: { in: orderedIds }, accountId, category },
        select: { id: true },
      });
      if (existing.length !== orderedIds.length) {
        return res.status(400).json({ error: 'One or more entries do not belong to this account/category' });
      }

      await Promise.all(
        orderedIds.map((id, index) =>
          prisma.vaultEntry.update({ where: { id }, data: { position: index } })
        )
      );

      res.json({ success: true });
    } catch (error) {
      console.error('Error reordering vault entries:', error);
      res.status(500).json({ error: 'Failed to reorder vault entries' });
    }
  });

  // PUT /api/vault/:id - update (secret optional; omit to leave unchanged)
  router.put('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'Vault entry not found' });

      const {
        name, category, provider, secretLabel, secret,
        testType, testConfig, dashboardUrl, expiresAt, notifyDaysBefore, isActive,
      } = req.body || {};

      if (category && !CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
      }

      const data = {};
      if (name !== undefined) data.name = name;
      if (category !== undefined) data.category = category;
      if (provider !== undefined) data.provider = provider;
      if (secretLabel !== undefined) data.secretLabel = secretLabel;
      if (secret) data.encryptedSecret = encrypt(secret, req);
      if (testType !== undefined) data.testType = testType;
      if (testConfig !== undefined) data.testConfig = testConfig ? JSON.stringify(testConfig) : null;
      if (dashboardUrl !== undefined) data.dashboardUrl = dashboardUrl;
      if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
      if (notifyDaysBefore !== undefined) data.notifyDaysBefore = notifyDaysBefore;
      if (isActive !== undefined) data.isActive = isActive;

      await prisma.vaultEntry.update({ where: { id: existing.id }, data });
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating vault entry:', error);
      res.status(500).json({ error: 'Failed to update vault entry' });
    }
  });

  // DELETE /api/vault/:id
  router.delete('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'Vault entry not found' });
      await prisma.vaultEntry.delete({ where: { id: existing.id } });
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting vault entry:', error);
      res.status(500).json({ error: 'Failed to delete vault entry' });
    }
  });

  // POST /api/vault/:id/test - run the active-check now
  router.post('/:id/test', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const entry = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!entry) return res.status(404).json({ error: 'Vault entry not found' });

      let secret;
      try { secret = decrypt(entry.encryptedSecret, req); } catch { return res.status(500).json({ error: 'Failed to decrypt secret' }); }
      const config = entry.testConfig ? JSON.parse(entry.testConfig) : {};
      config.identifier = entry.provider || config.identifier; // for stremio_auth/nuvio_auth checkers

      const result = await runCheck(entry.testType, secret, config);

      const updateData = {
        lastCheckedAt: new Date(),
        lastCheckStatus: result.ok === null ? 'unknown' : (result.ok ? 'ok' : 'error'),
        lastCheckMessage: result.message || null,
      };
      // If the checker discovered a real expiration date (Real-Debrid, TorBox), sync it
      if (result.expiresAt instanceof Date && !isNaN(result.expiresAt)) {
        updateData.expiresAt = result.expiresAt;
      }
      await prisma.vaultEntry.update({ where: { id: entry.id }, data: updateData });

      res.json({ ...result, checkedAt: updateData.lastCheckedAt });
    } catch (error) {
      console.error('Error testing vault entry:', error);
      res.status(500).json({ error: 'Failed to test vault entry' });
    }
  });

  // Vault notification config now lives in the account-wide notification
  // settings (Settings > Notifications, a "Vault notifications" toggle on
  // the same Discord webhook as Activity/Sync/Invite) - see
  // server/routes/settings.js and server/utils/vaultMonitor.js. The former
  // /settings/notifications GET/PUT/test endpoints here were removed with
  // the separate Vault-only notification config they managed.

  // POST /api/vault/backup-now - trigger an immediate backup export (in addition to the nightly schedule)
  router.post('/backup-now', async (req, res) => {
    try {
      const { performVaultBackupOnce } = require('../utils/vaultBackup');
      await performVaultBackupOnce({ prisma, decrypt });
      res.json({ success: true });
    } catch (error) {
      console.error('Error running manual vault backup:', error);
      res.status(500).json({ error: 'Failed to run backup' });
    }
  });

  return router;
};

module.exports.CATEGORIES = CATEGORIES;
