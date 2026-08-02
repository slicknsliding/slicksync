// Auth and CSRF middlewares (factory-style for DI/testing)
module.exports.createAuthGate = function createAuthGate({ INSTANCE_TYPE, PRIVATE_AUTH_ENABLED, JWT_SECRET, pathIsAllowlisted, parseCookies, cookieName, extractBearerToken, issueAccessToken, randomCsrfToken, isProdEnv, jsonwebtoken, prisma }) {
  const jwt = jsonwebtoken || require('jsonwebtoken')
  return async function authGate(req, res, next) {
    if (INSTANCE_TYPE !== 'public' && !PRIVATE_AUTH_ENABLED) return next();
    if (req.method === 'OPTIONS') return next();

    const cookies = parseCookies(req);
    const accessCookie = cookies[cookieName('sfm_at')] || cookies['sfm_at'];
    const refreshCookie = cookies[cookieName('sfm_rt')] || cookies['sfm_rt'];
    const bearer = extractBearerToken(req);
    const token = bearer || accessCookie;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Checked on every request (not just refresh-renewal) for public
        // instances specifically - superadmin's "Disable" is meant to be an
        // immediate kill switch, and at the 50-account cap this instance
        // mode is bounded to, one extra indexed lookup per request is
        // negligible. Private mode has no concept of "disabled" at all, so
        // it's never touched here.
        if (INSTANCE_TYPE === 'public' && prisma) {
          try {
            const acct = await prisma.appAccount.findUnique({ where: { id: decoded.accId }, select: { disabled: true } });
            if (acct?.disabled) {
              return res.status(401).json({ message: 'This account has been disabled' });
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
              if (INSTANCE_TYPE === 'public' && prisma) {
                try {
                  const acct = await prisma.appAccount.findUnique({ where: { id: rj.accId }, select: { disabled: true } });
                  if (acct?.disabled) {
                    return res.status(401).json({ message: 'This account has been disabled' });
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
        if (!pathIsAllowlisted(req.path)) {
          return res.status(401).json({ message: 'Invalid or expired token' });
        }
      }
    }

    // If no token (or failed token) but path is allowlisted, allow access
    if (pathIsAllowlisted(req.path)) return next();

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


