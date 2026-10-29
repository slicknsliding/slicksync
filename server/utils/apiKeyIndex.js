// Finds who an API key belongs to without decrypting every stored key on each
// request. Keys are stored encrypted per owner, so the only way to match one
// is to decrypt them all; doing that per request let anyone sending made-up
// keys make the server do work that grows with every account. Here they are
// decrypted once into a map from the key's hash to its owner, rebuilt at most
// every `minRebuildMs` when a key is not found (a key made a moment ago) and
// every `maxAgeMs` regardless. A hit is checked against the owner's stored key
// again, so a key rotated or removed since stops working at once.
const crypto = require('crypto')

const hashOf = (key) => crypto.createHash('sha256').update(String(key)).digest('hex')

// Constant-time comparison: a plain === returns as soon as two characters
// differ, so how long the answer takes would depend on how much of the key
// was right.
function keysMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// When any key was last made, so a key used right after it is made is found
// at once instead of after the next rebuild.
let changedAt = 0
function markKeysChanged() { changedAt = Date.now() }

function createKeyIndex({ loadAll, decryptRow, loadOne, maxAgeMs = 5 * 60 * 1000, minRebuildMs = 15 * 1000 }) {
  let map = null
  let builtAt = 0
  let building = null

  async function rebuild() {
    if (!building) {
      building = (async () => {
        const next = new Map()
        for (const row of await loadAll()) {
          try {
            const key = decryptRow(row)
            if (key) next.set(hashOf(key), row.id)
          } catch { /* a key that will not decrypt matches nothing */ }
        }
        map = next
        builtAt = Date.now()
      })().finally(() => { building = null })
    }
    return building
  }

  async function verified(id, presented) {
    if (!id) return null
    const row = await loadOne(id)
    if (!row) return null
    try { return keysMatch(decryptRow(row), presented) ? row : null } catch { return null }
  }

  return {
    async lookup(presented) {
      if (!presented) return null
      const age = Date.now() - builtAt
      if (!map || age > maxAgeMs) await rebuild()
      const hit = map.get(hashOf(presented))
      if (hit) return verified(hit, presented)
      if (Date.now() - builtAt > minRebuildMs || changedAt >= builtAt) {
        await rebuild()
        return verified(map.get(hashOf(presented)), presented)
      }
      return null
    },
    // For tests.
    _reset() { map = null; builtAt = 0 },
  }
}

module.exports = { createKeyIndex, markKeysChanged }
