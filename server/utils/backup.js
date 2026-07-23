// Backup system functions
const fs = require('fs');
const path = require('path');
const { validateBackupData } = require('./backupValidation');

// Persist backups under data/backup so Docker mount ./data captures them
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup')
const BACKUP_CFG = path.join(BACKUP_DIR, 'schedule.json')
let backupTimer = null

const DAY_MS = 24 * 60 * 60 * 1000

// Sidecar filename for a backup's validation result, so the Tasks page can
// show it without re-parsing the (potentially large) backup itself.
function validationPathFor(backupFilename) {
  return backupFilename.replace(/\.json$/, '.validation.json')
}

/**
 * Whether this account wants backup-validation-failure alerts, and where
 * the Discord side should go - same AppAccount.sync shape as Vault/addon
 * health's notifyOnVault/notifyOnAddonHealth.
 */
async function getBackupNotifyTarget(prisma, accountId) {
  try {
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    return {
      enabled: cfg?.notifyOnBackup === true,
      webhookUrl: cfg?.webhookUrl || null,
    }
  } catch {
    return { enabled: false, webhookUrl: null }
  }
}

/**
 * Only ever fires when a backup FAILS validation - a good backup is
 * confirmed silently in the Tasks page's own badge (see validationPathFor),
 * not worth a push/Discord ping every single time one succeeds. Backups
 * only run in private mode (single default account), so no per-account
 * iteration is needed here.
 */
async function notifyBackupValidationFailed(prisma, filename, result) {
  try {
    const accountId = 'default'
    const title = `⚠️ Backup failed validation: ${filename}`
    const message = result.issues.slice(0, 5).join('; ') + (result.issues.length > 5 ? `; +${result.issues.length - 5} more` : '')

    const { notifyPushForType } = require('./pushNotifications')
    await notifyPushForType(prisma, accountId, 'notifyOnBackup', {
      title,
      body: message,
      icon: '/android-chrome-192x192.png',
      url: '/tasks',
    })

    const target = await getBackupNotifyTarget(prisma, accountId)
    if (target.enabled && target.webhookUrl) {
      const { postDiscord } = require('./notify')
      await postDiscord(target.webhookUrl, `**${title}**\n${message}`).catch(() => {})
    }
  } catch (e) {
    console.warn('[Backup] Failed to notify validation failure:', e?.message)
  }
}

/**
 * Calculate next midnight from a given timestamp
 */
function nextMidnight(fromTs = Date.now()) {
  const d = new Date(fromTs)
  d.setHours(24, 0, 0, 0) // next local midnight
  return d.getTime()
}

/**
 * Ensure backup directory exists
 */
function ensureBackupDir() {
  try { 
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }) 
  } catch {}
}

/**
 * Read backup frequency from config file
 */
function readBackupFrequencyDays() {
  try {
    const raw = fs.readFileSync(BACKUP_CFG, 'utf8')
    const cfg = JSON.parse(raw)
    const days = Number(cfg?.days || 0)
    return Number.isFinite(days) ? days : 0
  } catch {
    return 0
  }
}

/**
 * Write backup frequency to config file
 */
function writeBackupFrequencyDays(days) {
  ensureBackupDir()
  try { 
    fs.writeFileSync(BACKUP_CFG, JSON.stringify({ days }), 'utf8') 
  } catch {}
}

/**
 * Perform a single backup. `prisma` is optional (validation-failure
 * notifications are skipped without it, e.g. if ever called from a context
 * that doesn't have it) but the sidecar validation file is always written.
 */
async function performBackupOnce(prisma) {
  ensureBackupDir()
  const ts = new Date()
  const stamp = ts.toISOString().replace(/[:]/g, '-').split('.')[0]
  const filename = path.join(BACKUP_DIR, `config-backup-${stamp}.json`)

  try {
    // call export endpoints on this same server
    const baseUrl = `http://localhost:${process.env.PORT || 4000}`
    let data = null
    try {
      const rsp = await fetch(`${baseUrl}/api/public-auth/config-export`)
      if (rsp.ok) data = await rsp.json()
    } catch {}
    if (!data) {
      try {
        const rsp2 = await fetch(`${baseUrl}/api/public-auth/addon-export`)
        if (rsp2.ok) data = await rsp2.json()
      } catch {}
    }
    if (!data) throw new Error('No export data available')
    fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8')
    const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1'
    if (!QUIET) console.log(`📦 Backup written: ${filename}`)

    // Confirm the backup we just wrote would actually restore, rather than
    // finding out mid-emergency - see backupValidation.js's own comment.
    try {
      const result = validateBackupData(data)
      fs.writeFileSync(validationPathFor(filename), JSON.stringify(result, null, 2), 'utf8')
      if (!QUIET) {
        console.log(result.valid
          ? `✅ Backup validated: ${result.counts.users} users, ${result.counts.groups} groups, ${result.counts.addons} addons`
          : `⚠️ Backup FAILED validation (${result.issues.length} issue(s)): ${filename}`)
      }
      if (!result.valid && prisma) {
        await notifyBackupValidationFailed(prisma, path.basename(filename), result)
      }
    } catch (validationErr) {
      if (!QUIET) console.warn('Backup validation itself failed:', validationErr?.message || validationErr)
    }
  } catch (e) {
    const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1'
    if (!QUIET) console.warn('Backup failed:', e?.message || e)
  }
}

/**
 * Clear backup schedule
 */
function clearBackupSchedule() {
  if (backupTimer) { 
    clearTimeout(backupTimer); 
    backupTimer = null 
  }
}

/**
 * Schedule backups at specified interval
 * For day-based schedules, runs at midnight
 */
function scheduleBackups(days, prisma) {
  clearBackupSchedule()
  if (!days || days <= 0) return

  const scheduleNext = () => {
    const now = Date.now()

    let nextRun
    if (days === 1) {
      // Every day: next midnight
      nextRun = nextMidnight(now)
    } else {
      // Multi-day (7d, 15d, 30d): schedule at next midnight, then add (days - 1) more days
      // This ensures it runs at midnight every N days
      const nextMidnightTime = nextMidnight(now)
      nextRun = nextMidnightTime + (days - 1) * DAY_MS
    }

    const delay = Math.max(0, nextRun - now)

    // Schedule the backup
    backupTimer = setTimeout(async () => {
      await performBackupOnce(prisma)
      // Schedule the next run
      scheduleNext()
    }, delay)
  }

  // Start scheduling
  scheduleNext()
}

module.exports = {
  BACKUP_DIR,
  ensureBackupDir,
  readBackupFrequencyDays,
  writeBackupFrequencyDays,
  performBackupOnce,
  clearBackupSchedule,
  scheduleBackups
}
