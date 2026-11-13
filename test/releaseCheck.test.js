const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { checkRelease } = require('../scripts/release-check')

function tree(pkgVersion, topVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'))
  fs.mkdirSync(path.join(dir, 'client', 'public'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: pkgVersion }))
  fs.writeFileSync(path.join(dir, 'client', 'public', 'changelog.json'), JSON.stringify(topVersion ? [{ version: topVersion }] : []))
  return dir
}

test('a matching release passes, a mismatch names what disagrees', () => {
  const ok = tree('1.2.3', '1.2.3')
  assert.deepStrictEqual(checkRelease('v1.2.3', ok), { skipped: false, problems: [] })
  const bad = tree('1.2.2', '1.2.1')
  const { problems } = checkRelease('v1.2.3', bad)
  assert.strictEqual(problems.length, 2)
  assert.match(problems[0], /package.json says 1.2.2/)
  assert.match(problems[1], /changelog.json entry is 1.2.1/)
  for (const d of [ok, bad]) fs.rmSync(d, { recursive: true, force: true })
})

test('beta tags are not checked', () => {
  assert.strictEqual(checkRelease('beta-v1.104.1').skipped, true)
})

