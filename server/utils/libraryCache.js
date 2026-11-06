/**
 * Libraries cache utility - stores user library data for fast queries
 * Organizes files by account ID: CACHE_DIR/account-{accountId}/library-{email}.json
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Use /app/data/libraries in Docker, or relative path in development
// In Docker, __dirname will be /app/server/utils, so ../../data/libraries = /app/data/libraries
const CACHE_DIR = process.env.LIBRARIES_CACHE_DIR || path.join(__dirname, '../../data/libraries')
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes cache TTL

// Ensure cache directory exists
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

/**
 * Get account-specific cache directory
 */
function getAccountCacheDir(accountId) {
  ensureCacheDir()
  const accountDir = path.join(CACHE_DIR, `account-${accountId}`)
  if (!fs.existsSync(accountDir)) {
    fs.mkdirSync(accountDir, { recursive: true })
  }
  return accountDir
}

/**
 * Get cache file path for a user within an account folder.
 *
 * Keyed by user id, NOT email. Email-keyed naming was a real data-corruption
 * bug: the same person's Stremio and Nuvio accounts legitimately share one
 * email (that pairing is a first-class supported case - see the account-merge
 * and provider-disambiguation logic), so both users resolved to the SAME
 * library-{email}.json file. Whichever synced last overwrote it, and when the
 * other user's live provider fetch failed, its fallback read that file and got
 * the OTHER PROVIDER'S library - which metricsProcessor then wrote out as that
 * user's own watch history.
 *
 * Confirmed live on a real instance: 7 episodes carrying Nuvio profile labels
 * ("Main Profile", "Test") were written onto a Stremio-typed user, each an
 * exact duplicate of a Nuvio row - identical watchedAt to the millisecond,
 * createdAt days later. The user id is the only key guaranteed unique per
 * provider account, so it is what this uses now.
 */
function getCacheFilePath(accountId, user) {
  const accountDir = getAccountCacheDir(accountId)
  const userId = user && user.id ? user.id : user
  return path.join(accountDir, `user-${userId}.json`)
}

/**
 * Legacy email-keyed path, read-only. Still consulted on a cache MISS so an
 * existing install doesn't lose its warm cache on upgrade - but never written
 * to again, and never used when the account shares its email with another
 * user (that's precisely the collision above, where the file's contents may
 * belong to the other provider entirely).
 */
function getLegacyEmailCachePath(accountId, user) {
  if (!user || !user.email) return null
  const safeEmail = user.email.replace(/[^a-zA-Z0-9@._-]/g, '_')
  return path.join(getAccountCacheDir(accountId), `library-${safeEmail}.json`)
}

// Parsed libraries kept in memory so a repeat read of an unchanged file skips
// the read and JSON.parse of several MB. Keyed by path and checked against the
// file's mtime and size on every hit, so a write from anywhere is seen. A few
// entries only: libraries are large.
const PARSED_MAX = 4
const parsedCache = new Map() // path -> { mtimeMs, size, parsed } (Map order = LRU)

// Callers get their own array and their own item and state objects, so
// editing a returned library never reaches the next reader.
function copyLibrary(parsed) {
  return parsed.map((item) => {
    if (!item || typeof item !== 'object') return item
    const copy = { ...item }
    if (copy.state && typeof copy.state === 'object' && !Array.isArray(copy.state)) copy.state = { ...copy.state }
    return copy
  })
}

function rememberParsed(cachePath, st, parsed) {
  parsedCache.delete(cachePath)
  parsedCache.set(cachePath, { mtimeMs: st.mtimeMs, size: st.size, parsed })
  while (parsedCache.size > PARSED_MAX) parsedCache.delete(parsedCache.keys().next().value)
}

/**
 * Read cached library data for a user
 * Cache files are stored as plain arrays (compatible with stremthru restore format)
 * @param {string} accountId - Account ID
 * @param {object|string} user - User object {id, email} or userId string
 * @returns {Array|null} - Cached library array or null
 */
function getCachedLibrary(accountId, user, { allowLegacyEmailFile = false } = {}) {
  try {
    let cachePath = getCacheFilePath(accountId, user)

    // Fall back to the pre-fix email-keyed file only when the caller has
    // confirmed no other user on this account shares this email. Defaults to
    // false so any caller that hasn't thought about it gets the safe
    // behavior: a cache miss (one live re-fetch) rather than a possible
    // cross-provider library. See getCacheFilePath's comment for what that
    // collision actually did to real data.
    if (!fs.existsSync(cachePath) && allowLegacyEmailFile) {
      const legacyPath = getLegacyEmailCachePath(accountId, user)
      if (legacyPath && fs.existsSync(legacyPath)) {
        cachePath = legacyPath
      }
    }

    if (!fs.existsSync(cachePath)) {
      return null
    }

    const st = fs.statSync(cachePath)
    const hit = parsedCache.get(cachePath)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      parsedCache.delete(cachePath)
      parsedCache.set(cachePath, hit)
      return copyLibrary(hit.parsed)
    }
    parsedCache.delete(cachePath)

    const data = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(data)

    // Handle new format: plain array
    if (Array.isArray(parsed)) {
      rememberParsed(cachePath, st, parsed)
      return copyLibrary(parsed)
    }

    // Handle old format: {timestamp, library: [...]} - migrate on read
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.library)) {
      // Migrate: write back as new format (plain array)
      try {
        fs.writeFileSync(cachePath, JSON.stringify(parsed.library, null, 2), 'utf8')
      } catch (migrateError) {
        console.warn(`Failed to migrate cache file for user ${user.id || user} in account ${accountId}:`, migrateError.message)
      }
      return parsed.library
    }

    return null
  } catch (error) {
    console.warn(`Failed to read cache for user ${user.id || user} in account ${accountId}:`, error.message)
    return null
  }
}

/**
 * Cache library data for a user
 * @param {string} accountId - Account ID
 * @param {object|string} user - User object {id, email} or userId string
 * @param {Array} library - Library data to cache
 */
// What each file last had written, so an unchanged library (most of them,
// most minutes) isn't written again.
const lastWritten = new Map() // path -> sha1 of the JSON
let writeSeq = 0

function setCachedLibrary(accountId, user, library) {
  try {
    const cachePath = getCacheFilePath(accountId, user)
    parsedCache.delete(cachePath)

    // Store as plain array (compatible with stremthru restore format).
    // Compact, not pretty-printed - a third of the size for the same data.
    const data = Array.isArray(library) ? library : []
    const json = JSON.stringify(data)
    const hash = crypto.createHash('sha1').update(json).digest('hex')
    if (lastWritten.get(cachePath) === hash && fs.existsSync(cachePath)) return
    lastWritten.set(cachePath, hash)
    // Written in the background - the activity monitor calls this for every
    // person every minute, and a synchronous write of a large library held
    // up every request meanwhile. A temporary file renamed into place means
    // a reader never sees half a file.
    const tmp = `${cachePath}.${process.pid}.${++writeSeq}.tmp`
    fs.promises.writeFile(tmp, json, 'utf8')
      .then(() => fs.promises.rename(tmp, cachePath))
      .catch((error) => {
        lastWritten.delete(cachePath)
        fs.promises.unlink(tmp).catch(() => {})
        console.warn(`Failed to write cache for user ${user.id || user} in account ${accountId}:`, error.message)
      })
    
    // The old email-keyed file is deliberately NOT deleted here. When two
    // users share an email they also shared that one file, so removing it as
    // soon as the first of them writes its own id-keyed cache would strip the
    // other user's only warm cache before it has migrated. It stops being
    // read once each user has an id-keyed file (see getCachedLibrary), so
    // leaving it costs one stale file rather than risking a cold start for
    // the sibling account.
  } catch (error) {
    console.warn(`Failed to write cache for user ${user.id || user} in account ${accountId}:`, error.message)
  }
}

/**
 * Clear cache for a user
 * @param {string} accountId - Account ID
 * @param {object|string} user - User object {id, email} or userId string
 */
function clearCache(accountId, user) {
  try {
    const cachePath = getCacheFilePath(accountId, user)
    parsedCache.delete(cachePath)
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath)
    }
    
    // Also clear legacy file if it exists
    if (typeof user === 'object' && user.id) {
        const legacyPath = path.join(getAccountCacheDir(accountId), `user-${user.id}.json`)
        if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath)
        }
    }
  } catch (error) {
    console.warn(`Failed to clear cache for user ${user.id || user} in account ${accountId}:`, error.message)
  }
}

/**
 * Clear all caches for an account
 * @param {string} accountId - Account ID (optional, if not provided clears all accounts)
 */
function clearAllCaches(accountId) {
  parsedCache.clear()
  try {
    ensureCacheDir()
    if (accountId) {
      // Clear only for specific account
      const accountDir = path.join(CACHE_DIR, `account-${accountId}`)
      if (fs.existsSync(accountDir)) {
        const files = fs.readdirSync(accountDir)
        files.forEach(file => {
          if (file.endsWith('.json')) { // Clear all json files (both user- and library-)
            try {
              fs.unlinkSync(path.join(accountDir, file))
            } catch (error) {
              console.warn(`Failed to delete cache file ${file}:`, error.message)
            }
          }
        })
      }
    } else {
      // Clear all accounts
      const accounts = fs.readdirSync(CACHE_DIR)
      accounts.forEach(accountFolder => {
        if (accountFolder.startsWith('account-')) {
          const accountDir = path.join(CACHE_DIR, accountFolder)
          const files = fs.readdirSync(accountDir)
          files.forEach(file => {
            if (file.endsWith('.json')) {
              try {
                fs.unlinkSync(path.join(accountDir, file))
              } catch (error) {
                console.warn(`Failed to delete cache file ${file}:`, error.message)
              }
            }
          })
        }
      })
    }
  } catch (error) {
    console.warn('Failed to clear caches:', error.message)
  }
}

/**
 * Load cached libraries for multiple users within an account
 * @param {string} accountId - Account ID
 * @param {Array<object|string>} users - Array of user objects or IDs
 * @returns {Map<string, Array>} - Map of userId -> library array
 */
function getAllCachedLibraries(accountId, users) {
  const result = new Map()
  if (!Array.isArray(users) || users.length === 0) {
    return result
  }
  
  for (const user of users) {
    try {
      const library = getCachedLibrary(accountId, user)
      if (library && Array.isArray(library) && library.length > 0) {
        const userId = typeof user === 'object' ? user.id : user
        result.set(userId, library)
      }
    } catch (error) {
      // Skip users with invalid cache
      const userId = typeof user === 'object' ? user.id : user
      console.warn(`Failed to load cache for user ${userId} in account ${accountId}:`, error.message)
    }
  }
  
  return result
}

/**
 * Get cache stats for an account (or all accounts if accountId is not provided)
 * @param {string} accountId - Account ID (optional)
 * @returns {Object} - Cache statistics
 */
function getCacheStats(accountId) {
  try {
    ensureCacheDir()
    let cacheFiles = []
    
    if (accountId) {
      // Stats for specific account
      const accountDir = path.join(CACHE_DIR, `account-${accountId}`)
      if (fs.existsSync(accountDir)) {
        const files = fs.readdirSync(accountDir)
        cacheFiles = files.filter(f => f.endsWith('.json'))
          .map(f => path.join(accountDir, f))
      }
    } else {
      // Stats for all accounts
      const accounts = fs.readdirSync(CACHE_DIR)
      accounts.forEach(accountFolder => {
        if (accountFolder.startsWith('account-')) {
          const accountDir = path.join(CACHE_DIR, accountFolder)
          const files = fs.readdirSync(accountDir)
          cacheFiles.push(...files.filter(f => f.endsWith('.json'))
            .map(f => path.join(accountDir, f)))
        }
      })
    }
    
    let totalSize = 0
    let oldestTimestamp = Date.now()
    let newestTimestamp = 0

    cacheFiles.forEach(filePath => {
      try {
        const stats = fs.statSync(filePath)
        totalSize += stats.size

        // Use file modification time for timestamp (works for both old and new format)
        const mtime = stats.mtimeMs
        if (mtime < oldestTimestamp) oldestTimestamp = mtime
        if (mtime > newestTimestamp) newestTimestamp = mtime
      } catch (error) {
        // Skip invalid files
      }
    })

    return {
      fileCount: cacheFiles.length,
      totalSize,
      oldestTimestamp: oldestTimestamp === Date.now() ? null : oldestTimestamp,
      newestTimestamp: newestTimestamp === 0 ? null : newestTimestamp
    }
  } catch (error) {
    return { fileCount: 0, totalSize: 0, oldestTimestamp: null, newestTimestamp: null }
  }
}

module.exports = {
  getCachedLibrary,
  setCachedLibrary,
  getAllCachedLibraries,
  clearCache,
  clearAllCaches,
  getCacheStats,
  CACHE_TTL_MS
}

