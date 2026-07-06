// Scheduled Vault backup — writes a decrypted JSON export of all vault entries
// to data/backup/vault/ so it can be pulled off the VPS (e.g. via scp) for
// off-server backup or syncing into an external password manager.
//
// This is deliberately DECRYPTED at export time (unlike the main sqlite.db,
// which stays encrypted at rest) because the whole point is portability —
// an external tool like Bitwarden needs the actual secret value, not our
// AES-GCM ciphertext. Treat the export directory as sensitive: it should
// only ever leave this server over an already-trusted channel (SSH/scp),
// never over a public URL.

const fs = require('fs')
const path = require('path')

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup', 'vault')
const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_COUNT = 14 // keep the last 14 backups regardless of schedule frequency

let vaultBackupTimer = null

function ensureBackupDir() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
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

    const stamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0]
    const filename = path.join(BACKUP_DIR, `vault-backup-${stamp}.json`)
    fs.writeFileSync(filename, JSON.stringify({ exportedAt: new Date().toISOString(), entries: allEntries }, null, 2), 'utf8')
    fs.chmodSync(filename, 0o600) // owner-read-write only — this file contains plaintext secrets

    // Convenience symlink-like copy so external pull scripts can always grab a fixed filename
    const latestPath = path.join(BACKUP_DIR, 'latest.json')
    fs.writeFileSync(latestPath, JSON.stringify({ exportedAt: new Date().toISOString(), entries: allEntries }, null, 2), 'utf8')
    fs.chmodSync(latestPath, 0o600)

    pruneOldBackups()
    console.log(`[VaultBackup] Wrote ${allEntries.length} entries to ${filename}`)
  } catch (err) {
    console.error('[VaultBackup] Backup failed:', err.message)
  }
}

function scheduleVaultBackups({ prisma, decrypt, intervalHours = 24 }) {
  if (vaultBackupTimer) {
    clearInterval(vaultBackupTimer)
    vaultBackupTimer = null
  }
  const intervalMs = intervalHours * 60 * 60 * 1000

  // Run once shortly after boot, then on the interval
  setTimeout(() => performVaultBackupOnce({ prisma, decrypt }), 60 * 1000)
  vaultBackupTimer = setInterval(() => performVaultBackupOnce({ prisma, decrypt }), intervalMs)
  console.log(`[VaultBackup] Scheduled every ${intervalHours}h, writing to ${BACKUP_DIR}`)
}

module.exports = { scheduleVaultBackups, performVaultBackupOnce, BACKUP_DIR }
