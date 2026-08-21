// Auth and CSRF middlewares (factory-style for DI/testing)
module.exports.createAuthGate = function createAuthGate({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, JWT_SECRET, pathIsAllowlisted, parseCookies, cookieName, extractBearerToken, issueAccessToken, randomCsrfToken, isProdEnv, jsonwebtoken, prisma }) {
  const jwt = jsonwebtoken || require('jsonwebtoken')
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

    const cookies = parseCookies(req);
    const accessCookie = cookies[cookieName('sfm_at')] || cookies['sfm_at'];
    const refreshCookie = cookies[cookieName('sfm_rt')] || cookies['sfm_rt'];
    const bearer = extractBearerToken(req);
    const token = bearer || accessCookie;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Checked on every request, not just on refresh-renewal:
        // superadmin's "Disable" is meant to be an immediate kill switch,
        // and one extra indexed lookup per request is negligible.
        //
        // Runs on private instances too, not just public. Private has no
        // concept of "disabled", but it does have self-service account
        // deletion in Settings, and a deleted account is exactly the case
        // this has to catch - otherwise that session keeps working against
        // an account that no longer exists. Skipped entirely on allowlisted
        // paths - those run their own auth (or none) and must never be
        // blocked by a tenant account's state, see the comment above.
        if (!allowlisted && prisma) {
          try {
            const acct = await prisma.appAccount.findUnique({ where: { id: decoded.accId }, select: { disabled: true } });
            // A DELETED account has no row at all, so findUnique returns
            // null - and `acct?.disabled` on null is undefined, i.e. falsy,
            // which let a deleted account's still-valid JWT straight
            // through. Superadmin could delete an account and that session
            // kept working, navigating pages as if nothing happened, until
            // the token expired on its own. Missing has to be treated
            // exactly like disabled: there is no account to authenticate.
            if (!acct || acct.disabled) {
              return res.status(401).json({ message: acct ? 'This account has been disabled' : 'This account no longer exists' });
            }
          } catch {}
        }
        req.appAccountId = decoded.accId;
        return next();
      } catch (e) {
        if (refreshCookie) {
          try {
            const rj = jwt.verify(refreshCookie, JWT_SECRET);
            if (rj && rj.accId) {
              // Superadmin-disable check: only hit on the (relatively rare)
              // access-token-expiry renewal, not every request - bounds a
              // disabled account's already-open session to at most one
              // access-token lifetime (30d) rather than the full 365d
              // refresh token, without a DB read on every single request.
              if (!allowlisted && prisma) {
                try {
                  const acct = await prisma.appAccount.findUnique({ where: { id: rj.accId }, select: { disabled: true } });
                  // Same null-vs-disabled trap as the access-token path
                  // above - without this, a deleted account could still mint
                  // itself a fresh access token off its refresh cookie.
                  if (!acct || acct.disabled) {
                    return res.status(401).json({ message: acct ? 'This account has been disabled' : 'This account no longer exists' });
                  }
                } catch {}
              }
              const newAt = issueAccessToken(rj.accId);
              res.cookie(cookieName('sfm_at'), newAt, {
                httpOnly: true,
                secure: isProdEnv(),
                sameSite: isProdEnv() ? 'strict' : 'lax',
                path: '/',
                maxAge: 30 * 24 * 60 * 60 * 1000,
              });
              // Also refresh CSRF token when access token is refreshed
              if (randomCsrfToken) {
                const newCsrf = randomCsrfToken();
                res.cookie(cookieName('sfm_csrf'), newCsrf, {
                  httpOnly: false,
                  secure: isProdEnv(),
                  sameSite: isProdEnv() ? 'strict' : 'lax',
                  path: '/',
                  maxAge: 30 * 24 * 60 * 60 * 1000, // Match access token expiration
                });
              }
              req.appAccountId = rj.accId;
              return next();
            }
          } catch {}
        }
        // If token verification fails and path is NOT allowlisted, 401
        if (!allowlisted) {
          return res.status(401).json({ message: 'Invalid or expired token' });
        }
      }
    }

    // If no token (or failed token) but path is allowlisted, allow access
    if (allowlisted) return next();

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


