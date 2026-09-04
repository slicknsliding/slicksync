// Full-data backups: a real snapshot of the database itself, not just the
// config export.
//
// Why this exists: config backups (utils/backup.js) carry users, groups,
// addons, catalogs and settings - everything needed to rebuild the SETUP.
// They deliberately carry no watch history, which means the household's
// actual record - every episode anyone ever watched, and therefore Continue
// Watching, For You, Taste Profiles, streaks and Year in Review - existed in
// exactly one place: the live database file. A dead disk restored the setup
// perfectly and lost the history completely. This lane closes that hole.
//
// SQLite/private only, same boundary dbMaintenance draws: in public mode the
// database is Postgres, owned and backed up by whoever hosts it, and dumping
// it from inside the app would need a pg_dump binary this image doesn't ship.
//
// How the snapshot is taken: `VACUUM INTO`, which is SQLite's own supported
// way to write a consistent copy of a live database - it takes a read
// transaction, so it can't catch a half-written write, and it compacts as it
// goes. Copying the file byte-for-byte while the app is running (what a
// naive `cp` does) can capture a torn page and produce a backup that only
// looks fine until you need it.
//
// Contents warning, honestly stated: a data snapshot is the WHOLE database -
// watch history, accounts, and the Vault's rows. Vault secrets stay
// encrypted at rest under this instance's ENCRYPTION_KEY, so the snapshot
// alone doesn't hand anyone your credentials, but it is still far more
// sensitive than a config export. That's why an off-site copy REFUSES to
// upload unless an encryption passphrase is configured (see uploadIfAllowed
// below) - config backups may travel in the clear, this may not.
//
// Restore is deliberately NOT an in-app button: replacing the database a
// running process is holding open is how you get a half-restored instance.
// The file is downloadable and scripts/restore-data-snapshot.js performs the
// restore (decrypt + decompress + swap) while the container is stopped.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const DATA_BACKUP_DIR = path.join(process.cwd(), 'data', 'backup', 'data')
const SETTINGS_FILE = path.join(process.cwd(), 'data', 'data-backup-settings.json')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h due-check, same cadence as dbMaintenance
const BOOT_DELAY_MS = 4 * 60 * 1000 // staggered past the other boot schedulers
const DAY_MS = 24 * 60 * 60 * 1000

// Encrypted-snapshot container format, read back by
// scripts/restore-data-snapshot.js:
//   MAGIC(16) | salt(16) | iv(12) | tag(16) | ciphertext(...)
// The payload inside is the gzipped snapshot.
const MAGIC = Buffer.from('SLICKSYNCDATA001', 'utf8')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16

const DEFAULT_SETTINGS = {
  // Opt-in: this writes a full copy of the database on a schedule, which is
  // a real disk-space decision on someone else's box, so it is never on by
  // default even though it protects the most irreplaceable data here.
  enabled: false,
  frequencyDays: 1,
  // How many snapshots to keep locally. Unlike config backups (whose 0 means
  // "keep everything"), snapshots are DB-sized, so an unbounded default
  // would quietly fill a disk - hence a real number.
  keepLocal: 7,
  // Also send each snapshot to the configured off-site target. Honoured only
  // when an encryption passphrase is set - see uploadIfAllowed.
  offsite: false,
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  lastSizeBytes: null,
  lastVerified: null,
}

function getDbFilePath() {
  const url = process.env.DATABASE_URL || ''
  if (!url.startsWith('file:')) return null
  const p = url.replace(/^file:\/\/\/?/, '/')
  return p.startsWith('/') ? p : `/${p}`
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
    }
  } catch {}
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(partial) {
  const next = { ...getSettings(), ...partial }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next), 'utf8')
  } catch (e) {
    console.warn('[DataBackup] Failed to persist settings:', e?.message)
  }
  return next
}

function ensureDir() {
  try { fs.mkdirSync(DATA_BACKUP_DIR, { recursive: true }) } catch {}
}

/** Snapshots are DB-sized; refuse rather than fill the disk mid-write. */
function assertSpaceFor(dbPath) {
  try {
    const { size } = fs.statSync(dbPath)
    if (typeof fs.statfsSync !== 'function') return
    const stats = fs.statfsSync(path.dirname(dbPath))
    const freeBytes = stats.bavail * stats.bsize
    // The snapshot itself, plus its gzip, plus headroom.
    const needed = size * 2 + 32 * 1024 * 1024
    if (freeBytes < needed) {
      const mb = (n) => Math.round(n / 1048576)
      throw new Error(`Not enough free disk space for a snapshot (need ~${mb(needed)}MB, have ${mb(freeBytes)}MB)`)
    }
  } catch (e) {
    // A genuine shortfall stops the run; failing to MEASURE space must not.
    if (/free disk space/.test(e?.message || '')) throw e
  }
}

/**
 * Opens the finished snapshot and checks it is a working database, so a
 * corrupt copy is caught here rather than during a restore. bun:sqlite is
 * what this image runs on; if it isn't loadable the snapshot is still kept
 * (unverified) rather than thrown away.
 */
function verifySnapshot(snapshotPath) {
  try {
    // eslint-disable-next-line global-require
    const { Database } = require('bun:sqlite')
    const db = new Database(snapshotPath, { readonly: true })
    try {
      const integrity = db.query('PRAGMA integrity_check').all()
      const ok = integrity.some((row) => String(Object.values(row || {})[0] || '').toLowerCase() === 'ok')
      if (!ok) return { verified: false, reason: 'integrity_check did not return ok' }
      // A structurally-valid but empty file would also pass integrity_check,
      // so confirm the table the whole app is built around is really there.
      const users = db.query('SELECT COUNT(*) AS n FROM users').get()
      return { verified: true, users: Number(users?.n ?? 0) }
    } finally {
      try { db.close() } catch {}
    }
  } catch (e) {
    return { verified: null, reason: e?.message || 'verification unavailable' }
  }
}

function encryptBuffer(passphrase, plain) {
  const salt = crypto.randomBytes(SALT_LEN)
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 14, r: 8, p: 1 })
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct])
}

/**
 * Writes one snapshot: VACUUM INTO -> verify -> gzip -> optionally encrypt.
 * Returns the written file's path and metadata.
 */
async function createDataSnapshot(prisma) {
  const dbPath = getDbFilePath()
  if (!dbPath) return null // public/Postgres - not this lane's job
  ensureDir()
  assertSpaceFor(dbPath)

  const stamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0]
  const rawPath = path.join(DATA_BACKUP_DIR, `data-snapshot-${stamp}.db`)
  // VACUUM INTO refuses to overwrite, and a leftover from a crashed run
  // would otherwise block every future snapshot.
  try { fs.unlinkSync(rawPath) } catch {}

  // Path is composed here from a fixed directory and a timestamp, never from
  // user input; the quote-escape is belt-and-braces for the SQL string.
  await prisma.$executeRawUnsafe(`VACUUM INTO '${rawPath.replace(/'/g, "''")}'`)

  const check = verifySnapshot(rawPath)
  const gz = zlib.gzipSync(fs.readFileSync(rawPath))
  try { fs.unlinkSync(rawPath) } catch {}

  const passphrase = String(require('./backupTargets').getSettings().encryptPassphrase || '').trim()
  let finalPath = `${rawPath}.gz`
  let body = gz
  if (passphrase) {
    finalPath = `${rawPath}.gz.enc`
    body = encryptBuffer(passphrase, gz)
  }
  fs.writeFileSync(finalPath, body)

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    sizeBytes: body.length,
    encrypted: Boolean(passphrase),
    verified: check.verified,
    verifyNote: check.reason || null,
    users: check.users ?? null,
  }
}

/** Keeps the newest `keepLocal` snapshots, deletes the rest. */
function pruneSnapshots(keepLocal) {
  const keep = Math.max(1, Number(keepLocal) || 1)
  let files = []
  try {
    files = fs.readdirSync(DATA_BACKUP_DIR)
      .filter((f) => f.startsWith('data-snapshot-'))
      .map((f) => ({ f, t: fs.statSync(path.join(DATA_BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
  } catch { return 0 }
  let removed = 0
  for (const { f } of files.slice(keep)) {
    try { fs.unlinkSync(path.join(DATA_BACKUP_DIR, f)); removed++ } catch {}
  }
  return removed
}

/**
 * Off-site copy, with the one rule this lane adds: a full database snapshot
 * only leaves the box ENCRYPTED. Config exports may travel in the clear
 * (that's the operator's call); the entire database may not, so a missing
 * passphrase skips the upload loudly instead of quietly shipping everything.
 */
async function uploadIfAllowed(snapshot, prisma) {
  const settings = getSettings()
  if (!settings.offsite) return { skipped: 'offsite disabled' }
  const targets = require('./backupTargets').getSettings()
  if (targets.type === 'none') return { skipped: 'no off-site target configured' }
  if (!snapshot.encrypted) return { skipped: 'no encryption passphrase set - a full database snapshot is never uploaded unencrypted' }
  // Already encrypted here, so upload the bytes as-is rather than through
  // uploadBackup's JSON envelope.
  return require('./backupTargets').uploadBackup(snapshot.path, prisma, { raw: true, contentType: 'application/octet-stream' })
}

/** One full run: snapshot, prune, optional off-site copy, record outcome. */
async function runDataBackupOnce(prisma) {
  const started = Date.now()
  try {
    const snapshot = await createDataSnapshot(prisma)
    if (!snapshot) return null
    const settings = getSettings()
    pruneSnapshots(settings.keepLocal)
    const upload = await uploadIfAllowed(snapshot, prisma).catch((e) => ({ ok: false, error: e?.message }))
    saveSettings({
      lastRunAt: new Date().toISOString(),
      lastOkAt: new Date().toISOString(),
      lastError: null,
      lastSizeBytes: snapshot.sizeBytes,
      lastVerified: snapshot.verified,
    })
    console.log(`💾 Data snapshot written: ${snapshot.filename} (${Math.round(snapshot.sizeBytes / 1024)}KB, ${Date.now() - started}ms)`)
    return { ...snapshot, upload }
  } catch (e) {
    const message = e?.message || String(e)
    saveSettings({ lastRunAt: new Date().toISOString(), lastError: message })
    console.error('⚠️ Data snapshot failed:', message)
    try {
      const { createNotification } = require('./notificationStore')
      await createNotification(prisma, 'default', {
        type: 'task',
        title: 'Full-data backup failed',
        body: `The database snapshot could not be written: ${message}. Your watch history is only protected while these succeed.`,
        url: '/tasks',
        dedupeKey: 'data-backup-failed',
      })
      const { emitAutomationEvent } = require('./automation/engine')
      await emitAutomationEvent(prisma, 'default', 'backup.failed', { target: 'data-snapshot', message })
    } catch { /* best-effort */ }
    throw e
  }
}

/** Snapshots on disk, newest first - for the Tasks UI. */
function listSnapshots() {
  try {
    return fs.readdirSync(DATA_BACKUP_DIR)
      .filter((f) => f.startsWith('data-snapshot-'))
      .map((f) => {
        const st = fs.statSync(path.join(DATA_BACKUP_DIR, f))
        return { filename: f, sizeBytes: st.size, createdAt: new Date(st.mtimeMs).toISOString(), encrypted: f.endsWith('.enc') }
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  } catch {
    return []
  }
}

/** Resolves a snapshot filename to a path, refusing anything outside the dir. */
function resolveSnapshotPath(filename) {
  const base = path.basename(String(filename || ''))
  if (!base.startsWith('data-snapshot-')) return null
  const full = path.join(DATA_BACKUP_DIR, base)
  if (!full.startsWith(DATA_BACKUP_DIR)) return null
  return fs.existsSync(full) ? full : null
}

let timer = null

async function checkAndRun(prisma) {
  if (!getDbFilePath()) return
  const settings = getSettings()
  if (!settings.enabled) return
  const gap = Math.max(1, Number(settings.frequencyDays) || 1) * DAY_MS
  const due = !settings.lastOkAt || (Date.now() - new Date(settings.lastOkAt).getTime()) >= gap
  if (!due) return
  try { await runDataBackupOnce(prisma) } catch { /* already recorded + notified */ }
}

function scheduleDataBackups(prisma) {
  if (timer) { clearInterval(timer); timer = null }
  if (!getDbFilePath()) return // public mode - never schedule
  setTimeout(() => checkAndRun(prisma).catch(() => {}), BOOT_DELAY_MS)
  timer = setInterval(() => checkAndRun(prisma).catch(() => {}), CHECK_INTERVAL_MS)
}

function clearDataBackupSchedule() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = {
  DATA_BACKUP_DIR,
  getSettings,
  saveSettings,
  runDataBackupOnce,
  listSnapshots,
  resolveSnapshotPath,
  pruneSnapshots,
  scheduleDataBackups,
  clearDataBackupSchedule,
  getDbFilePath,
}
