const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { backupFileContents, readBackupFile, writeAtomic } = require('../server/utils/vaultBackup')

const bundle = { exportedAt: '2026-11-12T00:00:00.000Z', entries: [{ name: 'TorBox', secret: 'tb_example_secret_value' }] }

test('backups are encrypted unless plain text is chosen', async () => {
  const enc = await backupFileContents(bundle, { plaintext: false, passphrase: 'example-passphrase' })
  const text = JSON.stringify(enc)
  assert.strictEqual(enc.encrypted, true)
  assert.strictEqual(enc.count, 1)
  assert.ok(!text.includes('tb_example_secret_value'), 'secret must not appear in the file')
  assert.deepStrictEqual(await readBackupFile(text, 'example-passphrase'), bundle)
  await assert.rejects(readBackupFile(text, 'wrong-passphrase'))

  const plain = await backupFileContents(bundle, { plaintext: true })
  assert.deepStrictEqual(plain, bundle)
  assert.deepStrictEqual(await readBackupFile(JSON.stringify(plain), null), bundle)
})

test('writeAtomic replaces the file whole and leaves no temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'))
  const target = path.join(dir, 'latest.json')
  fs.writeFileSync(target, 'old')
  writeAtomic(target, 'new contents')
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new contents')
  assert.deepStrictEqual(fs.readdirSync(dir), ['latest.json'])
  fs.rmSync(dir, { recursive: true, force: true })
})
