const express = require('express');
const jwt = require('jsonwebtoken');

// Superadmin panel: operator-only, cross-account visibility for public
// multi-tenant mode. Deliberately NOT tied to any tenant AppAccount - see
// issueSuperAdminToken's own comment for why. Every route here enforces its
// own requireSuperAdmin check regardless of what the app-wide auth gate did
// with the request (see auth.js's pathIsAllowlisted comment on this prefix).
//
// Hard privacy boundary: this panel may show that an account exists, when it
// registered, when it last logged in, and coarse counts (users/groups/
// addons) - enough to judge "is this account real/active" for moderation.
// It must NEVER expose passwordHash, sync (contains webhookUrl/API keys),
// apiKeyHash, or anything from inside a tenant's own data (their addons'
// manifest URLs, Vault secrets, watch history, library contents). If a field
// isn't explicitly selected below, it was left out on purpose.
module.exports = ({ prisma, JWT_SECRET, isProdEnv, cookieName, parseCookies }) => {
  const router = express.Router();
  const COOKIE = cookieName ? cookieName('sfm_superadmin') : 'sfm_superadmin';

  function issueSuperAdminToken() {
    return jwt.sign({ typ: 'superadmin' }, JWT_SECRET, { expiresIn: '12h' });
  }

  function requireSuperAdmin(req, res, next) {
    try {
      const cookies = parseCookies ? parseCookies(req) : {};
      const token = cookies[COOKIE] || cookies['sfm_superadmin'];
      if (!token) return res.status(401).json({ message: 'Not signed in' });
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.typ !== 'superadmin') return res.status(401).json({ message: 'Invalid session' });
      return next();
    } catch {
      return res.status(401).json({ message: 'Invalid or expired session' });
    }
  }

  const cookieOpts = {
    httpOnly: true,
    secure: isProdEnv ? isProdEnv() : false,
    // 'strict' is the actual CSRF defense for this panel (no separate CSRF
    // token exchange, unlike the per-account auth flow) - a strict cookie is
    // simply never sent on a cross-site request, which is sufficient for an
    // operator-only surface that's never embedded/linked from elsewhere.
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  };

  router.post('/login', async (req, res) => {
    const configured = (process.env.SUPERADMIN_PASSWORD || '').trim();
    if (!configured) {
      return res.status(503).json({ message: 'Superadmin panel is not configured on this instance (set SUPERADMIN_PASSWORD)' });
    }
    const { password } = req.body || {};
    if (!password || String(password) !== configured) {
      return res.status(401).json({ message: 'Incorrect password' });
    }
    res.cookie(COOKIE, issueSuperAdminToken(), cookieOpts);
    return res.json({ message: 'Signed in' });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    return res.json({ message: 'Signed out' });
  });

  router.get('/session', requireSuperAdmin, (req, res) => res.json({ signedIn: true }));

  // GET /accounts - every tenant account, coarse counts only.
  router.get('/accounts', requireSuperAdmin, async (req, res) => {
    try {
      const accounts = await prisma.appAccount.findMany({
        select: {
          id: true, uuid: true, email: true, createdAt: true, lastLoginAt: true, disabled: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const counted = await Promise.all(accounts.map(async (a) => {
        const [userCount, groupCount, addonCount] = await Promise.all([
          prisma.user.count({ where: { accountId: a.id } }),
          prisma.group.count({ where: { accountId: a.id } }),
          prisma.addon.count({ where: { accountId: a.id } }),
        ]);
        return { ...a, userCount, groupCount, addonCount };
      }));
      res.json({ total: counted.length, accounts: counted });
    } catch (e) {
      console.error('[Superadmin] Failed to list accounts:', e?.message);
      res.status(500).json({ message: 'Failed to list accounts' });
    }
  });

  router.post('/accounts/:id/disable', requireSuperAdmin, async (req, res) => {
    try {
      const account = await prisma.appAccount.update({ where: { id: req.params.id }, data: { disabled: true } });
      res.json({ id: account.id, disabled: true });
    } catch (e) {
      res.status(404).json({ message: 'Account not found' });
    }
  });

  router.post('/accounts/:id/enable', requireSuperAdmin, async (req, res) => {
    try {
      const account = await prisma.appAccount.update({ where: { id: req.params.id }, data: { disabled: false } });
      res.json({ id: account.id, disabled: false });
    } catch (e) {
      res.status(404).json({ message: 'Account not found' });
    }
  });

  // DELETE /accounts/:id - irreversible. AppAccount.accountId is an
  // application-level scope field, not an enforced FK (confirmed: only
  // Invitation has a real onDelete:Cascade relation back to AppAccount), so
  // every accountId-scoped table needs to be cleared explicitly or it's left
  // as orphaned data - this list is every model with an accountId field in
  // the public (Postgres) schema as of this writing.
  router.delete('/accounts/:id', requireSuperAdmin, async (req, res) => {
    const accountId = req.params.id;
    try {
      const existing = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { id: true } });
      if (!existing) return res.status(404).json({ message: 'Account not found' });

      const where = { accountId };
      await prisma.$transaction([
        prisma.addonHealthAlert.deleteMany({ where }),
        prisma.addonSnapshot.deleteMany({ where }),
        prisma.customList.deleteMany({ where }),
        prisma.dismissedContinueWatching.deleteMany({ where }),
        prisma.dismissedUpcomingEpisode.deleteMany({ where }),
        prisma.episodeAlert.deleteMany({ where }),
        prisma.episodeWatchHistory.deleteMany({ where }),
        prisma.inviteRequest.deleteMany({ where }),
        prisma.manualWatchOverride.deleteMany({ where }),
        prisma.movieWatchHistory.deleteMany({ where }),
        prisma.notInterestedItem.deleteMany({ where }),
        prisma.proxyStreamSession.deleteMany({ where }),
        prisma.pushSubscription.deleteMany({ where }),
        prisma.showEpisodeAlertState.deleteMany({ where }),
        prisma.userSyncGuardState.deleteMany({ where }),
        prisma.vaultEntry.deleteMany({ where }),
        prisma.watchActivity.deleteMany({ where }),
        prisma.watchSession.deleteMany({ where }),
        prisma.watchSnapshot.deleteMany({ where }),
        prisma.watchlistItem.deleteMany({ where }),
        // Invitation already cascades from AppAccount, but clearing it
        // explicitly here too keeps this list self-contained/order-independent.
        prisma.invitation.deleteMany({ where }),
        // Group/Addon last among the "structural" tables - GroupAddon has no
        // accountId of its own, it cascades automatically off these two.
        prisma.group.deleteMany({ where }),
        prisma.addon.deleteMany({ where }),
        prisma.user.deleteMany({ where }),
        prisma.appAccount.delete({ where: { id: accountId } }),
      ]);

      res.json({ deleted: true, id: accountId });
    } catch (e) {
      console.error('[Superadmin] Failed to delete account:', e?.message);
      res.status(500).json({ message: 'Failed to delete account', error: e?.message });
    }
  });

  return router;
};
