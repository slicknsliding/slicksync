// Applies pending Postgres schema drift automatically when it's 100% additive
// (ADD COLUMN, CREATE INDEX, CREATE TABLE, ADD CONSTRAINT), and fails LOUDLY
// - never silently - when any part of the diff is destructive (DROP COLUMN,
// DROP TABLE, a narrowing ALTER COLUMN TYPE).
//
// Why this exists: `prisma db push` is all-or-nothing per invocation - if a
// single batch of schema changes mixes safe and destructive statements (e.g.
// one release adds a column AND drops an unrelated one, which is completely
// normal for a real batch of feature work), db push refuses the WHOLE batch,
// including the safe half, and start.sh's old fallback (`|| echo ... continue
// booting anyway`) let the container boot "healthy" on the STALE schema
// regardless. That's exactly what took slicksync.vip down on 2026-08-19: four
// tables' worth of purely-additive columns (needed by already-shipped code)
// never got applied because they were bundled in the same db-push run as two
// unrelated DROP COLUMNs, and the app crash-looped on every request touching
// those tables while Docker still reported the container as healthy.
//
// This script splits the diff and applies only the safe half automatically,
// then exits non-zero (loud, grep-able failure in `docker compose logs`) if
// anything destructive remains unapplied - rather than a silent partial/no-op
// that only surfaces once a real user hits a 404/500.
//
// Destructive changes still require a human: they may involve real data (see
// e.g. the blockedRatings -> keptRatings rename, which isn't a plain rename -
// inverse semantics - so it needs a real data migration, not a blind apply).
//
//   node scripts/safe-db-push.js

const { execSync } = require('child_process')
const { PrismaClient } = require('@prisma/client')

const schemaPath = process.env.PRISMA_SCHEMA_PATH || '/app/prisma/schema.postgres.prisma'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('❌ DATABASE_URL not set - cannot check schema drift')
  process.exit(1)
}

let diffScript
try {
  diffScript = execSync(
    `bunx prisma migrate diff --from-url "${databaseUrl}" --to-schema-datamodel "${schemaPath}" --script`,
    { encoding: 'utf8' }
  )
} catch (err) {
  console.error('❌ Failed to compute schema diff:', err.message)
  process.exit(1)
}

if (!diffScript || !diffScript.trim()) {
  console.log('✅ Database schema already up to date - nothing to apply.')
  process.exit(0)
}

// Destructive if it drops something or narrows a column's type. Anything
// else (ADD COLUMN, CREATE TABLE, CREATE INDEX, ADD CONSTRAINT, etc.) is
// treated as safe to auto-apply.
const DESTRUCTIVE_CLAUSE_PATTERN = /^DROP\s+(COLUMN|TABLE)\b|^ALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i

// Splits a clause list on top-level commas only - a naive split would break
// on the comma inside e.g. `DECIMAL(10,2)` or `TIMESTAMP(3)` defaults.
function splitTopLevel(str) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of str) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

// Prisma's generated migration scripts are one statement per `-- AlterTable`
// / `-- CreateIndex` block, terminated by `;`. Splitting on `;` followed by
// a newline is enough for these (always simple, single-purpose statements).
const rawStatements = diffScript
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean)

const safe = []
const unsafe = []

for (const raw of rawStatements) {
  // Strip leading `-- comment` lines to get the actual SQL.
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim()
  if (!sql) continue

  // A single ALTER TABLE can bundle multiple clauses (e.g. one DROP COLUMN
  // alongside several unrelated ADD COLUMNs on the same table) - Prisma
  // does this whenever a batch of feature work touches the same table more
  // than once. Splitting per-clause means the safe ADD COLUMNs still apply
  // automatically even when bundled with an unrelated drop, instead of the
  // whole statement being refused as a unit (the exact gap that let today's
  // incident happen even for columns that WERE syntactically "just an add").
  const alterMatch = sql.match(/^ALTER\s+TABLE\s+("(?:[^"]|"")+")\s+([\s\S]+)$/i)
  if (alterMatch) {
    const [, tableName, clauseList] = alterMatch
    const clauses = splitTopLevel(clauseList)
    const safeClauses = clauses.filter((c) => !DESTRUCTIVE_CLAUSE_PATTERN.test(c))
    const unsafeClauses = clauses.filter((c) => DESTRUCTIVE_CLAUSE_PATTERN.test(c))
    if (safeClauses.length > 0) {
      safe.push(`ALTER TABLE ${tableName} ${safeClauses.join(', ')};`)
    }
    if (unsafeClauses.length > 0) {
      unsafe.push(`ALTER TABLE ${tableName} ${unsafeClauses.join(', ')};`)
    }
    continue
  }

  // Any other statement type (CREATE TABLE, CREATE INDEX, DROP TABLE, ...)
  // is classified as a whole - these aren't bundled multi-clause the way
  // ALTER TABLE is.
  if (DESTRUCTIVE_CLAUSE_PATTERN.test(sql)) unsafe.push(sql.endsWith(';') ? sql : `${sql};`)
  else safe.push(sql.endsWith(';') ? sql : `${sql};`)
}

async function main() {
  const prisma = new PrismaClient()
  try {
    if (safe.length > 0) {
      console.log(`📐 Applying ${safe.length} safe (additive-only) schema statement(s) automatically...`)
      for (const stmt of safe) {
        await prisma.$executeRawUnsafe(stmt.endsWith(';') ? stmt : `${stmt};`)
        console.log('  ✓', stmt.split('\n')[0])
      }
    }
  } finally {
    await prisma.$disconnect()
  }

  if (unsafe.length > 0) {
    console.error('')
    console.error('🛑 Schema drift includes destructive changes that were NOT applied automatically:')
    for (const stmt of unsafe) {
      console.error('  -', stmt.replace(/\s+/g, ' '))
    }
    console.error('')
    console.error('These may involve real data - review and apply by hand (or update the Prisma schema')
    console.error('to match the live database instead), then re-run this script to confirm.')
    console.error('Any code path depending on the changes above may be broken until this is resolved.')
    process.exit(1)
  }

  console.log('✅ All pending schema changes were additive and applied automatically.')
}

main().catch((err) => {
  console.error('❌ Failed to apply safe schema changes:', err)
  process.exit(1)
})
