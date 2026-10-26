// Auth and CSRF middlewares (factory-style for DI/testing)
const { checkAccountClaims, pathNeedsLiveAccount } = require('../utils/auth')

module.exports.createAuthGate = function createAuthGate({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, JWT_SECRET, pathIsAllowlisted, parseCookies, cookieName, extractBearerToken, issueAccessToken, randomCsrfToken, isProdEnv, jsonwebtoken, prisma, DEFAULT_ACCOUNT_ID }) {
  const jwt = jsonwebtoken || require('jsonwebtoken')

  // The payload of a session token of the given kind ('access' or 'refresh'),
  // or null. Only account tokens count: the superadmin session and the user-
  // portal sessions are signed with the same secret, and none of them may ever
  // open an account (see checkAccountClaims). An access token in the refresh
  // slot, or the other way round, is refused too.
  //
  // A private instance has one account, the default one (every request there
  // resolves to it whatever the token says), so a token for any other account
  // id is not a way in: a stray row, however it got made, must never
  // authenticate as the owner.
  function accountToken(token, kind) {
    try {
      const claims = checkAccountClaims(jwt.verify(token, JWT_SECRET), [kind])
      if (claims && INSTANCE_TYPE !== 'public') {
        const onlyId = DEFAULT_ACCOUNT_ID || require('../utils/config').DEFAULT_ACCOUNT_ID
        if (claims.accId !== onlyId) return null
      }
      return claims
    } catch {
      return null
    }
  }

  // Is the account behind a verified token still there and switched on?
  // null when it is; otherwise the response to send.
  //
  // A DELETED account has no row at all, so findUnique returns null - and
  // `acct?.disabled` on null is undefined, i.e. falsy, which let a deleted
  // account's still-valid JWT straight through. Superadmin could delete an
  // account and that session kept working, navigating pages as if nothing
  // happened, until the token expired on its own. Missing has to be treated
  // exactly like disabled: there is no account to authenticate.
  //
  // And when the lookup itself fails the account is not allowed in either:
  // waving the token through would let a disabled or deleted account back in
  // whenever the database hiccups.
  async function refusalFor(accId) {
    try {
      const acct = await prisma.appAccount.findUnique({ where: { id: accId }, select: { disabled: true } });
      if (!acct || acct.disabled) {
        return { status: 401, message: acct ? 'This account has been disabled' : 'This account no longer exists' };
      }
      return null;
    } catch {
      return { status: 503, message: 'Could not check this account just now - try again in a moment' };
    }
  }

  // A valid refresh cookie stands in for an access token that is missing or
  // has expired: mint a fresh one (and a fresh CSRF token with it) and carry
  // on as that account. The browser drops sfm_at the day its JWT expires, so
  // "missing" is the normal shape of an old session, not only a stale one.
  //
  // Returns 'renewed', 'refused' (the response has been sent) or 'none' (no
  // usable refresh token - the caller decides what that means for the path).
  async function renewFromRefresh(req, res, refreshCookie, checkAccount) {
    const rj = accountToken(refreshCookie, 'refresh');
    if (!rj) return 'none';
    // Without this a disabled account would renew itself for the whole life
    // of its refresh token (365d), not just the access token's 30d.
    if (checkAccount) {
      const refusal = await refusalFor(rj.accId);
      if (refusal) {
        res.status(refusal.status).json({ message: refusal.message });
        return 'refused';
      }
    }
    const newAt = issueAccessToken(rj.accId);
    res.cookie(cookieName('sfm_at'), newAt, {
      httpOnly: true,
      secure: isProdEnv() || res.req?.secure === true,
      sameSite: isProdEnv() ? 'strict' : 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    // Also refresh CSRF token when access token is refreshed
    if (randomCsrfToken) {
      const newCsrf = randomCsrfToken();
      res.cookie(cookieName('sfm_csrf'), newCsrf, {
        httpOnly: false,
        secure: isProdEnv() || res.req?.secure === true,
        sameSite: isProdEnv() ? 'strict' : 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000, // Match access token expiration
      });
    }
    req.appAccountId = rj.accId;
    return 'renewed';
  }

  return async function authGate(req, res, next) {
    if (INSTANCE_TYPE !== 'public' && !PRIVATE_AUTH_ENABLED) return next();
    if (req.method === 'OPTIONS') return next();
    // Allowlisted-ness only matters for the disabled-account check below, NOT
    // for whether a valid token gets processed at all. An earlier version of
    // this fix skipped the whole token block for allowlisted paths, which
    // broke /api/ext/*'s own dual-auth design (its middleware does
    // `if (req.appAccountId) return next()`, falling back to requiring a
    // real API key otherwise) - every session-authenticated request stopped
    // getting req.appAccountId at all, so it always fell through to the API-
    // key path and 401'd, breaking the account-info topbar/modal for every
    // logged-in user. The actual fix superadmin's lockout needed was
    // narrower: /api/superadmin/login must never be blocked by a disabled
    // TENANT account's still-valid cookie - it doesn't need the token
    // skipped, just the disabled-check.
    const allowlisted = pathIsAllowlisted(req.path);
    // Superadmin's "Disable" is meant to be an immediate kill switch, and one
    // extra indexed lookup per request is negligible - so the account behind
    // a token is checked on every request that is not allowlisted. Runs on
    // private instances too, not just public: private has no concept of
    // "disabled", but it does have self-service account deletion in Settings,
    // and a deleted account is exactly the case this has to catch.
    //
    // Allowlisted paths run their own auth (or none) and must never be
    // blocked by a tenant account's state - a disabled household's stale
    // cookie must not stop anyone signing in to another account, or to the
    // superadmin panel, from the same browser. The exception is the few
    // allowlisted paths that answer from the session itself (/api/ext, the
    // Health page): there the account has to be live too.
    const checkAccount = !!prisma && (!allowlisted || pathNeedsLiveAccount(req.path));

    const cookies = parseCookies(req);
    const accessCookie = cookies[cookieName('sfm_at')] || cookies['sfm_at'];
    const refreshCookie = cookies[cookieName('sfm_rt')] || cookies['sfm_rt'];
    const bearer = extractBearerToken(req);
    const token = bearer || accessCookie;

    if (token) {
      const decoded = accountToken(token, 'access');
      if (decoded) {
        if (checkAccount) {
          const refusal = await refusalFor(decoded.accId);
          if (refusal) return res.status(refusal.status).json({ message: refusal.message });
        }
        req.appAccountId = decoded.accId;
        return next();
      }
    }

    // No usable access token - none was sent, or it is expired or not valid.
    if (refreshCookie) {
      const outcome = await renewFromRefresh(req, res, refreshCookie, checkAccount);
      if (outcome === 'renewed') return next();
      if (outcome === 'refused') return;
    }

    // If no token (or failed token) but path is allowlisted, allow access
    if (allowlisted) return next();

    // If token verification fails and path is NOT allowlisted, 401
    if (token) return res.status(401).json({ message: 'Invalid or expired token' });

    // Otherwise, authentication required
    return res.status(401).json({ message: 'Authentication required' });
  }
}

module.exports.createCsrfGuard = function createCsrfGuard({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, pathIsAllowlisted, parseCookies, cookieName }) {
  return function csrfGuard(req, res, next) {
    if (INSTANCE_TYPE !== 'public' && !PRIVATE_AUTH_ENABLED) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (pathIsAllowlisted(req.path)) return next();
    const cookies = parseCookies(req);
    const csrfCookie = cookies[cookieName('sfm_csrf')] || cookies['sfm_csrf'];
    const header = req.headers['x-csrf-token'];
    if (!csrfCookie || !header || String(header) !== String(csrfCookie)) {
      return res.status(403).json({ message: 'Invalid CSRF token' });
    }
    return next();
  }
}
