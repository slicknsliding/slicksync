// Scheduled Vault backup - a nightly copy of every vault entry in
// data/backup/vault/, kept apart from the main database so it can be pulled
// off the server (scp) and restored or imported elsewhere.
//
// The copy is ENCRYPTED: AES-256-GCM under a key made from
// VAULT_BACKUP_PASSPHRASE when that is set, otherwise from the install's own
// encryption key (ENCRYPTION_KEY, or the one SlickSync generated). It used to
// be plain JSON, so anyone who could read the data folder - or a copy of it -
// had every password and API key in the Vault. Read one with
//   node scripts/vault-backup-decrypt.js data/backup/vault/latest.json
// VAULT_BACKUP_PLAINTEXT=true brings back plain files for anyone who imports
// them into a password manager on a schedule; nothing else turns that on.
//
// Files are written to a temporary name and renamed into place, so a crash
// or a full disk never leaves a half-written latest.json behind.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup', 'vault')
const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_COUNT = 14 // keep the last 14 backups regardless of schedule frequency

let vaultBackupTimer = null

function ensureBackupDir() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  } catch {}
}

function pruneOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('vault-backup-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    for (const file of files.slice(RETENTION_COUNT)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, file.name)) } catch {}
    }
  } catch {}
}

// Hours between nightly backups: the env value when it is a positive number,
// otherwise the default (NaN, zero and negatives would make setInterval spin).
function parseIntervalHours(raw, fallback = 24) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Whether to write plain files, by explicit choice only.
function plaintextChosen() {
  return /^(1|true|yes)$/i.test(String(process.env.VAULT_BACKUP_PLAINTEXT || ''))
}

// The install's key (raw bytes) as text: base64, so no byte is lost on the way
// into the passphrase.
function installKeyText() {
  const { ENCRYPTION_KEY } = require('./keyManager')
  return Buffer.isBuffer(ENCRYPTION_KEY) ? ENCRYPTION_KEY.toString('base64') : String(ENCRYPTION_KEY)
}

function backupPassphrase() {
  if (process.env.VAULT_BACKUP_PASSPHRASE) return { passphrase: process.env.VAULT_BACKUP_PASSPHRASE, keyFrom: 'VAULT_BACKUP_PASSPHRASE' }
  return { passphrase: installKeyText(), keyFrom: 'ENCRYPTION_KEY' }
}

async function backupFileContents(bundle, { plaintext = plaintextChosen(), passphrase } = {}) {
  if (plaintext) return bundle
  const { scryptKey, aesGcmEncrypt } = require('./encryption')
  const chosen = passphrase ? { passphrase, keyFrom: 'given' } : backupPassphrase()
  const salt = crypto.randomBytes(16)
  const key = await scryptKey(chosen.passphrase, salt.toString('base64'))
  return {
    format: 'slicksync-vault-backup',
    version: 1,
    encrypted: true,
    keyFrom: chosen.keyFrom,
    exportedAt: bundle.exportedAt,
    count: bundle.entries.length,
    salt: salt.toString('base64'),
    payload: aesGcmEncrypt(key, JSON.stringify(bundle)),
  }
}

async function readBackupFile(contents, passphrase) {
  const file = typeof contents === 'string' ? JSON.parse(contents) : contents
  if (!file.encrypted) return file
  const { scryptKey, aesGcmDecrypt } = require('./encryption')
  const key = await scryptKey(passphrase, file.salt)
  return JSON.parse(aesGcmDecrypt(key, file.payload))
}

// Owner-only from the moment it exists, then renamed over the old file.
function writeAtomic(target, body) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, target)
    fs.chmodSync(target, 0o600)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

async function performVaultBackupOnce({ prisma, decrypt }) {
  ensureBackupDir()
  try {
    const accounts = await prisma.appAccount.findMany({ select: { id: true } })
    const accountIds = accounts.length ? accounts.map(a => a.id) : ['default']

    const allEntries = []
    for (const accountId of accountIds) {
      const entries = await prisma.vaultEntry.findMany({ where: { accountId } })
      for (const entry of entries) {
        const mockReq = { appAccountId: accountId }
        let secret = null
        try { secret = decrypt(entry.encryptedSecret, mockReq) } catch {
          secret = null // don't fail the whole backup over one bad entry
        }
        allEntries.push({
          name: entry.name,
          category: entry.category,
          provider: entry.provider,
          secretLabel: entry.secretLabel,
          secret,
          testType: entry.testType,
          testConfig: entry.testConfig ? JSON.parse(entry.testConfig) : null,
          dashboardUrl: entry.dashboardUrl,
          expiresAt: entry.expiresAt,
          notifyDaysBefore: entry.notifyDaysBefore,
          isActive: entry.isActive,
          updatedAt: entry.updatedAt,
        })
      }
    }

    const exportedAt = new Date().toISOString()
    const stamp = exportedAt.replace(/[:]/g, '-').split('.')[0]
    const filename = path.join(BACKUP_DIR, `vault-backup-${stamp}.json`)
    const body = JSON.stringify(await backupFileContents({ exportedAt, entries: allEntries }), null, 2)
    writeAtomic(filename, body)
    // A fixed name for pull scripts.
    writeAtomic(path.join(BACKUP_DIR, 'latest.json'), body)

    pruneOldBackups()
    console.log(`[VaultBackup] Wrote ${allEntries.length} entries to ${filename}${plaintextChosen() ? ' (plain text, VAULT_BACKUP_PLAINTEXT is on)' : ''}`)
  } catch (err) {
    console.error('[VaultBackup] Backup failed:', err.message)
  }
}

function scheduleVaultBackups({ prisma, decrypt, intervalHours = 24 }) {
  if (vaultBackupTimer) {
    clearInterval(vaultBackupTimer)
    vaultBackupTimer = null
  }
  intervalHours = parseIntervalHours(intervalHours)
  const intervalMs = intervalHours * 60 * 60 * 1000

  // Run once shortly after boot, then on the interval
  setTimeout(() => performVaultBackupOnce({ prisma, decrypt }), 60 * 1000)
  vaultBackupTimer = setInterval(() => performVaultBackupOnce({ prisma, decrypt }), intervalMs)
  console.log(`[VaultBackup] Scheduled every ${intervalHours}h, writing to ${BACKUP_DIR}`)
}

module.exports = { scheduleVaultBackups, performVaultBackupOnce, parseIntervalHours, BACKUP_DIR, backupFileContents, readBackupFile, writeAtomic, installKeyText }
