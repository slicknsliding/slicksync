// Tracks the SQLite DB file's own size over time for the Tasks page's
// storage chart. Private-mode only - public mode runs Postgres, which has
// no single file to stat and a totally different capacity model (managed
// by whoever hosts the Postgres instance, not this app). Read-only
// reporting throughout: nothing here ever writes to or modifies the
// database itself, only observes its file size.

const fs = require('fs')

const SAMPLE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h - matches vaultMonitor's cadence
const SAMPLE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000 // ~13 months of history is plenty for a growth trend

let timer = null

// DATABASE_URL is "file:///app/data/sqlite.db" in private mode, a
// postgresql:// URL in public mode - only the former has a real file to stat.
function getDbFilePath() {
  const url = process.env.DATABASE_URL || ''
  if (!url.startsWith('file:')) return null
  // Strip the file: scheme (2 or 3 leading slashes depending on how it was written)
  const path = url.replace(/^file:\/\/\/?/, '/')
  return path.startsWith('/') ? path : `/${path}`
}

async function sampleDbSize(prisma, accountId) {
  const dbPath = getDbFilePath()
  if (!dbPath) return // public/Postgres mode - nothing to sample
  let stat
  try {
    stat = fs.statSync(dbPath)
  } catch {
    return // DB file not found at the expected path - skip silently, not fatal
  }
  try {
    await prisma.dbSizeSample.create({ data: { accountId, bytes: BigInt(stat.size) } })
    await prisma.dbSizeSample.deleteMany({
      where: { accountId, createdAt: { lt: new Date(Date.now() - SAMPLE_RETENTION_MS) } },
    })
  } catch (err) {
    console.warn('[DbSizeMonitor] Failed to record sample:', err.message)
  }
}

// Best-effort free-space check. fs.statfsSync is Node 18.15+/Bun-supported
// but not guaranteed available in every container filesystem (e.g. some
// overlay/bind-mount setups) - a failed read just means no projection is
// shown, never a wrong one.
function getFreeBytes(dbPath) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const stats = fs.statfsSync(dbPath)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

async function getDbSizeReport(prisma, accountId) {
  const dbPath = getDbFilePath()
  if (!dbPath) return { supported: false }

  const samples = await prisma.dbSizeSample.findMany({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
    select: { bytes: true, createdAt: true },
  })

  let currentBytes = null
  try {
    currentBytes = fs.statSync(dbPath).size
  } catch {}

  // Growth rate from the oldest and newest sample, only when they span at
  // least a day - anything shorter is noise, not a trend.
  let growthBytesPerDay = null
  if (samples.length >= 2) {
    const first = samples[0]
    const last = samples[samples.length - 1]
    const spanMs = last.createdAt.getTime() - first.createdAt.getTime()
    const spanDays = spanMs / (24 * 60 * 60 * 1000)
    if (spanDays >= 1) {
      growthBytesPerDay = (Number(last.bytes) - Number(first.bytes)) / spanDays
    }
  }

  let projectedDaysUntilFull = null
  if (growthBytesPerDay && growthBytesPerDay > 0 && currentBytes !== null) {
    const freeBytes = getFreeBytes(dbPath)
    if (freeBytes !== null) {
      projectedDaysUntilFull = Math.round(freeBytes / growthBytesPerDay)
    }
  }

  return {
    supported: true,
    currentBytes,
    growthBytesPerDay,
    projectedDaysUntilFull,
    samples: samples.map((s) => ({ bytes: Number(s.bytes), createdAt: s.createdAt.toISOString() })),
  }
}

function scheduleDbSizeMonitor(prisma, accountId) {
  if (timer) { clearInterval(timer); timer = null }
  if (!getDbFilePath()) return // public mode - never schedule
  sampleDbSize(prisma, accountId).catch(() => {})
  timer = setInterval(() => {
    sampleDbSize(prisma, accountId).catch(() => {})
  }, SAMPLE_INTERVAL_MS)
}

function clearDbSizeMonitor() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { scheduleDbSizeMonitor, clearDbSizeMonitor, getDbSizeReport, getDbFilePath }
