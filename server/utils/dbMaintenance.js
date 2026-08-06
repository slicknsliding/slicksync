// SQLite maintenance: scheduled VACUUM (reclaims space SQLite never
// auto-shrinks after deletes) and an entirely separate, explicit opt-in for
// pruning old watch-history rows past a retention window. dbSizeMonitor.js
// only ever observes the DB file's size - this is the actual remediation
// half of that story, private-mode/SQLite only (public mode is Postgres,
// managed by whoever hosts it, not this app).
//
// Settings live in a JSON file on the same mounted data volume as backups
// and vapid.json - same reasoning as vapid.json's own comment: there's no
// AppAccount for "the instance" itself to store a setting on (superadmin is
// a single shared password, not a tenant), so a small file avoids a schema
// migration for a handful of instance-level flags no tenant ever reads.

const fs = require('fs')
const path = require('path')

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'db-maintenance-settings.json')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h - matches dbSizeMonitor/vaultMonitor's cadence
const VACUUM_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000 // weekly
const PRUNE_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000 // weekly

const DEFAULT_SETTINGS = {
  vacuumEnabled: false,
  pruneEnabled: false,
  pruneRetentionDays: 365,
  lastVacuumAt: null,
  lastPruneAt: null,
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

// Only EpisodeWatchHistory/MovieWatchHistory - real, append-only watch-
// history logs (one row per viewing, watchedAt-stamped), the actual bulk
// contributor to long-run DB growth. Deliberately excludes WatchSession:
// despite its name it's current/resumable STATE (one row per (user, item),
// updated in place, unique-constrained - see its own schema comment),
// not a growing history log, so age-based pruning there would delete a
// still-relevant paused item's resume position, not stale history.
async function countPrunableRows(prisma, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.count({ where: { watchedAt: { lt: cutoff } } }),
    prisma.movieWatchHistory.count({ where: { watchedAt: { lt: cutoff } } }),
  ])
  return { episodes, movies, total: episodes + movies, cutoff: cutoff.toISOString() }
}

async function runPrune(prisma, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const [episodes, movies] = await Promise.all([
    prisma.episodeWatchHistory.deleteMany({ where: { watchedAt: { lt: cutoff } } }),
    prisma.movieWatchHistory.deleteMany({ where: { watchedAt: { lt: cutoff } } }),
  ])
  saveSettings({ lastPruneAt: new Date().toISOString() })
  return { episodesDeleted: episodes.count, moviesDeleted: movies.count, cutoff: cutoff.toISOString() }
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
    if (settings.pruneEnabled) {
      const due = !settings.lastPruneAt || (Date.now() - new Date(settings.lastPruneAt).getTime()) >= PRUNE_MIN_GAP_MS
      if (due) {
        const result = await runPrune(prisma, settings.pruneRetentionDays || DEFAULT_SETTINGS.pruneRetentionDays)
        console.log(`[DbMaintenance] Scheduled prune: ${result.episodesDeleted} episode + ${result.moviesDeleted} movie history rows past ${settings.pruneRetentionDays}d`)
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
  getSettings, saveSettings, runVacuum, countPrunableRows, runPrune,
  scheduleDbMaintenance, clearDbMaintenanceSchedule, getDbFilePath,
}
