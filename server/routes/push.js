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

  return router;
};
