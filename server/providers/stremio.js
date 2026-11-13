/**
 * Stremio provider — wraps StremioAPIClient.
 * This is a thin pass-through. The existing normalization logic from sync.js
 * is moved here so it's encapsulated in the provider.
 */

const { StremioAPIClient } = require('stremio-api-client')

function createStremioProvider({ authKey }) {
  const client = new StremioAPIClient({
    endpoint: 'https://api.strem.io',
    authKey
  })

  return {
    type: 'stremio',

    // --- Addon Transport ---

    async getAddons() {
      const collection = await client.request('addonCollectionGet', {})

      // Reading never writes to a person's account. This runs for every
      // status badge and background check, and an account whose list came
      // back as null once (a degraded answer from Stremio, not necessarily an
      // empty account) used to be overwritten with an empty one by the read
      // itself. Null is treated as "no addons" below; the next sync writes a
      // proper list.
      //
      // Normalization logic from sync.js:16-62 — handles null, non-array, corrupted responses
      const rawAddons = collection?.addons !== undefined ? collection.addons : collection
      let addonsArray = []
      if (rawAddons !== null && rawAddons !== undefined) {
        if (Array.isArray(rawAddons)) {
          addonsArray = rawAddons
        } else if (typeof rawAddons === 'object') {
          addonsArray = Object.values(rawAddons)
        }
      }

      const addons = addonsArray.map((addon) => {
        const manifest = addon?.manifest
        if (manifest && typeof manifest === 'object') {
          const { manifestUrl, ...restManifest } = manifest
          return { ...addon, manifest: restManifest, transportName: '' }
        }
        return { ...addon, transportName: '' }
      })

      if (!Array.isArray(addons)) return { addons: [] }
      return { addons }
    },

    async setAddons(addons) {
      await client.request('addonCollectionSet', { addons })
    },

    async addAddon(url, manifest) {
      await client.request('addonCollectionAdd', { addonId: url, manifest })
    },

    async clearAddons() {
      await client.request('addonCollectionSet', { addons: [] })
    },

    // --- Content ---

    async getLibrary() {
      const items = await client.request('datastoreGet', {
        collection: 'libraryItem',
        ids: [],
        all: true
      })
      return items
    },

    // Just these titles, for reading a viewing more often than a whole library.
    async getLibraryItems(ids) {
      return client.request('datastoreGet', { collection: 'libraryItem', ids, all: false })
    },

    // Capability flag: Stremio supports library writes via datastorePut
    supportsLibraryWrite: true,

    async addLibraryItem(changes) {
      await client.request('datastorePut', {
        collection: 'libraryItem',
        changes
      })
    },

    async removeLibraryItem(changes) {
      await client.request('datastorePut', {
        collection: 'libraryItem',
        changes
      })
    },

    async getLikeStatus(mediaId, mediaType) {
      const res = await fetch(
        `https://likes.stremio.com/api/get_status?authToken=${encodeURIComponent(authKey)}&mediaId=${encodeURIComponent(mediaId)}&mediaType=${encodeURIComponent(mediaType)}`,
        { signal: AbortSignal.timeout(10000) }
      )
      if (!res.ok) return null
      return await res.json()
    },

    async setLikeStatus(mediaId, mediaType, status) {
      await fetch('https://likes.stremio.com/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: authKey, mediaId, mediaType, status }),
        signal: AbortSignal.timeout(10000),
      })
    },

    // Raw client access for edge cases during migration
    get client() { return client }
  }
}

module.exports = { createStremioProvider }
