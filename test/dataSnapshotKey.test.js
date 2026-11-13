const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { encryptBuffer, withInstallKeys } = require('../server/utils/dataBackup')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'restore-data-snapshot.js')
const fakeDb = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('example rows')])
const KEY = Buffer.alloc(32, 7).toString('base64')
const OLD = Buffer.alloc(32, 9).toString('base64')

function restore(dir, file, env = {}) {
  const e = { ...process.env, ...env }
  delete e.ENCRYPTION_KEY
  if (env.ENCRYPTION_KEY) e.ENCRYPTION_KEY = env.ENCRYPTION_KEY
  return execFileSync(process.execPath, [SCRIPT, file, '--out', path.join(dir, 'sqlite.db'), '--passphrase', 'example-passphrase'], { env: e, encoding: 'utf8' })
}

test('an encrypted snapshot brings the encryption key back with the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
  const file = path.join(dir, 'snap.db.gz.enc')
  fs.writeFileSync(file, encryptBuffer('example-passphrase', withInstallKeys(zlib.gzipSync(fakeDb), [KEY, OLD])))
  const out = restore(dir, file)
  assert.ok(fs.readFileSync(path.join(dir, 'sqlite.db')).equals(fakeDb))
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server_secret.key'), 'utf8'), KEY)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server_secret.key.older-1'), 'utf8'), OLD)
  assert.match(out, /Encryption key restored/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a different key already in place is kept, the snapshot key goes beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
  fs.writeFileSync(path.join(dir, 'server_secret.key'), OLD)
  const file = path.join(dir, 'snap.db.gz.enc')
  fs.writeFileSync(file, encryptBuffer('example-passphrase', withInstallKeys(zlib.gzipSync(fakeDb), [KEY])))
  restore(dir, file)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server_secret.key'), 'utf8'), OLD)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server_secret.key.from-snapshot'), 'utf8'), KEY)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('older snapshots (format 001, no key inside) still restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
  const v2 = encryptBuffer('example-passphrase', zlib.gzipSync(fakeDb))
  const v1 = Buffer.concat([Buffer.from('SLICKSYNCDATA001'), v2.subarray(16)])
  const file = path.join(dir, 'old.db.gz.enc')
  fs.writeFileSync(file, v1)
  restore(dir, file)
  assert.ok(fs.readFileSync(path.join(dir, 'sqlite.db')).equals(fakeDb))
  assert.ok(!fs.existsSync(path.join(dir, 'server_secret.key')))
  fs.rmSync(dir, { recursive: true, force: true })
})
