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

const DEFAULT_SETTINGS = {
  vacuumEnabled: false,
  lastVacuumAt: null,
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
  if (!getDbFilePath()) return null
  const start = Date.now()
  await prisma.$executeRawUnsafe('VACUUM')
  saveSettings({ lastVacuumAt: new Date().toISOString() })
  return { durationMs: Date.now() - start }
}

let timer = null

async function checkAndRun(prisma) {
  if (!getDbFilePath()) return
  const settings = getSettings()
  try {
    if (settings.vacuumEnabled) {
      const due = !settings.lastVacuumAt || (Date.now() - new Date(settings.lastVacuumAt).getTime()) >= VACUUM_MIN_GAP_MS
      if (due) {
        await runVacuum(prisma)
        console.log('[DbMaintenance] Scheduled VACUUM completed')
      }
    }
  } catch (e) {
    console.warn('[DbMaintenance] Scheduled run failed:', e?.message)
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
  getSettings, saveSettings, runVacuum,
  scheduleDbMaintenance, clearDbMaintenanceSchedule, getDbFilePath,
}
