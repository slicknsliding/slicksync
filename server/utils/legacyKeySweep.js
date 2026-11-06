// One-time (idempotent) move of stored secrets off the old public default key.
//
// Before keyManager, an install with no ENCRYPTION_KEY sealed its secrets under
// a key printed in the source. keyManager still reads those as a fallback, so
// nothing is lost - but anyone who has the source can open them. This finds
// values that open ONLY under that key and re-seals them under the current one.
//
// Safe by construction: a value is rewritten only after the new copy has been
// checked to open under the current key, and the write is conditional on the
// column still holding the exact old text (a concurrent change wins, a failed
// write leaves the old value, which still opens through the fallback).
// Values sealed under a per-account key never open with the server keys, so
// they are never touched.
const { aesGcmEncrypt, aesGcmDecrypt } = require('./encryption')

// model -> encrypted columns (see prisma/schema.prisma)
const TARGETS = [
  ['user', ['stremioAuthKey', 'nuvioRefreshToken', 'jellyfinToken', 'aioConfigPassword', 'simklAccessToken']],
  ['userProviderCredential', ['stremioAuthKey', 'nuvioRefreshToken', 'jellyfinToken']],
  ['jellyfinProfile', ['token']],
  ['inviteRequest', ['stremioAuthKey', 'nuvioRefreshToken', 'jellyfinToken']],
  ['vaultEntry', ['encryptedSecret']],
  ['addon', ['manifestUrl', 'manifest', 'originalManifest']],
  ['appAccount', ['twoFactorSecret']],
  ['streamGateWrap', ['realUrl']],
]
const BATCH = 200

const opens = (key, value) => { try { aesGcmDecrypt(key, value); return true } catch { return false } }

async function sweepLegacyKey(prisma, { current, legacy, targets = TARGETS, log = console } = {}) {
  const keys = require('./keyManager')
  current = current || keys.ENCRYPTION_KEY
  legacy = legacy || keys.LEGACY_KEY
  const result = { rewritten: 0, failed: 0 }
  if (!legacy || current.equals(legacy)) return result

  for (const [model, columns] of targets) {
    if (!prisma[model]) continue
    for (const column of columns) {
      let cursor
      try {
        for (;;) {
          const rows = await prisma[model].findMany({
            where: { [column]: { not: null } },
            select: { id: true, [column]: true },
            orderBy: { id: 'asc' },
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          })
          if (!rows.length) break
          cursor = rows[rows.length - 1].id
          for (const row of rows) {
            const old = row[column]
            if (typeof old !== 'string' || !old || opens(current, old) || !opens(legacy, old)) continue
            try {
              const fresh = aesGcmEncrypt(current, aesGcmDecrypt(legacy, old))
              if (!opens(current, fresh)) throw new Error('re-sealed value does not open')
              const done = await prisma[model].updateMany({ where: { id: row.id, [column]: old }, data: { [column]: fresh } })
              if (done.count) result.rewritten++
            } catch (e) {
              result.failed++
              log.warn(`[keyManager] could not move ${model}.${column} off the legacy key: ${e?.message}`)
            }
          }
          if (rows.length < BATCH) break
        }
      } catch (e) {
        // Table or column missing on an older database: nothing to move.
      }
    }
  }
  // Operators: once this reports 0 moved and 0 failed on a boot, nothing readable still depends on the legacy key.
  log.log(`[keyManager] legacy default key sweep: ${result.rewritten} value(s) moved to the current key, ${result.failed} could not be moved`)
  return result
}

module.exports = { sweepLegacyKey, TARGETS }
