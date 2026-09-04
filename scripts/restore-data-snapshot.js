#!/usr/bin/env node
// Restores a full-data snapshot produced by server/utils/dataBackup.js.
//
// Run this with the SlickSync container STOPPED. Replacing a database file
// that a running process is holding open is how you get a half-restored
// instance: open connections keep writing to the old file's pages, and the
// WAL/journal alongside it no longer matches what you just dropped in.
//
// Usage:
//   node scripts/restore-data-snapshot.js <snapshot-file> [--out <sqlite.db>] [--passphrase <pass>]
//
// Examples:
//   node scripts/restore-data-snapshot.js data-snapshot-2026-09-04T06-00-00.db.gz.enc \
//     --out /opt/docker/data/slicksync/sqlite.db --passphrase 'my off-site passphrase'
//
// The passphrase is the one set in Tasks -> Maintenance -> Off-site backups.
// A .gz snapshot (no passphrase configured when it was written) needs none.
//
// Safety: the existing database is never deleted - it is renamed aside to
// <target>.pre-restore-<timestamp> so a restore can itself be undone.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const MAGIC = Buffer.from('SLICKSYNCDATA001', 'utf8')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16

function parseArgs(argv) {
  const args = { file: null, out: null, passphrase: null }
  const rest = []
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--passphrase') args.passphrase = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else rest.push(argv[i])
  }
  args.file = rest[0] || null
  return args
}

function decrypt(buf, passphrase) {
  if (!passphrase) {
    throw new Error('This snapshot is encrypted - pass --passphrase "<your off-site passphrase>"')
  }
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN)
  const iv = buf.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN)
  const tag = buf.subarray(MAGIC.length + SALT_LEN + IV_LEN, MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN)
  const ct = buf.subarray(MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN)
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 14, r: 8, p: 1 })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new Error('Wrong passphrase for this snapshot (or the file is damaged)')
  }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.file) {
    console.log('Usage: node scripts/restore-data-snapshot.js <snapshot-file> [--out <sqlite.db>] [--passphrase <pass>]')
    process.exit(args.file ? 0 : 1)
  }

  const src = path.resolve(args.file)
  if (!fs.existsSync(src)) {
    console.error(`Snapshot not found: ${src}`)
    process.exit(1)
  }

  const target = path.resolve(
    args.out || (process.env.DATABASE_URL || '').replace(/^file:\/\/\/?/, '/') || './data/sqlite.db'
  )

  let buf = fs.readFileSync(src)
  if (buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.log('Encrypted snapshot - decrypting...')
    buf = decrypt(buf, args.passphrase)
  }
  console.log('Decompressing...')
  const db = zlib.gunzipSync(buf)

  // A SQLite file always starts with this header; catching it here beats
  // discovering the restore was garbage when the app won't boot.
  if (!db.subarray(0, 15).toString('utf8').startsWith('SQLite format 3')) {
    console.error('Restored bytes are not a SQLite database - aborting without touching the target')
    process.exit(1)
  }

  if (fs.existsSync(target)) {
    const aside = `${target}.pre-restore-${new Date().toISOString().replace(/[:]/g, '-').split('.')[0]}`
    fs.renameSync(target, aside)
    console.log(`Existing database moved aside: ${aside}`)
  }
  // Stale WAL/SHM from the old database would be applied on top of the new
  // file and corrupt it - they belong to the database we just moved aside.
  for (const suffix of ['-wal', '-shm']) {
    try { fs.existsSync(target + suffix) && fs.unlinkSync(target + suffix) } catch {}
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, db)
  console.log(`Restored ${Math.round(db.length / 1024)}KB to ${target}`)
  console.log('Start the container again - and check Activity to confirm the history is back.')
}

main()
