const express = require('express');

// System Health board: one page answering "is everything actually working
// right now" - today that means checking Sync (per-user drift, via Sync
// Guardian's already-computed state), Addons (reachability, from the
// existing health-check poller), Vault (credential check failures + expiry
// windows, from the existing vault monitor), and the AIOStreams Proxy
// (last poll outcome). Every signal here is read from state ALREADY
// maintained by an existing background monitor - this route computes
// nothing live and makes no outbound calls itself, so loading the page has
// no cost beyond a few fast DB reads.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';

      const [addons, vaultEntries, driftNotifications, mismatchCount, users] = await Promise.all([
        prisma.addon.findMany({
          where: { accountId },
          select: { id: true, name: true, isOnline: true, lastHealthCheck: true, healthCheckError: true },
        }),
        prisma.vaultEntry.findMany({
          where: { accountId, isActive: true },
          select: { id: true, name: true, provider: true, lastCheckStatus: true, lastCheckMessage: true, lastCheckedAt: true, expiresAt: true, notifyDaysBefore: true },
        }),
        prisma.notification.findMany({
          where: { accountId, type: 'sync', dedupeKey: { startsWith: 'sync-guardian-' } },
          select: { title: true, body: true, url: true, createdAt: true },
        }),
        prisma.notification.count({ where: { accountId, type: 'mismatch' } }),
        prisma.user.findMany({ where: { accountId, isActive: true }, select: { id: true } }),
      ]);

      // Addons
      const addonsOffline = addons.filter((a) => a.isOnline === false);
      const addonsChecked = addons.filter((a) => a.lastHealthCheck != null);

      // Vault
      const now = Date.now();
      const vaultFailing = vaultEntries.filter((v) => v.lastCheckStatus === 'error');
      const vaultExpiring = vaultEntries.filter((v) => {
        if (!v.expiresAt) return false;
        const daysUntil = (new Date(v.expiresAt).getTime() - now) / (1000 * 60 * 60 * 24);
        return daysUntil <= (v.notifyDaysBefore ?? 3);
      });

      // Proxy connectivity - last poll outcome, in-memory (single-instance deploy)
      let proxy = { ok: null, at: null, error: null, configured: false };
      try {
        const { getProxyMonitorStatus } = require('../utils/proxyStreamMonitor');
        proxy = { ...getProxyMonitorStatus(), configured: !!process.env.AIOSTREAMS_URL };
      } catch {}

      const overall =
        addonsOffline.length === 0 && vaultFailing.length === 0 && driftNotifications.length === 0 &&
        (proxy.ok !== false)
          ? 'healthy'
          : 'attention';

      res.json({
        overall,
        checkedAt: new Date().toISOString(),
        sync: {
          usersTracked: users.length,
          driftCount: driftNotifications.length,
          drifted: driftNotifications.map((n) => ({ title: n.title, body: n.body, url: n.url, since: n.createdAt })),
        },
        addons: {
          total: addons.length,
          checked: addonsChecked.length,
          offlineCount: addonsOffline.length,
          offline: addonsOffline.map((a) => ({ name: a.name, error: a.healthCheckError, lastChecked: a.lastHealthCheck })),
        },
        vault: {
          total: vaultEntries.length,
          failingCount: vaultFailing.length,
          failing: vaultFailing.map((v) => ({ name: v.name, provider: v.provider, message: v.lastCheckMessage, lastChecked: v.lastCheckedAt })),
          expiringCount: vaultExpiring.length,
          expiring: vaultExpiring.map((v) => ({ name: v.name, provider: v.provider, expiresAt: v.expiresAt })),
        },
        proxy,
        mismatchCount,
      });
    } catch (error) {
      console.error('Error building health status:', error);
      res.status(500).json({ error: 'Failed to build health status' });
    }
  });

  return router;
};
