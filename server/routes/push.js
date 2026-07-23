const express = require('express');

// PWA web-push subscription management. See utils/pushNotifications.js for the
// VAPID/send side. Account-scoped so a multi-tenant (public) deployment keeps
// each account's device subscriptions separate.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();
  const { getPublicKey, isPushEnabled } = require('../utils/pushNotifications');

  // GET /api/push/vapid-key - the public key the browser needs to subscribe,
  // plus whether push is available at all on this server.
  router.get('/vapid-key', async (req, res) => {
    res.json({ enabled: isPushEnabled(), publicKey: getPublicKey() });
  });

  // POST /api/push/subscribe - store (or refresh) a browser's push
  // subscription. Body is the raw PushSubscription.toJSON() from the client.
  router.post('/subscribe', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { endpoint, keys, userAgent } = req.body || {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { accountId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
        update: { accountId, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving push subscription:', error);
      res.status(500).json({ error: 'Failed to save subscription' });
    }
  });

  // POST /api/push/unsubscribe - remove a subscription by endpoint.
  router.post('/unsubscribe', async (req, res) => {
    try {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      await prisma.pushSubscription.deleteMany({ where: { endpoint } });
      res.json({ success: true });
    } catch (error) {
      console.error('Error removing push subscription:', error);
      res.status(500).json({ error: 'Failed to remove subscription' });
    }
  });

  // GET /api/push/devices - every device subscribed to push on this account,
  // for Settings -> Devices. Never returns p256dh/auth/endpoint - those are
  // the actual push credentials and the UI has no use for them, only for
  // managing (rename/revoke) the subscription by its own id.
  router.get('/devices', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const devices = await prisma.pushSubscription.findMany({
        where: { accountId },
        select: { id: true, userAgent: true, label: true, lastSeenAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      res.json(devices);
    } catch (error) {
      console.error('Error fetching push devices:', error);
      res.status(500).json({ error: 'Failed to fetch devices' });
    }
  });

  // PATCH /api/push/devices/:id - rename ({ label }), so a device reads as
  // "Living room TV" instead of a raw user-agent string.
  router.patch('/devices/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { label } = req.body || {};
      const device = await prisma.pushSubscription.findFirst({ where: { id: req.params.id, accountId } });
      if (!device) return res.status(404).json({ error: 'Device not found' });
      const updated = await prisma.pushSubscription.update({
        where: { id: device.id },
        data: { label: typeof label === 'string' ? (label.trim() || null) : null },
      });
      res.json(updated);
    } catch (error) {
      console.error('Error renaming push device:', error);
      res.status(500).json({ error: 'Failed to rename device' });
    }
  });

  // DELETE /api/push/devices/:id - revoke a device by its own row id, unlike
  // /unsubscribe (which only removes the CALLING browser's own endpoint) -
  // this is the admin-side path for revoking any OTHER device from Settings.
  router.delete('/devices/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      await prisma.pushSubscription.deleteMany({ where: { id: req.params.id, accountId } });
      res.json({ success: true });
    } catch (error) {
      console.error('Error revoking push device:', error);
      res.status(500).json({ error: 'Failed to revoke device' });
    }
  });

  return router;
};
