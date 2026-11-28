const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libcache-'))
process.env.LIBRARIES_CACHE_DIR = dir
const { getCachedLibrary, setCachedLibrary, clearCache, clearAllCaches, _test } = require('../server/utils/libraryCache')

// Files are written in the background. Nothing here sleeps and hopes the
// write has landed: a read has to be right straight away, and where a test
// needs the file itself it waits for the write to finish.
const saved = _test.whenSaved
const lib = (n) => [{ _id: 'tt1', name: n, state: { timeOffset: 5 } }]
const read = (account, user) => {
  const library = getCachedLibrary(account, user)
  return library ? library[0].name : null
}
const onDisk = (account, user) => {
  const file = path.join(dir, `account-${account}`, `user-${user}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

// Holds one of fs.promises' calls back until release(), the way a busy disk
// does; reached resolves when the module gets to that call.
function hold(method) {
  const real = fs.promises[method]
  let release
  let arrived
  const held = new Promise((resolve) => { release = resolve })
  const reached = new Promise((resolve) => { arrived = resolve })
  fs.promises[method] = async (...args) => {
    arrived()
    await held
    return real(...args)
  }
  return { reached, release: () => { fs.promises[method] = real; release() } }
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('no stale read after a write', async () => {
  setCachedLibrary('a', 'u1', lib('one'))
  assert.equal(read('a', 'u1'), 'one', 'before the file is written')
  await saved()
  assert.equal(onDisk('a', 'u1')[0].name, 'one')
  assert.equal(read('a', 'u1'), 'one')
  assert.equal(read('a', 'u1'), 'one')
  setCachedLibrary('a', 'u1', lib('two'))
  assert.equal(read('a', 'u1'), 'two', 'before the file is replaced')
  await saved()
  assert.equal(onDisk('a', 'u1')[0].name, 'two')
  assert.equal(read('a', 'u1'), 'two')
})

test('no stale read while the disk is slow to take a write', async () => {
  setCachedLibrary('a', 'slow', lib('one'))
  await saved()
  assert.equal(read('a', 'slow'), 'one')
  const disk = hold('writeFile')
  try {
    setCachedLibrary('a', 'slow', lib('two'))
    await disk.reached
    assert.equal(onDisk('a', 'slow')[0].name, 'one', 'the file is still the old one')
    assert.equal(read('a', 'slow'), 'two')
    assert.equal(read('a', 'slow'), 'two')
  } finally {
    disk.release()
  }
  await saved()
  assert.equal(onDisk('a', 'slow')[0].name, 'two')
  assert.equal(read('a', 'slow'), 'two')
})

test('an older, bigger write cannot land on top of a newer one', async () => {
  const big = Array.from({ length: 60000 }, (_, i) => ({ _id: `tt${i}`, name: 'old', state: { timeOffset: i } }))
  setCachedLibrary('a', 'order', big)
  setCachedLibrary('a', 'order', lib('new'))
  assert.equal(read('a', 'order'), 'new')
  await saved()
  assert.deepEqual(onDisk('a', 'order'), lib('new'))
  assert.equal(read('a', 'order'), 'new')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'account-a')).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind')
})

test('no stale read after clearCache', async () => {
  setCachedLibrary('a', 'u2', lib('x'))
  await saved()
  assert.equal(read('a', 'u2'), 'x')
  clearCache('a', 'u2')
  assert.equal(getCachedLibrary('a', 'u2'), null)
  assert.equal(onDisk('a', 'u2'), null)
})

test('a library cleared before its file is written stays cleared', async () => {
  setCachedLibrary('a', 'u4', lib('x'))
  clearCache('a', 'u4')
  assert.equal(getCachedLibrary('a', 'u4'), null)
  await saved()
  assert.equal(getCachedLibrary('a', 'u4'), null)
  assert.equal(onDisk('a', 'u4'), null)

  // The same library handed over again after the clear is written again.
  setCachedLibrary('a', 'u4', lib('x'))
  assert.equal(read('a', 'u4'), 'x')
  await saved()
  assert.equal(onDisk('a', 'u4')[0].name, 'x')
})

test('a library cleared just as its file lands stays cleared', async () => {
  const disk = hold('rename')
  try {
    setCachedLibrary('a', 'u5', lib('x'))
    await disk.reached
    clearCache('a', 'u5')
  } finally {
    disk.release()
  }
  assert.equal(getCachedLibrary('a', 'u5'), null)
  await saved()
  assert.equal(getCachedLibrary('a', 'u5'), null)
  assert.equal(onDisk('a', 'u5'), null)
})

test('a write straight after a clear is the one that is kept', async () => {
  setCachedLibrary('a', 'u6', lib('before'))
  clearCache('a', 'u6')
  setCachedLibrary('a', 'u6', lib('after'))
  assert.equal(read('a', 'u6'), 'after')
  await saved()
  assert.equal(onDisk('a', 'u6')[0].name, 'after')
  assert.equal(read('a', 'u6'), 'after')
})

test('clearing an account stops its writes under way and leaves other accounts alone', async () => {
  setCachedLibrary('c', 'k1', lib('x'))
  setCachedLibrary('cc', 'k1', lib('y'))
  clearAllCaches('c')
  assert.equal(getCachedLibrary('c', 'k1'), null)
  assert.equal(read('cc', 'k1'), 'y')
  await saved()
  assert.equal(getCachedLibrary('c', 'k1'), null)
  assert.equal(onDisk('c', 'k1'), null)
  assert.equal(onDisk('cc', 'k1')[0].name, 'y')
  assert.equal(read('cc', 'k1'), 'y')
})

test('a caller editing its result does not change the next read', async () => {
  setCachedLibrary('a', 'u3', lib('keep'))
  for (const when of ['before the file is written', 'once the file is written']) {
    const first = getCachedLibrary('a', 'u3')
    first[0].name = 'changed'
    first[0].state.timeOffset = 99
    first.push({ _id: 'extra' })
    const second = getCachedLibrary('a', 'u3')
    assert.equal(second.length, 1, when)
    assert.equal(second[0].name, 'keep', when)
    assert.equal(second[0].state.timeOffset, 5, when)
    await saved()
  }
})

test('a caller editing the library it handed over does not change what is read', async () => {
  const mine = lib('keep')
  setCachedLibrary('a', 'u7', mine)
  mine[0].name = 'changed'
  mine[0].state.timeOffset = 99
  mine.push({ _id: 'extra' })
  assert.deepEqual(getCachedLibrary('a', 'u7'), lib('keep'))
  await saved()
  assert.deepEqual(onDisk('a', 'u7'), lib('keep'))
  assert.deepEqual(getCachedLibrary('a', 'u7'), lib('keep'))
})

test('keeps only a few libraries in memory but still reads the rest', async () => {
  for (let i = 0; i < 7; i++) setCachedLibrary('b', `m${i}`, lib(`n${i}`))
  for (let i = 0; i < 7; i++) assert.equal(read('b', `m${i}`), `n${i}`, 'before the files are written')
  await saved()
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 7; i++) assert.equal(read('b', `m${i}`), `n${i}`)
  }
})
