/**
 * User API Key Middleware
 * Validates user API keys and sets req.appUserId
 * Users can only access their own data via API key
 */
const { parsePresentedKey } = require('../utils/apiKey')
const { getServerKey, aesGcmDecrypt } = require('../utils/encryption')
const crypto = require('crypto')
const { createKeyIndex } = require('../utils/apiKeyIndex')

function createUserApiKeyMiddleware(prisma) {
  const select = { id: true, apiKey: true, accountId: true }
  const keys = createKeyIndex({
    loadAll: () => prisma.user.findMany({ where: { apiKey: { not: null } }, select }),
    loadOne: (id) => prisma.user.findUnique({ where: { id }, select }),
    decryptRow: (user) => {
      // Derive user-specific key and decrypt
      const userKey = crypto.createHash('sha256')
        .update(Buffer.concat([Buffer.from(user.id || ''), getServerKey()]))
        .digest()
      return aesGcmDecrypt(userKey, user.apiKey)
    },
  })
  return async (req, res, next) => {
    try {
      // Only check if no account session exists (user API key, not account API key)
      if (req.appAccountId) {
        // Account session exists, skip user API key check
        return next()
      }

      const presented = parsePresentedKey(req.headers['authorization'] || '')
      if (!presented) {
        return next() // No API key, continue with normal auth
      }

      const user = await keys.lookup(presented)
      if (user) {
        req.appUserId = user.id
        req.appAccountId = user.accountId || 'default'
        return next()
      }

      // API key not found, but don't fail - might be account API key or session auth
      return next()
    } catch (e) {
      // Error validating, continue with normal auth
      return next()
    }
  }
}

module.exports = { createUserApiKeyMiddleware }










