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

  // GET /accounts - every tenant account, coarse counts only. email is
  // deliberately NOT selected - the UI never rendered it, so fetching it at
  // all was unnecessary exposure of PII that isn't needed for moderation.
  // resourceRowCount is a row-count-across-key-tables proxy for "how much
  // data does this account hold" - not a byte-accurate disk size (public
  // mode is one shared Postgres database, not a file per account, so there
  // is no real per-account file size to report), but enough to tell a
  // heavily-used account apart from an empty or abandoned one.
  router.get('/accounts', requireSuperAdmin, async (req, res) => {
    try {
      const accounts = await prisma.appAccount.findMany({
        select: {
          id: true, uuid: true, createdAt: true, lastLoginAt: true, disabled: true, displayName: true, sessionsRevokedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const counted = await Promise.all(accounts.map(async (a) => {
        const where = { accountId: a.id };
        const [userCount, groupCount, addonCount, customListCount, watchSessionCount, vaultEntryCount] = await Promise.all([
          prisma.user.count({ where }),
          prisma.group.count({ where }),
          prisma.addon.count({ where }),
          prisma.customList.count({ where }),
          prisma.watchSession.count({ where }),
          prisma.vaultEntry.count({ where }),
        ]);
        return {
          ...a, userCount, groupCount, addonCount,
          resourceRowCount: userCount + groupCount + addonCount + customListCount + watchSessionCount + vaultEntryCount,
        };
      }));
      res.json({ total: counted.length, accounts: counted });
    } catch (e) {
      console.error('[Superadmin] Failed to list accounts:', e?.message);
      res.status(500).json({ message: 'Failed to list accounts' });
    }
  });

  // GET /audit-log - operator action trail, most recent first. Never shows
  // anything from inside a tenant's own data, only the fact/timestamp of an
  // operator action against that account - same privacy boundary as the
  // rest of this panel.
  router.get('/audit-log', requireSuperAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const entries = await prisma.superadminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      res.json({ entries });
    } catch (e) {
      console.error('[Superadmin] Failed to load audit log:', e?.message);
      res.status(500).json({ message: 'Failed to load audit log' });
    }
  });

  async function logAction(action, targetAccountId, targetAccountUuid, bulk = false) {
    try {
      await prisma.superadminAuditLog.create({
        data: { action, targetAccountId, targetAccountUuid: targetAccountUuid || null, bulk },
      });
    } catch (e) {
      // Never let audit logging itself block or fail the real action.
      console.error('[Superadmin] Failed to write audit log entry:', e?.message);
    }
  }

  router.post('/accounts/:id/disable', requireSuperAdmin, async (req, res) => {
    try {
      const target = await prisma.appAccount.findUnique({ where: { id: req.params.id }, select: { disabled: true, uuid: true } });
      if (!target) return res.status(404).json({ message: 'Account not found' });
      // Not a hard block - operator access (this panel) is architecturally
      // separate from tenant accounts and can never be locked out by this,
      // even at zero enabled tenants. This is purely a "did you mean to do
      // that" guard so disabling every tenant isn't a silent one-click
      // accident; passing confirm=true (the UI does this on a second click)
      // proceeds anyway.
      if (!target.disabled && req.query.confirm !== 'true') {
        const enabledCount = await prisma.appAccount.count({ where: { disabled: false } });
        if (enabledCount <= 1) {
          return res.status(409).json({
            message: 'This is the last enabled account. Disabling it will leave none active - resubmit with confirm=true to proceed anyway.',
            requiresConfirmation: true,
          });
        }
      }
      const account = await prisma.appAccount.update({ where: { id: req.params.id }, data: { disabled: true } });
      await logAction('disable', account.id, target.uuid);
      res.json({ id: account.id, disabled: true });
    } catch (e) {
      res.status(404).json({ message: 'Account not found' });
    }
  });

  router.post('/accounts/:id/enable', requireSuperAdmin, async (req, res) => {
    try {
      const account = await prisma.appAccount.update({ where: { id: req.params.id }, data: { disabled: false } });
      await logAction('enable', account.id, account.uuid);
      res.json({ id: account.id, disabled: false });
    } catch (e) {
      res.status(404).json({ message: 'Account not found' });
    }
  });

  // POST /accounts/:id/revoke-sessions - force-logout. Doesn't touch any
  // token directly (these are stateless JWTs) - instead stamps
  // sessionsRevokedAt, which server/middleware/auth.js checks against each
  // token's own `iat` on every request (same lookup it already does for the
  // `disabled` check, no extra DB round trip). Any token issued before this
  // moment stops working immediately; the account can log back in right away
  // and get a fresh token with a later iat.
  router.post('/accounts/:id/revoke-sessions', requireSuperAdmin, async (req, res) => {
    try {
      const account = await prisma.appAccount.update({ where: { id: req.params.id }, data: { sessionsRevokedAt: new Date() } });
      await logAction('revoke-sessions', account.id, account.uuid);
      res.json({ id: account.id, sessionsRevokedAt: account.sessionsRevokedAt });
    } catch (e) {
      res.status(404).json({ message: 'Account not found' });
    }
  });

  // Shared by the single-account DELETE route and bulk-delete below (and,
  // via the extracted utility, by Settings' self-service delete too - see
  // server/utils/accountDeletion.js for the actual cascade/table list).
  // This wrapper just adds the operator audit-log entry on top.
  const { deleteAccountCascade: cascadeDeleteAccount } = require('../utils/accountDeletion');
  async function deleteAccountCascade(accountId, bulk = false) {
    const existing = await cascadeDeleteAccount(prisma, accountId);
    await logAction('delete', existing.id, existing.uuid, bulk);
  }

  // DELETE /accounts/:id - irreversible.
  router.delete('/accounts/:id', requireSuperAdmin, async (req, res) => {
    try {
      await deleteAccountCascade(req.params.id, false);
      res.json({ deleted: true, id: req.params.id });
    } catch (e) {
      if (e.notFound) return res.status(404).json({ message: 'Account not found' });
      console.error('[Superadmin] Failed to delete account:', e?.message);
      res.status(500).json({ message: 'Failed to delete account', error: e?.message });
    }
  });

  // Bulk variants - each id validated/parsed the same way; a normalized
  // string array, capped generously against an accidental huge payload.
  function parseBulkIds(req, res) {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : null;
    if (!ids || ids.length === 0) {
      res.status(400).json({ message: 'ids must be a non-empty array' });
      return null;
    }
    if (ids.length > 200) {
      res.status(400).json({ message: 'Too many accounts in one request (max 200)' });
      return null;
    }
    return [...new Set(ids)];
  }

  router.post('/accounts/bulk-disable', requireSuperAdmin, async (req, res) => {
    const ids = parseBulkIds(req, res);
    if (!ids) return;
    try {
      // Same "don't silently disable every account" guard as the single-
      // account route, just checked against the WHOLE selection at once:
      // would disabling every id here leave zero enabled accounts overall?
      if (req.query.confirm !== 'true') {
        const stillEnabledAfter = await prisma.appAccount.count({ where: { disabled: false, id: { notIn: ids } } });
        if (stillEnabledAfter === 0) {
          return res.status(409).json({
            message: 'This would disable every remaining enabled account - resubmit with confirm=true to proceed anyway.',
            requiresConfirmation: true,
          });
        }
      }
      const targets = await prisma.appAccount.findMany({ where: { id: { in: ids } }, select: { id: true, uuid: true } });
      const result = await prisma.appAccount.updateMany({ where: { id: { in: ids } }, data: { disabled: true } });
      await Promise.all(targets.map((t) => logAction('disable', t.id, t.uuid, true)));
      res.json({ disabled: result.count });
    } catch (e) {
      console.error('[Superadmin] Bulk disable failed:', e?.message);
      res.status(500).json({ message: 'Bulk disable failed' });
    }
  });

  router.post('/accounts/bulk-enable', requireSuperAdmin, async (req, res) => {
    const ids = parseBulkIds(req, res);
    if (!ids) return;
    try {
      const targets = await prisma.appAccount.findMany({ where: { id: { in: ids } }, select: { id: true, uuid: true } });
      const result = await prisma.appAccount.updateMany({ where: { id: { in: ids } }, data: { disabled: false } });
      await Promise.all(targets.map((t) => logAction('enable', t.id, t.uuid, true)));
      res.json({ enabled: result.count });
    } catch (e) {
      console.error('[Superadmin] Bulk enable failed:', e?.message);
      res.status(500).json({ message: 'Bulk enable failed' });
    }
  });

  // POST not DELETE - a bulk delete needs a body (the id list), which DELETE
  // requests can carry but many proxies/clients handle unreliably.
  router.post('/accounts/bulk-delete', requireSuperAdmin, async (req, res) => {
    const ids = parseBulkIds(req, res);
    if (!ids) return;
    let deleted = 0;
    const failed = [];
    // Sequential, not Promise.all - each account's own cascade is already a
    // multi-table transaction; running many of those concurrently against
    // the same connection pool risks exhausting it for no real benefit here
    // (this is an infrequent operator action, not a hot path).
    for (const id of ids) {
      try {
        await deleteAccountCascade(id, true);
        deleted++;
      } catch (e) {
        failed.push(id);
      }
    }
    res.json({ deleted, failed });
  });

  return router;
};
