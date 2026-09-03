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

      // Currency is an account-level display preference (stored in the same
      // AppAccount.sync blob as accountTimezone), returned here so the Vault's
      // cost summary can format without a second round-trip.
      let currency = 'USD';
      try {
        const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } });
        let cfg = acc?.sync;
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
        if (cfg && typeof cfg === 'object' && typeof cfg.vaultCurrency === 'string' && cfg.vaultCurrency.trim()) {
          currency = cfg.vaultCurrency.trim().toUpperCase();
        }
      } catch {}

      res.json({
        total: all.length,
        categories: counts,
        currency,
        entries: entries.map(e => ({
          id: e.id, name: e.name, category: e.category, provider: e.provider,
          dashboardUrl: e.dashboardUrl, cost: e.cost, costCycle: e.costCycle, expiresAt: e.expiresAt, notifyDaysBefore: e.notifyDaysBefore,
          lastCheckedAt: e.lastCheckedAt, lastCheckStatus: e.lastCheckStatus, lastCheckMessage: e.lastCheckMessage,
          isActive: e.isActive, testType: (e.category === 'ai' && e.testType === 'manual') ? 'openai_compatible' : e.testType, secretLabel: e.secretLabel, updatedAt: e.updatedAt,
          position: e.position, autoRemoveEnabled: e.autoRemoveEnabled, autoRemoveAfterDays: e.autoRemoveAfterDays,
          backupEntryId: e.backupEntryId,
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

  // POST /api/vault/:id/reveal - decrypt and return the real secret value.
  // POST (not GET) so it goes through the CSRF guard, isn't cached, and never
  // appears in browser history / referer headers / intermediate proxy logs.
  router.post('/:id/reveal', async (req, res) => {
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

  // POST /api/vault/:id/snooze - silence the expiry-warning alert for this
  // entry for 7 days without dismissing it or touching notifyDaysBefore.
  // Only the expiry warning is snoozed - a check-failure alert (a different
  // signal - something is actually broken right now) still fires normally.
  router.post('/:id/snooze', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const entry = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!entry) return res.status(404).json({ error: 'Vault entry not found' });
      const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const updated = await prisma.vaultEntry.update({ where: { id: entry.id }, data: { snoozedUntil } });
      res.json(updated);
    } catch (error) {
      console.error('Error snoozing vault entry:', error);
      res.status(500).json({ error: 'Failed to snooze vault entry' });
    }
  });

  // GET /api/vault/:id/usage - live debrid usage (active downloads, premium
  // days left) for a real_debrid/torbox entry. See debridUsage.js's own
  // comment for why this is scoped to just those two fields. Null (not an
  // error) for a non-debrid entry, or if the live call itself fails -
  // Vault's own check status already covers "is this key broken."
  router.get('/:id/usage', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const entry = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, accountId } });
      if (!entry) return res.status(404).json({ error: 'Vault entry not found' });
      if (entry.testType !== 'real_debrid' && entry.testType !== 'torbox') {
        return res.json({ usage: null });
      }
      // No failover here on purpose: this reports the usage OF THIS ENTRY,
      // shown on this entry's own card. Quietly answering with the backup
      // account's figures would label one account's numbers with another
      // account's name - worse than showing nothing.
      let secret;
      try { secret = decrypt(entry.encryptedSecret, req); } catch { return res.json({ usage: null }); }
      const { fetchDebridUsage } = require('../utils/debridUsage');
      const usage = await fetchDebridUsage(entry.testType, secret);
      res.json({ usage });
    } catch (error) {
      console.error('Error fetching vault entry usage:', error);
      res.status(500).json({ error: 'Failed to fetch usage' });
    }
  });

  // POST /api/vault - create entry
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const {
        name, category, provider, secretLabel, secret,
        testType, testConfig, dashboardUrl, cost, costCycle, expiresAt, notifyDaysBefore,
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
          cost: typeof cost === 'number' && cost >= 0 ? cost : null,
          costCycle: costCycle === 'yearly' ? 'yearly' : 'monthly',
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
        testType, testConfig, dashboardUrl, cost, costCycle, expiresAt, notifyDaysBefore, isActive, healthIgnored,
        autoRemoveEnabled, autoRemoveAfterDays, backupEntryId,
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
      if (cost !== undefined) data.cost = typeof cost === 'number' && cost >= 0 ? cost : null;
      if (costCycle !== undefined) data.costCycle = costCycle === 'yearly' ? 'yearly' : 'monthly';
      if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
      if (notifyDaysBefore !== undefined) data.notifyDaysBefore = notifyDaysBefore;
      if (isActive !== undefined) data.isActive = isActive;
      if (healthIgnored !== undefined) data.healthIgnored = !!healthIgnored;
      if (autoRemoveEnabled !== undefined) data.autoRemoveEnabled = !!autoRemoveEnabled;
      if (autoRemoveAfterDays !== undefined) data.autoRemoveAfterDays = typeof autoRemoveAfterDays === 'number' && autoRemoveAfterDays > 0 ? autoRemoveAfterDays : 7;

      // Failover partner. Guarded rather than trusted: it has to be a real
      // entry on this same account, and an entry cannot back up itself
      // (which would make resolveVaultEntry a no-op that merely looks
      // configured). Empty string clears it.
      if (backupEntryId !== undefined) {
        if (!backupEntryId) {
          data.backupEntryId = null;
        } else if (backupEntryId === existing.id) {
          return res.status(400).json({ error: 'An entry cannot be its own backup' });
        } else {
          const backup = await prisma.vaultEntry.findFirst({ where: { id: backupEntryId, accountId } });
          if (!backup) return res.status(400).json({ error: 'Backup entry not found' });
          data.backupEntryId = backup.id;
        }
      }

      // Captured BEFORE the update overwrites it - the whole point of
      // rotation propagation is knowing what the old value was.
      let oldSecret = null;
      if (secret) {
        try { oldSecret = decrypt(existing.encryptedSecret, req); } catch { oldSecret = null; }
      }

      await prisma.vaultEntry.update({ where: { id: existing.id }, data });

      // Key-rotation propagation - opt-in per account (keyRotationPropagation
      // in Settings, OFF by default). When the secret actually changed, find
      // every addon config embedding the old value, rewrite it, and re-sync
      // the users carrying those addons. See utils/keyRotation.js for the
      // safety rules. A propagation failure never fails this save - the new
      // secret is already stored.
      let rotation = null;
      if (secret && oldSecret && oldSecret !== secret) {
        try {
          // Always on - the opt-in toggle was removed at the user's own
          // call after living for one day. The mechanism is conservative
          // enough not to need one: it only ever rewrites exact matches of
          // the OLD secret (12-char minimum, base64 round-trip verified),
          // no-ops when nothing embeds it, and reports loudly via the save
          // response and a notification. The one side effect - re-syncing
          // affected users - is strictly better than leaving them on a key
          // that just stopped existing.
          {
            const { propagateSecretRotation } = require('../utils/keyRotation');
            const { getDecryptedManifestUrl } = require('../utils/encryption');
            const { manifestUrlHmac } = require('../utils/hashing');
            rotation = await propagateSecretRotation(prisma, req, { encrypt, decrypt, getDecryptedManifestUrl, manifestUrlHmac }, {
              accountId, oldSecret, newSecret: secret,
            });
            if (rotation.addonsUpdated.length > 0) {
              const { createNotification } = require('../utils/notificationStore');
              await createNotification(prisma, accountId, {
                type: 'task',
                title: `Key rotation: "${existing.name}" propagated`,
                body: `Updated ${rotation.addonsUpdated.length} addon(s) (${rotation.addonsUpdated.map(a => a.name).join(', ')}) and re-synced ${rotation.usersSynced} user(s)${rotation.userFailures.length ? `; ${rotation.userFailures.length} sync failure(s)` : ''}.`,
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.warn('[Vault] Rotation propagation failed (save itself succeeded):', e?.message);
        }
      }

      res.json({ success: true, rotation });
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
      // Into the Trash first (30-day undo, ciphertext archived as-is).
      await require('../utils/trash').archiveVaultDelete(prisma, accountId, existing.id);
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

      // AI entries created before the openai_compatible checker existed carry
      // testType 'manual' - coerced here (and in the list mapping) so they
      // become checkable without anyone having to re-save the key.
      const effectiveTestType = (entry.category === 'ai' && entry.testType === 'manual') ? 'openai_compatible' : entry.testType;
      const result = await runCheck(effectiveTestType, secret, config);

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
