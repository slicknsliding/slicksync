// SQLite maintenance: scheduled VACUUM, reclaiming disk space SQLite never
// auto-shrinks after deletes. dbSizeMonitor.js only ever observes the DB
// file's size - this is the actual remediation half of that story,
// private-mode/SQLite only (public mode is Postgres, managed by whoever
// hosts it, not this app).
//
// Deliberately VACUUM-only, no data pruning: an earlier version of this
// file also offered opt-in pruning of old EpisodeWatchHistory/
// MovieWatchHistory rows, but that conflicts with real features that read
// this same history unbounded or by a specific past date -
// recommendationEngine.js's "Because you watched X" vectors use the
// account's ENTIRE watch history with no date filter, and yearInReview.js
// queries a specific past calendar year - so pruning old rows would
// silently degrade recommendation quality over time and could make a past
// year's review come back incomplete. VACUUM alone never touches a row, so
// none of that applies to it.
//
// Settings live in a JSON file on the same mounted data volume as backups
// and vapid.json - same reasoning as vapid.json's own comment: there's no
// AppAccount for "the instance" itself to store a setting on (superadmin is
// a single shared password, not a tenant), so a small file avoids a schema
// migration for one instance-level flag no tenant ever reads.

const fs = require('fs')
const path = require('path')

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'db-maintenance-settings.json')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h - matches dbSizeMonitor/vaultMonitor's cadence
const VACUUM_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000 // weekly

const INTEGRITY_MIN_GAP_MS = 24 * 60 * 60 * 1000 // daily
const PRUNE_MIN_GAP_MS = 24 * 60 * 60 * 1000 // daily
// Retention for the two genuinely derived log tables. Verified before
// choosing these numbers: every read of AddonHealthHistory and
// AutomationRun in the codebase is recent-first with a `take` (50 / 100),
// so nothing can ask for a row older than this. That is exactly the
// property watch history does NOT have - see this file's header for why
// history is never pruned here.
const HEALTH_HISTORY_KEEP_PER_ADDON = 200
const AUTOMATION_RUN_KEEP = 500

const DEFAULT_SETTINGS = {
  vacuumEnabled: false,
  lastVacuumAt: null,
  // Read-only PRAGMA integrity_check. On by default because it cannot
  // change anything - it only reads pages and reports. Silent corruption
  // otherwise surfaces as a random broken feature months later.
  integrityCheckEnabled: true,
  lastIntegrityCheckAt: null,
  lastIntegrityOk: null,
  // Deletes rows, so opt-in and off by default, even though the two tables
  // it touches are provably read-bounded (see the constants above).
  pruneLogsEnabled: false,
  lastPruneAt: null,
  // Bell notifications otherwise accumulate forever. Only READ rows past
  // the age cutoff are ever deleted - an unread notification is a message
  // nobody has seen yet, and no cleanup job gets to decide it didn't matter.
  pruneNotificationsEnabled: false,
  pruneNotificationsDays: 30,
  lastNotificationsPruneAt: null,
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
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      return { ...DEFAULT_SETTINGS, ...parsed }
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
    console.warn('[DbMaintenance] Failed to persist settings:', e?.message)
  }
  return next
}

// Reclaims disk space SQLite leaves behind after deletes (it never
// auto-shrinks the file on its own) - purely a disk-space operation, no
// rows are touched. No-op (returns null) outside SQLite/private mode.
async function runVacuum(prisma) {
  const dbPath = getDbFilePath()
  if (!dbPath) return null

  // VACUUM rebuilds the database into a temporary copy and swaps it, so it
  // transiently needs roughly the size of the DB again in free space. On a
  // full disk that rebuild fails partway - refuse rather than find out the
  // hard way on someone's only copy. statfs is Node 18+; if it isn't
  // available the check is skipped rather than blocking maintenance.
  try {
    const { size } = fs.statSync(dbPath)
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(path.dirname(dbPath))
      const freeBytes = stats.bavail * stats.bsize
      // 2x the DB plus a small floor: the rebuild copy, plus room for the
      // journal and anything else writing during it.
      const needed = size * 2 + 64 * 1024 * 1024
      if (freeBytes < needed) {
        const mb = (n) => Math.round(n / 1048576)
        throw new Error(`Not enough free disk space to VACUUM safely (need ~${mb(needed)}MB, have ${mb(freeBytes)}MB)`)
      }
    }
  } catch (e) {
    // A genuine space shortfall must stop the vacuum; a failure to MEASURE
    // space must not.
    if (/free disk space/.test(e?.message || '')) throw e
  }

  const start = Date.now()
  await prisma.$executeRawUnsafe('VACUUM')
  saveSettings({ lastVacuumAt: new Date().toISOString() })
  return { durationMs: Date.now() - start }
}

// PRAGMA integrity_check - reads every page and verifies the file's
// internal structure. Returns 'ok' on a healthy database, otherwise one
// row per problem found. Purely read-only: it cannot repair or modify
// anything, which is why it is safe to leave on by default.
async function runIntegrityCheck(prisma) {
  if (!getDbFilePath()) return null
  const start = Date.now()
  const rows = await prisma.$queryRawUnsafe('PRAGMA integrity_check')
  // Shape is [{ integrity_check: 'ok' }] when healthy.
  const messages = (Array.isArray(rows) ? rows : [])
    .map((r) => String(Object.values(r || {})[0] ?? ''))
    .filter(Boolean)
  const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok'
  saveSettings({ lastIntegrityCheckAt: new Date().toISOString(), lastIntegrityOk: ok })
  return { ok, messages, durationMs: Date.now() - start }
}

// Caps the two derived log tables. Never touches watch history, vault,
// users, catalogs, or anything else a feature reads by date - see the
// constants' own comment for how that was verified.
async function pruneLogs(prisma) {
  if (!getDbFilePath()) return null
  const result = { healthHistoryDeleted: 0, automationRunsDeleted: 0 }

  // Per-addon, so a fleet with many addons doesn't lose one addon's whole
  // history just because another addon is chattier.
  const addons = await prisma.addon.findMany({ select: { id: true } })
  for (const addon of addons) {
    const cutoffRow = await prisma.addonHealthHistory.findMany({
      where: { addonId: addon.id },
      orderBy: { checkedAt: 'desc' },
      skip: HEALTH_HISTORY_KEEP_PER_ADDON,
      take: 1,
      select: { checkedAt: true },
    })
    if (cutoffRow.length === 0) continue
    const { count } = await prisma.addonHealthHistory.deleteMany({
      where: { addonId: addon.id, checkedAt: { lte: cutoffRow[0].checkedAt } },
    })
    result.healthHistoryDeleted += count
  }

  const runCutoff = await prisma.automationRun.findMany({
    orderBy: { createdAt: 'desc' },
    skip: AUTOMATION_RUN_KEEP,
    take: 1,
    select: { createdAt: true },
  })
  if (runCutoff.length > 0) {
    const { count } = await prisma.automationRun.deleteMany({
      where: { createdAt: { lte: runCutoff[0].createdAt } },
    })
    result.automationRunsDeleted = count
  }

  saveSettings({ lastPruneAt: new Date().toISOString() })
  return result
}

// Clears READ bell notifications older than the configured age. Unread rows
// are never touched regardless of age, and the deletion is by createdAt so
// "30 days" reads as "notifications from more than a month ago", not "read
// more than a month ago".
async function pruneNotifications(prisma) {
  if (!getDbFilePath()) return null
  const settings = getSettings()
  const days = Math.min(365, Math.max(1, Number(settings.pruneNotificationsDays) || 30))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const { count } = await prisma.notification.deleteMany({
    where: { read: true, createdAt: { lt: cutoff } },
  })
  saveSettings({ lastNotificationsPruneAt: new Date().toISOString() })
  return { notificationsDeleted: count, days }
}

let timer = null

// Each step is independently guarded: one failing (or being disabled) must
// never stop the others from running.
async function checkAndRun(prisma) {
  if (!getDbFilePath()) return
  const settings = getSettings()
  const isDue = (last, gap) => !last || (Date.now() - new Date(last).getTime()) >= gap

  if (settings.integrityCheckEnabled && isDue(settings.lastIntegrityCheckAt, INTEGRITY_MIN_GAP_MS)) {
    try {
      const result = await runIntegrityCheck(prisma)
      if (result && !result.ok) {
        console.error(`[DbMaintenance] INTEGRITY CHECK FAILED: ${result.messages.join('; ').slice(0, 500)}`)
        try {
          const { createNotification } = require('./notificationStore')
          await createNotification(prisma, 'default', {
            type: 'task',
            title: 'Database integrity check failed',
            body: `SQLite reported a problem with the database file: ${result.messages[0]}. Restore from a recent backup before this gets worse.`,
            url: '/tasks',
            dedupeKey: 'db-integrity-failed',
          })
        } catch { /* notification is best-effort */ }
      }
    } catch (e) {
      console.warn('[DbMaintenance] Integrity check failed to run:', e?.message)
    }
  }

  if (settings.pruneLogsEnabled && isDue(settings.lastPruneAt, PRUNE_MIN_GAP_MS)) {
    try {
      const pruned = await pruneLogs(prisma)
      if (pruned && (pruned.healthHistoryDeleted || pruned.automationRunsDeleted)) {
        console.log(`[DbMaintenance] Pruned ${pruned.healthHistoryDeleted} health-history and ${pruned.automationRunsDeleted} automation-run rows`)
      }
    } catch (e) {
      console.warn('[DbMaintenance] Log prune failed:', e?.message)
    }
  }

  if (settings.pruneNotificationsEnabled && isDue(settings.lastNotificationsPruneAt, PRUNE_MIN_GAP_MS)) {
    try {
      const pruned = await pruneNotifications(prisma)
      if (pruned?.notificationsDeleted) {
        console.log(`[DbMaintenance] Cleared ${pruned.notificationsDeleted} read notifications older than ${pruned.days} days`)
      }
    } catch (e) {
      console.warn('[DbMaintenance] Notification trim failed:', e?.message)
    }
  }

  // VACUUM last: it reclaims the space the prunes above just freed, so
  // running it after means one pass does the whole job.
  if (settings.vacuumEnabled && isDue(settings.lastVacuumAt, VACUUM_MIN_GAP_MS)) {
    try {
      await runVacuum(prisma)
      console.log('[DbMaintenance] Scheduled VACUUM completed')
    } catch (e) {
      console.warn('[DbMaintenance] Scheduled VACUUM failed:', e?.message)
    }
  }
}

function scheduleDbMaintenance(prisma) {
  if (timer) { clearInterval(timer); timer = null }
  if (!getDbFilePath()) return // public mode - never schedule
  // Staggered well past the other boot-time schedulers, same pattern as
  // catalogAutoRefresh's own 90s stagger.
  setTimeout(() => checkAndRun(prisma), 120 * 1000)
  timer = setInterval(() => checkAndRun(prisma), CHECK_INTERVAL_MS)
}

function clearDbMaintenanceSchedule() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = {
  getSettings, saveSettings, runVacuum, runIntegrityCheck, pruneLogs, pruneNotifications,
  scheduleDbMaintenance, clearDbMaintenanceSchedule, getDbFilePath,
}
