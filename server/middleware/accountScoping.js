/**
 * Account Scoping Middleware
 *
 * Ensures req.appAccountId is set before account-scoped routes run (groups,
 * users, addons, stremio, nuvio, snapshots, vault). The actual per-query
 * account filtering happens in each route handler via getAccountId(req) -
 * this middleware does not touch Prisma itself. An earlier version tried to
 * enforce scoping centrally by swapping a module-level `global.prisma`
 * variable to an account-scoped Proxy for the duration of each request, but
 * no route handler ever read `global.prisma` (each router captures its own
 * `prisma` reference via closure at startup, per server/index.js's factory
 * pattern), so the swap never affected any query - it was inert. Worse,
 * mutating shared global state per-request is unsafe under Node's async
 * event loop regardless (a second request's swap could clobber the first
 * request's assignment mid-flight), so it was removed rather than fixed in
 * place. Real account isolation lives entirely in each route's explicit
 * `accountId: getAccountId(req)` filters - see server/utils/helpers/database.js.
 */
function createAccountScopingMiddleware() {
  return function accountScopingMiddleware(req, res, next) {
    if (!req.appAccountId) {
      // If instance is private, use default account ID
      const { INSTANCE_TYPE } = require('../utils/config')
      if (INSTANCE_TYPE !== 'public') {
        req.appAccountId = 'default'
      } else {
        console.error('🚨 Account scoping middleware called without appAccountId!')
        return res.status(401).json({ error: 'Authentication required' })
      }
    }
    next()
  }
}

module.exports = {
  createAccountScopingMiddleware
}
