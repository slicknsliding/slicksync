// Copies the SQLite database before a boot changes its schema.
//
// start.sh brings a household (SQLite) install's schema up to date with
// `prisma db push --accept-data-loss` - the only way db push applies SQLite
// changes that rebuild a table. That is fine for the additive changes nearly
// every release makes, but a change that drops a column or table takes its
// data with it, and nothing kept a copy. This runs first: when the schema is
// about to change it writes a consistent copy next to the database
// (sqlite.db.pre-schema-<time>), checks it opens cleanly, and keeps the three
// newest. When nothing is about to change it does nothing, so an ordinary
// restart costs no disk.
//
// It never stops the boot: any failure is logged loudly and start.sh carries
// on, the same rule as safe-db-push.js (start.sh runs under set -e).
//
//   node scripts/sqlite-schema-backup.js

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const KEEP = 3
const schemaPath = process.env.PRISMA_SCHEMA_PATH
const databaseUrl = process.env.DATABASE_URL || ''

function dbFileFromUrl(url) {
  if (!url.startsWith('file:')) return null
  const rest = url.slice('file:'.length).replace(/^\/\/(?=\/)/, '').split('?')[0]
  return path.resolve(rest)
}

// Prisma's own diff: exit code 2 means the database and the schema differ.
function schemaWillChange() {
  try {
    execSync(`bunx prisma migrate diff --from-url "${databaseUrl}" --to-schema-datamodel "${schemaPath}" --exit-code`, { stdio: 'ignore' })
    return false
  } catch (err) {
    if (err.status === 2) return true
    throw new Error(`could not compare the schema (exit ${err.status})`)
  }
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
}

async function main() {
  const dbFile = dbFileFromUrl(databaseUrl)
  if (!dbFile || !schemaPath) return
  if (!fs.existsSync(dbFile) || fs.statSync(dbFile).size === 0) return // first boot: nothing to keep
  if (!schemaWillChange()) return

  const dir = path.dirname(dbFile)
  const base = path.basename(dbFile)
  const out = path.join(dir, `${base}.pre-schema-${stamp()}`)
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
  } finally {
    await prisma.$disconnect()
  }
  const copy = new PrismaClient({ datasources: { db: { url: `file:${out}` } } })
  try {
    const [row] = await copy.$queryRawUnsafe('PRAGMA integrity_check')
    const result = row && Object.values(row)[0]
    if (result !== 'ok') throw new Error(`the copy failed its integrity check (${result})`)
  } finally {
    await copy.$disconnect()
  }
  console.log(`💾 Schema is about to change - database copied to ${out}`)

  const old = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.pre-schema-`))
    .sort()
    .reverse()
    .slice(KEEP)
  for (const f of old) {
    try { fs.unlinkSync(path.join(dir, f)) } catch {}
  }
}

module.exports = { dbFileFromUrl, stamp }

if (require.main === module) {
  main().catch((err) => {
    console.error(`⚠️ Could not copy the database before the schema change: ${err.message}. Continuing - take a backup by hand if this keeps happening.`)
  })
}
