const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// backup.js keeps its files under <cwd>/data/backup.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-acct-backups-'))
const cwd = process.cwd()
process.chdir(dir)
const backup = require('../server/utils/backup')
process.chdir(cwd)
const B = path.join(dir, 'data', 'backup')
fs.mkdirSync(B, { recursive: true })

function write(name, ageDays) {
  const full = path.join(B, name)
  fs.writeFileSync(full, '{}')
  fs.writeFileSync(full.replace(/\.json$/, '.validation.json'), '{}')
  const t = (Date.now() - ageDays * 86400000) / 1000
  fs.utimesSync(full, t, t)
}
const stamp = (d) => `2026-10-${String(d).padStart(2, '0')}T00-00-00`

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('each account keeps its own newest backups and nobody else loses any', () => {
  for (let d = 1; d <= 20; d++) write(`config-backup-acc-a-${stamp(d)}.json`, 20 - d)
  for (let d = 1; d <= 3; d++) write(`config-backup-acc-b-${stamp(d)}.json`, 3 - d)
  write(`config-backup-${stamp(1)}.json`, 30)
  backup.pruneAccountBackups('acc-a')
  const left = fs.readdirSync(B).filter((f) => !f.endsWith('.validation.json'))
  assert.equal(left.filter((f) => f.startsWith('config-backup-acc-a-')).length, 14)
  assert.ok(left.includes(`config-backup-acc-a-${stamp(20)}.json`), 'the newest is kept')
  assert.equal(left.filter((f) => f.startsWith('config-backup-acc-b-')).length, 3)
  assert.ok(left.includes(`config-backup-${stamp(1)}.json`))
  assert.equal(fs.readdirSync(B).filter((f) => f.endsWith('.validation.json')).length, left.length, 'sidecars go with their file')
})

test('deleting an account removes its backups only', () => {
  write(`config-backup-acc-ab-${stamp(5)}.json`, 1)
  assert.equal(backup.removeAccountBackups('acc-a'), 14)
  const left = fs.readdirSync(B)
  assert.equal(left.filter((f) => f.startsWith('config-backup-acc-a-2')).length, 0)
  assert.ok(left.includes(`config-backup-acc-ab-${stamp(5)}.json`), 'an id that starts the same is untouched')
  assert.equal(left.filter((f) => f.startsWith('config-backup-acc-b-')).length, 6, 'three files and their sidecars')
})
