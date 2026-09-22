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
const { resolveServerConfigForAccount } = require('./supabase')

function makeCreateProvider({ prisma, encrypt, getAccountId } = {}) {
  return function createProvider(user, { decrypt, req }) {
    const type = user.providerType || 'stremio'

    try {
      if (type === 'nuvio') {
        if (!user.nuvioRefreshToken || !user.nuvioUserId) return null

        // A merged user's absorbed second provider (see
        // server/utils/userMerge.js / UserProviderCredential) still needs
        // user.id to be the real surviving User.id - that's what group-
        // membership lookups elsewhere in the sync pipeline match against -
        // but that means the DEFAULT persistence below (keyed on that same
        // id) would refresh-write into the survivor's own User.nuvioRefreshToken
        // field instead of the absorbed UserProviderCredential row it
        // actually belongs to. __persistNuvioRefreshToken lets a caller
        // building a credentials object for a secondary provider override
        // WHERE a refreshed token is persisted without changing WHICH id
        // group lookups see - same plaintext-in contract as the default
        // closure (encrypts it itself), so this is a drop-in replacement,
        // not a different calling convention.
        const onTokenRefresh = typeof user.__persistNuvioRefreshToken === 'function'
          ? async (newRefreshToken) => user.__persistNuvioRefreshToken(encrypt(newRefreshToken, req))
          : (prisma && encrypt && user.id)
            ? async (newRefreshToken) => {
                const encrypted = encrypt(newRefreshToken, req)
                // Nuvio rotates the refresh token every time it is used, so
                // the old one stops working. One Nuvio account can now be
                // held by more than one user here - one per profile - and
                // they all authenticate with the same credential. Saving the
                // rotated token against only the user that happened to
                // trigger the refresh would leave every sibling holding a
                // token that has already been spent, and they would fail to
                // connect the next time they were used. So every user on the
                // same Nuvio account is moved to the new token together.
                if (user.nuvioUserId) {
                  await prisma.user.updateMany({
                    where: {
                      providerType: 'nuvio',
                      nuvioUserId: user.nuvioUserId,
                      ...(user.accountId ? { accountId: user.accountId } : {})
                    },
                    data: { nuvioRefreshToken: encrypted }
                  })
                } else {
                  await prisma.user.update({
                    where: { id: user.id },
                    data: { nuvioRefreshToken: encrypted }
                  })
                }
              }
            : undefined

        return createNuvioProvider({
          refreshToken: decrypt(user.nuvioRefreshToken, req),
          userId: user.nuvioUserId,
          // Which of the account's profiles this user's addon list belongs
          // to. Passed straight through when the caller already selected it;
          // otherwise the resolver below reads it once, on first use, so a
          // caller that selected only the columns it needed cannot end up
          // writing one profile's addons into another's list.
          profileId: user.nuvioProfileId,
          resolveProfileId: prisma && user.id
            ? async () => {
                const row = await prisma.user.findUnique({
                  where: { id: user.id },
                  select: { nuvioProfileId: true, providerType: true }
                })
                return row?.providerType === 'nuvio' ? row.nuvioProfileId : 1
              }
            : undefined,
          onTokenRefresh,
          // Lets an account point Nuvio at its own self-hosted backend
          // instead of api.nuvio.tv. Passed as a resolver rather than a
          // value because this factory is synchronous everywhere it's
          // called and the lookup needs a DB read - the provider resolves
          // it on first use and caches it. Falls back to the env vars, then
          // the public defaults, so an account that sets nothing is
          // completely unaffected.
          resolveServerConfig: prisma
            ? () => {
                const accountId = (typeof getAccountId === 'function' ? getAccountId(req) : null)
                  || user.accountId
                  || 'default'
                return resolveServerConfigForAccount(prisma, accountId)
              }
            : undefined
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
