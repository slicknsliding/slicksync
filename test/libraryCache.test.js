const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libcache-'))
process.env.LIBRARIES_CACHE_DIR = dir
const { getCachedLibrary, setCachedLibrary, clearCache } = require('../server/utils/libraryCache')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const lib = (n) => [{ _id: 'tt1', name: n, state: { timeOffset: 5 } }]

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('no stale read after a write', async () => {
  setCachedLibrary('a', 'u1', lib('one'))
  await wait(100)
  assert.equal(getCachedLibrary('a', 'u1')[0].name, 'one')
  assert.equal(getCachedLibrary('a', 'u1')[0].name, 'one')
  setCachedLibrary('a', 'u1', lib('two'))
  await wait(100)
  assert.equal(getCachedLibrary('a', 'u1')[0].name, 'two')
})

test('no stale read after clearCache', async () => {
  setCachedLibrary('a', 'u2', lib('x'))
  await wait(100)
  assert.ok(getCachedLibrary('a', 'u2'))
  clearCache('a', 'u2')
  assert.equal(getCachedLibrary('a', 'u2'), null)
})

test('a caller editing its result does not change the next read', async () => {
  setCachedLibrary('a', 'u3', lib('keep'))
  await wait(100)
  const first = getCachedLibrary('a', 'u3')
  first[0].name = 'changed'
  first[0].state.timeOffset = 99
  first.push({ _id: 'extra' })
  const second = getCachedLibrary('a', 'u3')
  assert.equal(second.length, 1)
  assert.equal(second[0].name, 'keep')
  assert.equal(second[0].state.timeOffset, 5)
})

test('keeps only a few libraries in memory but still reads the rest', async () => {
  for (let i = 0; i < 7; i++) setCachedLibrary('b', `m${i}`, lib(`n${i}`))
  await wait(200)
  for (let i = 0; i < 7; i++) assert.equal(getCachedLibrary('b', `m${i}`)[0].name, `n${i}`)
})
