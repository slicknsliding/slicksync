/**
 * SQLite runtime settings, applied once at boot.
 *
 * Out of the box SQLite runs the slowest-and-safest way: a rollback journal
 * (every write creates a journal file, syncs twice, deletes it), full
 * synchronous mode, and no busy timeout - a second writer gets an error
 * the instant it collides instead of waiting a moment. For a database that
 * is written to every minute by the activity monitor and read by every
 * page, the standard shape is:
 *
 * - WAL journal: readers never block on a writer, writers append instead
 *   of rewriting, and a commit is one sync instead of two. Persistent -
 *   stored in the file itself, so it survives restarts. The backup and
 *   restore paths already handle the -wal/-shm sidecar files.
 * - synchronous=NORMAL: with WAL this is durable against application
 *   crashes; only a power cut mid-checkpoint can lose the last transaction,
 *   which is the trade every server database makes.
 * - busy_timeout: wait up to five seconds for a lock rather than failing.
 * - A 32MB page cache and in-memory temp tables.
 *
 * The per-connection settings apply to the connection Prisma hands out here;
 * WAL applies to the file. Postgres instances skip all of this.
 */
async function applySqlitePragmas(prisma) {
  const url = String(process.env.DATABASE_URL || '')
  if (!url.startsWith('file:')) return null
  const applied = {}
  const run = async (statement, key) => {
    try {
      const rows = await prisma.$queryRawUnsafe(statement)
      applied[key] = Array.isArray(rows) && rows[0] ? Object.values(rows[0])[0] : 'ok'
    } catch (e) {
      applied[key] = `error: ${e?.message || e}`
    }
  }
  await run('PRAGMA journal_mode=WAL', 'journal_mode')
  await run('PRAGMA synchronous=NORMAL', 'synchronous')
  await run('PRAGMA busy_timeout=5000', 'busy_timeout')
  await run('PRAGMA cache_size=-32000', 'cache_size')
  await run('PRAGMA temp_store=MEMORY', 'temp_store')
  return applied
}

/**
 * Keeps SQLite's query planner statistics fresh. Without them it guesses at
 * which index to use, and guesses worse as tables grow - it had never been
 * run here. PRAGMA optimize only analyzes the tables that need it, and the
 * statistics live in the file, so every connection benefits. A few minutes
 * after boot (not on the startup path), then twice a day.
 */
function scheduleSqliteOptimize(prisma) {
  const url = String(process.env.DATABASE_URL || '')
  if (!url.startsWith('file:')) return null
  const optimize = (all) => prisma.$executeRawUnsafe(all ? 'PRAGMA optimize=0x10002' : 'PRAGMA optimize')
    .catch((e) => console.warn('[SQLite] optimize failed:', e?.message))
  setTimeout(() => { optimize(true); checkpoint() }, 3 * 60 * 1000).unref?.()
  const timer = setInterval(() => optimize(false), 12 * 60 * 60 * 1000)
  timer.unref?.()
  // The write-ahead log (sqlite.db-wal) is copied into the database as it
  // goes, but the file itself never shrinks: a busy hour leaves it at its
  // high-water mark for good (seen at 4 MB beside a 9 MB database minutes
  // after a restart). Once an hour, copy everything in and cut it back to
  // nothing. TRUNCATE waits briefly for readers and simply does less if one
  // is still going; nothing is lost either way.
  const walTimer = setInterval(checkpoint, 60 * 60 * 1000)
  walTimer.unref?.()
  return timer

  async function checkpoint() {
    try {
      await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (e) {
      console.warn('[SQLite] WAL checkpoint failed:', e?.message)
    }
  }
}

module.exports = { applySqlitePragmas, scheduleSqliteOptimize }
