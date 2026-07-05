/**
 * Provider factory — creates the correct provider for a user based on providerType.
 *
 * Usage:
 *   const { makeCreateProvider } = require('./providers')
 *   const createProvider = makeCreateProvider({ prisma, encrypt })
 *   const provider = createProvider(user, { decrypt, req })
 *   if (!provider) return res.status(400).json({ error: 'User not connected' })
 *   const { addons } = await provider.getAddons()
 */

const { createStremioProvider } = require('./stremio')
const { createNuvioProvider } = require('./nuvio')

function makeCreateProvider({ prisma, encrypt } = {}) {
  return function createProvider(user, { decrypt, req }) {
    const type = user.providerType || 'stremio'

    try {
      if (type === 'nuvio') {
        if (!user.nuvioRefreshToken || !user.nuvioUserId) return null

        const onTokenRefresh = (prisma && encrypt && user.id)
          ? async (newRefreshToken) => {
              await prisma.user.update({
                where: { id: user.id },
                data: { nuvioRefreshToken: encrypt(newRefreshToken, req) }
              })
            }
          : undefined

        return createNuvioProvider({
          refreshToken: decrypt(user.nuvioRefreshToken, req),
          userId: user.nuvioUserId,
          onTokenRefresh
        })
      }

      // Default: stremio
      if (!user.stremioAuthKey) return null
      return createStremioProvider({
        authKey: decrypt(user.stremioAuthKey, req)
      })
    } catch (e) {
      console.warn('createProvider failed for user', user?.id, ':', e?.message)
      return null
    }
  }
}

// Backward compat: unconfigured version (no token persistence on refresh).
// Use makeCreateProvider({ prisma, encrypt }) for full functionality.
const createProvider = makeCreateProvider()

module.exports = { createProvider, makeCreateProvider }
