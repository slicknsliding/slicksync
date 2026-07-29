// Consolidate every stored secret onto the CURRENT encryption key.
//
// Why this exists: keyManager keeps previous keys as decrypt-only fallbacks
// (a rotated ENCRYPTION_KEY, or the legacy hardcoded default) so old data stays
// readable. But that leaves ciphertext split across key generations - and any
// code path that isn't fallback-aware then fails on whichever half is under an
// older key (confirmed real case 2026-07-29: a Stremio authKey encrypted under
// the legacy default polled the library fine but broke addon sync). This script
// re-encrypts every secret field under the current key, so nothing depends on a
// fallback anymore and the fallback list can eventually be dropped.
//
// Safe + idempotent: a value already decryptable with the current key is left
// untouched; only values that need a fallback to read are rewritten; anything
// that can't be decrypted by ANY known key is reported and left alone.
//
// Dry-run by default. Pass --apply to write. Pass --sync-keyfile (with --apply)
// to also rewrite data/server_secret.key to equal the current key, so the
// persisted key matches env and the "ENCRYPTION_KEY differs" boot warning stops
// (and removing ENCRYPTION_KEY from .env later can't silently re-split data).
//
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync \
//     node scripts/consolidate-encryption-keys.js [--apply] [--sync-keyfile]

const { PrismaClient } = require('@prisma/client')
const enc = require('../server/utils/encryption')
const { KEY_FILE } = require('../server/utils/keyManager')
const fs = require('fs')

const APPLY = process.argv.includes('--apply')
const SYNC_KEYFILE = process.argv.includes('--sync-keyfile')
const prisma = new PrismaClient()
const currentKey = enc.getServerKey()

// Already readable with the current key alone? Then it's consolidated already.
function isCurrent(text) {
  try { enc.aesGcmDecrypt(currentKey, text); return true } catch { return false }
}
// Read via the full fallback chain (server key + ENCRYPTION_KEY_FALLBACKS).
function decryptAny(text) {
  try { return enc.decrypt(text) } catch { return null }
}

const stats = {}
function bump(label, status) {
  stats[label] = stats[label] || { empty: 0, already: 0, reencrypt: 0, undecryptable: 0 }
  stats[label][status]++
}

// Returns the re-encrypted value to write, or null if no write is needed.
// Records status against `label` for the summary.
function planValue(label, text) {
  if (text === null || text === undefined || text === '') { bump(label, 'empty'); return null }
  if (isCurrent(text)) { bump(label, 'already'); return null }
  const plain = decryptAny(text)
  if (plain === null) { bump(label, 'undecryptable'); return null }
  bump(label, 'reencrypt')
  return enc.aesGcmEncrypt(currentKey, plain)
}

// Generic pass over a table's simple encrypted string columns.
async function consolidateTable(modelName, delegate, idField, fields) {
  const rows = await delegate.findMany()
  for (const row of rows) {
    const data = {}
    for (const f of fields) {
      const next = planValue(`${modelName}.${f}`, row[f])
      if (next !== null) data[f] = next
    }
    if (Object.keys(data).length > 0 && APPLY) {
      await delegate.update({ where: { [idField]: row[idField] }, data })
    }
  }
}

// AddonSnapshot.addonsJson is a JSON array whose entries each carry an encrypted
// `manifestUrl`. Walk and re-encrypt those in place, re-serialize if changed.
async function consolidateSnapshots() {
  const rows = await prisma.addonSnapshot.findMany()
  for (const row of rows) {
    let arr
    try { arr = JSON.parse(row.addonsJson) } catch { bump('AddonSnapshot.addonsJson', 'undecryptable'); continue }
    if (!Array.isArray(arr)) { bump('AddonSnapshot.addonsJson', 'empty'); continue }
    let changed = false
    for (const a of arr) {
      if (a && typeof a.manifestUrl === 'string' && a.manifestUrl) {
        const next = planValue('AddonSnapshot.addon.manifestUrl', a.manifestUrl)
        if (next !== null) { a.manifestUrl = next; changed = true }
      }
    }
    if (changed && APPLY) {
      await prisma.addonSnapshot.update({ where: { id: row.id }, data: { addonsJson: JSON.stringify(arr) } })
    }
  }
}

async function run() {
  console.log(`\n=== Encryption key consolidation (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)
  console.log(`Fallback keys available: ${(require('../server/utils/config').ENCRYPTION_KEY_FALLBACKS || []).length}\n`)

  await consolidateTable('User', prisma.user, 'id', ['stremioAuthKey', 'nuvioRefreshToken'])
  await consolidateTable('UserProviderCredential', prisma.userProviderCredential, 'id', ['stremioAuthKey', 'nuvioRefreshToken'])
  await consolidateTable('Addon', prisma.addon, 'id', ['manifestUrl', 'manifest', 'originalManifest'])
  await consolidateTable('VaultEntry', prisma.vaultEntry, 'id', ['encryptedSecret'])
  await consolidateSnapshots()

  console.log('Field                                   already  rewrite  UNREADABLE  empty')
  console.log('---------------------------------------------------------------------------')
  let totalRewrite = 0, totalUnreadable = 0
  for (const [label, s] of Object.entries(stats).sort()) {
    totalRewrite += s.reencrypt
    totalUnreadable += s.undecryptable
    const flag = s.undecryptable > 0 ? '  <-- REVIEW' : ''
    console.log(`${label.padEnd(38)}  ${String(s.already).padStart(6)}  ${String(s.reencrypt).padStart(6)}  ${String(s.undecryptable).padStart(9)}  ${String(s.empty).padStart(5)}${flag}`)
  }
  console.log('---------------------------------------------------------------------------')
  console.log(`\n${APPLY ? 'Re-encrypted' : 'Would re-encrypt'}: ${totalRewrite} value(s). Undecryptable: ${totalUnreadable}.`)
  if (totalUnreadable > 0) {
    console.log('!! Undecryptable values were LEFT UNCHANGED - no known key reads them. Investigate before dropping fallbacks.')
  }

  if (SYNC_KEYFILE) {
    if (!APPLY) {
      console.log('\n--sync-keyfile ignored without --apply.')
    } else if (totalUnreadable > 0) {
      console.log('\n--sync-keyfile SKIPPED: undecryptable values remain; not touching the key file until data is fully consolidated.')
    } else {
      fs.writeFileSync(KEY_FILE, currentKey.toString('base64'), { mode: 0o600 })
      console.log(`\nSynced ${KEY_FILE} to the current key - persisted key now matches env; the boot "ENCRYPTION_KEY differs" warning will stop.`)
    }
  }

  await prisma.$disconnect()
}

run().catch((e) => { console.error('ERROR', e); process.exit(1) })
