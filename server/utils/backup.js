// Backup system functions
const fs = require('fs');
const path = require('path');
const { validateBackupData } = require('./backupValidation');

// Persist backups under data/backup so Docker mount ./data captures them
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backup')
const BACKUP_CFG = path.join(BACKUP_DIR, 'schedule.json')
let backupTimer = null

const DAY_MS = 24 * 60 * 60 * 1000
// setTimeout holds at most 2^31-1 ms (about 24.8 days) and fires at once for
// anything longer, which made "Every month" back up in a tight loop. Long waits
// are slept in pieces of this size instead, like syncScheduler.js.
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000
// Bumped by every (re)schedule, so a run in progress can't start a second chain.
let scheduleGeneration = 0

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
  const message = result.issues.slice(0, 5).join('; ') + (result.issues.length > 5 ? `; +${result.issues.length - 5} more` : '')
  await notifyBackupProblem(prisma, `⚠️ Backup failed validation: ${filename}`, message)
}

async function notifyBackupProblem(prisma, title, message) {
  try {
    const accountId = 'default'

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
    fs.writeFileSync(BACKUP_CFG, JSON.stringify({ ...readBackupCfg(), days }), 'utf8') 
  } catch {}
}

function readBackupCfg() {
  try { return JSON.parse(fs.readFileSync(BACKUP_CFG, 'utf8')) || {} } catch { return {} }
}

// When a scheduled backup last worked, kept beside the frequency: counted from
// boot, a weekly backup never ran on an instance restarted more often than that.
function readLastScheduledRun() {
  const at = Date.parse(readBackupCfg().lastRunAt || '')
  return Number.isFinite(at) ? at : null
}

function writeLastScheduledRun(at) {
  ensureBackupDir()
  try {
    fs.writeFileSync(BACKUP_CFG, JSON.stringify({ ...readBackupCfg(), lastRunAt: new Date(at).toISOString() }), 'utf8')
  } catch {}
}

/**
 * The midnight the next scheduled backup is due: `days` after the day of the
 * last one that worked. Overdue, or never run, means the coming midnight.
 */
function nextBackupAt(days, lastRunAt, now = Date.now()) {
  const soonest = nextMidnight(now)
  if (days <= 1 || !lastRunAt) return soonest
  const due = new Date(lastRunAt)
  due.setHours(0, 0, 0, 0)
  due.setDate(due.getDate() + days)
  return Math.max(due.getTime(), soonest)
}

// Write one export payload to disk + its validation sidecar, notifying on
// validation failure. Shared by both the single-account (private) and
// per-account (public) paths below so the write/validate/notify logic lives
// in exactly one place. `labelSuffix` distinguishes per-account files in
// public mode (e.g. "-<accountId>"); empty for private mode's single file.
async function writeBackupFile(prisma, data, labelSuffix = '') {
  const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1'
  const stamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0]
  const filename = path.join(BACKUP_DIR, `config-backup${labelSuffix}-${stamp}.json`)
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  if (!QUIET) console.log(`📦 Backup written: ${filename}`)
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

  // Off-site copy + local retention. Deliberately AFTER the local write and
  // its validation, and deliberately non-throwing (see backupTargets.js's
  // failure policy): a bucket misconfiguration must never turn a
  // successfully-written local backup into a failed backup run.
  try {
    const { uploadBackup, pruneLocalBackups } = require('./backupTargets')
    const uploaded = await uploadBackup(filename, prisma)
    if (uploaded?.ok === false && prisma) {
      await notifyBackupProblem(prisma, `⚠️ Off-site backup failed: ${path.basename(filename)}`, 'The copy on this server is fine. Check the remote settings under Tasks.')
    }
    // One account's backups on an instance serving many: keep only that
    // account's newest, never trimming anyone else's.
    if (labelSuffix) pruneAccountBackups(labelSuffix.replace(/^-/, ''))
    else pruneLocalBackups(BACKUP_DIR)
  } catch (targetErr) {
    if (!QUIET) console.warn('Backup target step failed:', targetErr?.message || targetErr)
  }
}

/**
 * Perform a single backup. `prisma` is optional (validation-failure
 * notifications are skipped without it) but the sidecar validation file is
 * always written.
 *
 * `opts` (optional, backward-compatible - all existing callers pass nothing):
 *   - INSTANCE_TYPE: when 'public', backs up EVERY account, one file each,
 *     instead of a single global backup. This is the multi-tenant fix:
 *     scheduled backups previously only worked for the single private-mode
 *     account because they self-called the export route with no auth context
 *     and no way to name a tenant (confirmed in the old code - a bare
 *     fetch('/config-export') that only succeeded because private mode
 *     ignores account scoping entirely).
 *   - buildConfigExportPayload: the direct payload builder extracted from
 *     publicAuth.js's /config-export route, called per-account with a
 *     synthetic { appAccountId } - no HTTP hop, no auth token needed.
 * Note: in public mode, a per-account secret encrypted under that account's
 * in-memory DEK can only be decrypted while that DEK is cached (i.e. after a
 * recent login). An unattended backup for an account nobody's logged into
 * recently still succeeds structurally - the export builder already nulls a
 * field it can't decrypt rather than failing - it just won't contain those
 * particular secrets. That's an honest, documented limitation of per-account
 * encryption, not a bug in this path.
 */
async function performBackupOnce(prisma, opts = {}) {
  ensureBackupDir()
  const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1'
  const { INSTANCE_TYPE, buildConfigExportPayload } = opts

  try {
    // Public multi-tenant mode: one backup file per account.
    if (INSTANCE_TYPE === 'public' && typeof buildConfigExportPayload === 'function' && prisma) {
      const accounts = await prisma.appAccount.findMany({ select: { id: true } })
      let ok = 0
      for (const account of accounts) {
        try {
          const data = await buildConfigExportPayload({ appAccountId: account.id })
          if (data) { await writeBackupFile(prisma, data, `-${account.id}`); ok++ }
        } catch (perAcctErr) {
          if (!QUIET) console.warn(`Backup failed for account ${account.id}:`, perAcctErr?.message || perAcctErr)
        }
      }
      if (!QUIET) console.log(`📦 Public-mode backup: ${ok}/${accounts.length} accounts backed up`)
      return ok > 0 || accounts.length === 0
    }

    // Private mode (or no builder provided): single global backup. Prefer the
    // direct builder when available (no HTTP hop), fall back to the legacy
    // self-fetch for full backward compatibility.
    let data = null
    if (typeof buildConfigExportPayload === 'function') {
      try { data = await buildConfigExportPayload({ appAccountId: process.env.DEFAULT_ACCOUNT_ID || 'default' }) } catch {}
    }
    if (!data) {
      const baseUrl = `http://localhost:${process.env.PORT || 4000}`
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
    }
    if (!data) throw new Error('No export data available')
    await writeBackupFile(prisma, data, '')
    return true
  } catch (e) {
    if (!QUIET) console.warn('Backup failed:', e?.message || e)
    if (prisma && INSTANCE_TYPE !== 'public') {
      await notifyBackupProblem(prisma, '⚠️ Backup failed', 'No new backup was written. See the server logs.')
    }
    return false
  }
}

/**
 * A local copy taken just before something replaces the account's data. It
 * shows in the Tasks list like any other backup, but isn't sent off-site or
 * counted as a scheduled run.
 */
function writeSafetyCopy(data, labelSuffix = '') {
  ensureBackupDir()
  const stamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0]
  const filename = path.join(BACKUP_DIR, `config-backup${labelSuffix}-${stamp}.json`)
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.writeFileSync(validationPathFor(filename), JSON.stringify(validateBackupData(data), null, 2), 'utf8')
  return path.basename(filename)
}

// Backups of one account on a public instance, newest first. Their names are
// config-backup-<accountId>-<YYYY-MM-DDTHH-MM-SS>.json (plus a sidecar).
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function accountBackupFiles(accountId) {
  if (!accountId) return []
  const own = new RegExp(`^config-backup-${escapeRe(accountId)}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+\\.json$`)
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => own.test(f))
      .map((f) => ({ full: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}
function removeBackupFile(full) {
  try { fs.unlinkSync(full) } catch { /* already gone */ }
  try { fs.unlinkSync(validationPathFor(full)) } catch { /* no sidecar */ }
}
// These copies hold the account's sign-ins in readable form, so they are
// kept to a bounded number: the operator's "keep" setting, or 14.
const ACCOUNT_BACKUPS_KEPT = 14
function pruneAccountBackups(accountId) {
  let keep = ACCOUNT_BACKUPS_KEPT
  try { keep = require('./backupTargets').getSettings().keepLocal || ACCOUNT_BACKUPS_KEPT } catch { /* default */ }
  const files = accountBackupFiles(accountId)
  for (const file of files.slice(keep)) removeBackupFile(file.full)
  return Math.max(0, files.length - keep)
}
/** Every backup of an account that is being deleted. */
function removeAccountBackups(accountId) {
  const files = accountBackupFiles(accountId)
  for (const file of files) removeBackupFile(file.full)
  return files.length
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
function scheduleBackups(days, prisma, opts = {}) {
  clearBackupSchedule()
  if (!days || days <= 0) return
  const generation = ++scheduleGeneration

  const scheduleNext = () => {
    const nextRun = nextBackupAt(days, readLastScheduledRun())

    const wait = async () => {
      const remaining = nextRun - Date.now()
      if (remaining > 0) {
        backupTimer = setTimeout(wait, Math.min(MAX_SLEEP_MS, remaining))
        return
      }
      const worked = await performBackupOnce(prisma, opts) // opts carries INSTANCE_TYPE + the per-account payload builder in public mode
      // One that failed stays due, so the coming midnight tries again.
      if (worked) writeLastScheduledRun(Date.now())
      if (generation === scheduleGeneration) scheduleNext()
    }
    wait()
  }

  // Start scheduling
  scheduleNext()
}

module.exports = {
  nextBackupAt,
  writeSafetyCopy,
  BACKUP_DIR,
  pruneAccountBackups,
  removeAccountBackups,
  ensureBackupDir,
  readBackupFrequencyDays,
  writeBackupFrequencyDays,
  performBackupOnce,
  clearBackupSchedule,
  scheduleBackups
}
