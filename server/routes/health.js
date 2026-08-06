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
module.exports = ({ prisma, getAccountId, INSTANCE_TYPE }) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';

      const { getVersionStatus } = require('../utils/versionCheck');

      const [addons, vaultEntries, driftNotifications, mismatchCount, users, version, addonEvents, vaultProxyEvents] = await Promise.all([
        prisma.addon.findMany({
          where: { accountId },
          select: { id: true, name: true, isOnline: true, lastHealthCheck: true, healthCheckError: true, healthIgnored: true },
        }),
        prisma.vaultEntry.findMany({
          where: { accountId, isActive: true },
          select: { id: true, name: true, provider: true, lastCheckStatus: true, lastCheckMessage: true, lastCheckedAt: true, expiresAt: true, notifyDaysBefore: true, healthIgnored: true },
        }),
        prisma.notification.findMany({
          where: { accountId, type: 'sync', dedupeKey: { startsWith: 'sync-guardian-' } },
          select: { title: true, body: true, url: true, createdAt: true },
        }),
        prisma.notification.count({ where: { accountId, type: 'mismatch' } }),
        prisma.user.findMany({ where: { accountId, isActive: true }, select: { id: true } }),
        getVersionStatus(),
        // Unified incident timeline, part 1: addon offline/online edge events
        // (AddonHealthAlert already logs exactly this - see the model's own
        // comment). Not filtered by healthIgnored - an ignored addon's past
        // history is still real history, only its CURRENT status stops
        // counting toward Attention.
        prisma.addonHealthAlert.findMany({
          where: { accountId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        // Unified incident timeline, part 2: Vault and Proxy don't have a
        // dedicated event-log table the way addons do, but notifyPushForType
        // already persists a bell Notification row for every vault/proxy
        // health transition (see pushNotifications.js) - reusing that instead
        // of building a second logging mechanism for the same kind of event.
        prisma.notification.findMany({
          where: { accountId, type: { in: ['vault', 'proxy'] } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      const timeline = [
        ...addonEvents.map((e) => ({
          id: e.id,
          source: 'addon',
          status: e.event === 'offline' ? 'down' : 'up',
          title: e.event === 'offline' ? `${e.addonName} went offline` : `${e.addonName} came back online`,
          detail: e.errorMessage || null,
          at: e.createdAt,
        })),
        ...vaultProxyEvents.map((n) => ({
          id: n.id,
          source: n.type,
          // Proxy has a real ✅ recovery notification (proxyStreamMonitor.js);
          // Vault only ever alerts on failure/expiry (⚠️/⏰ - vaultMonitor.js
          // has no "back to ok" counterpart), so this correctly shows as
          // "down" for every vault event - an accurate reflection of what's
          // actually tracked, not a gap in this timeline.
          status: n.title.startsWith('✅') ? 'up' : 'down',
          title: n.title,
          detail: n.body || null,
          at: n.createdAt,
        })),
      ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 50);

      // Addons - healthIgnored entries never show as Attention or count
      // toward `overall`. The ignored list itself is independent of current
      // online/offline state (once marked ignored, it stays manageable from
      // Health even if the addon later comes back online) so there's always
      // a way back to un-ignore it - never a one-way black hole.
      const addonsOffline = addons.filter((a) => a.isOnline === false && !a.healthIgnored);
      const addonsIgnored = addons.filter((a) => a.healthIgnored);
      const addonsChecked = addons.filter((a) => a.lastHealthCheck != null);

      // Uptime % reconstructed from AddonHealthAlert's offline/online
      // transition log - see computeAddonUptime's own comment for why it
      // needs the pre-window state too, not just events inside the window.
      const { computeAddonUptime } = require('../utils/addonHealthCheck');
      const addonUptime = Object.fromEntries(await Promise.all(addons.map(async (a) => [
        a.id,
        {
          uptime7d: await computeAddonUptime(prisma, accountId, a.id, a.isOnline !== false, 7),
          uptime30d: await computeAddonUptime(prisma, accountId, a.id, a.isOnline !== false, 30),
        },
      ])));

      // Vault - same healthIgnored treatment as addons above.
      const now = Date.now();
      const vaultFailing = vaultEntries.filter((v) => v.lastCheckStatus === 'error' && !v.healthIgnored);
      const vaultExpiring = vaultEntries.filter((v) => {
        if (!v.expiresAt || v.healthIgnored) return false;
        const daysUntil = (new Date(v.expiresAt).getTime() - now) / (1000 * 60 * 60 * 24);
        return daysUntil <= (v.notifyDaysBefore ?? 3);
      });
      const vaultIgnored = vaultEntries.filter((v) => v.healthIgnored);

      // Proxy connectivity - last poll outcome, in-memory (single-instance
      // deploy). This entire concept is private-mode-only: the monitor is
      // wired up once at boot against ONE shared AIOSTREAMS_URL env var for
      // DEFAULT_ACCOUNT_ID (server/index.js), not a per-tenant Settings
      // field - there is no way for an individual public-mode account to
      // ever configure their own. Every public tenant would otherwise see
      // the exact same "Not configured" card forever, since it's reading
      // one process-wide global that has nothing to do with their account.
      let proxy = null;
      if (INSTANCE_TYPE !== 'public') {
        proxy = { ok: null, at: null, error: null, configured: false };
        try {
          const { getProxyMonitorStatus } = require('../utils/proxyStreamMonitor');
          proxy = { ...getProxyMonitorStatus(), configured: !!process.env.AIOSTREAMS_URL };
        } catch {}
      }

      const overall =
        addonsOffline.length === 0 && vaultFailing.length === 0 && driftNotifications.length === 0 &&
        (!proxy || proxy.ok !== false)
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
          offline: addonsOffline.map((a) => ({ id: a.id, name: a.name, error: a.healthCheckError, lastChecked: a.lastHealthCheck })),
          ignored: addonsIgnored.map((a) => ({ id: a.id, name: a.name })),
          uptime: addons.map((a) => ({ id: a.id, name: a.name, uptime7d: addonUptime[a.id].uptime7d, uptime30d: addonUptime[a.id].uptime30d })),
        },
        vault: {
          total: vaultEntries.length,
          failingCount: vaultFailing.length,
          failing: vaultFailing.map((v) => ({ id: v.id, name: v.name, provider: v.provider, message: v.lastCheckMessage, lastChecked: v.lastCheckedAt })),
          expiringCount: vaultExpiring.length,
          expiring: vaultExpiring.map((v) => ({ id: v.id, name: v.name, provider: v.provider, expiresAt: v.expiresAt })),
          ignored: vaultIgnored.map((v) => ({ id: v.id, name: v.name, provider: v.provider })),
        },
        proxy,
        mismatchCount,
        version,
        timeline,
      });
    } catch (error) {
      console.error('Error building health status:', error);
      res.status(500).json({ error: 'Failed to build health status' });
    }
  });

  return router;
};
