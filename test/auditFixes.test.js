const test = require('node:test')
const assert = require('node:assert/strict')

const { nextBackupAt, scheduleBackups, clearBackupSchedule } = require('../server/utils/backup')
const { decodableSize, sourceDimensions } = require('../server/utils/imageEncoder')
const { bigintAsText } = require('../server/utils/userMerge')

const DAY = 24 * 60 * 60 * 1000
const midnightOf = (s) => { const d = new Date(s); d.setHours(0, 0, 0, 0); return d.getTime() }

test('a monthly backup is never handed to a timer longer than a timer can hold', () => {
  const real = global.setTimeout
  const delays = []
  global.setTimeout = (fn, ms) => { delays.push(ms); return real(() => {}, 0) }
  try {
    scheduleBackups(30, null)
    clearBackupSchedule()
  } finally {
    global.setTimeout = real
  }
  assert.ok(delays.length > 0)
  for (const ms of delays) assert.ok(ms <= 2 ** 31 - 1, `delay ${ms}`)
})

test('the next backup counts from the last one that worked, not from boot', () => {
  const now = new Date('2026-11-05T15:00:00').getTime()
  // Weekly, last ran two days ago: due five days from now however often it restarts.
  const last = new Date('2026-11-03T00:00:10').getTime()
  assert.equal(nextBackupAt(7, last, now), new Date('2026-11-10T00:00:00').getTime())
  assert.equal(nextBackupAt(7, last, now + 3 * 60 * 60 * 1000), new Date('2026-11-10T00:00:00').getTime())
  // Monthly works the same way.
  assert.equal(nextBackupAt(30, last, now), new Date('2026-12-03T00:00:00').getTime())
})

test('a backup that is overdue, or has never run, goes at the coming midnight', () => {
  const now = new Date('2026-11-05T15:00:00').getTime()
  const tonight = midnightOf(now) + DAY
  assert.equal(nextBackupAt(7, new Date('2026-10-01T00:00:00').getTime(), now), tonight)
  assert.equal(nextBackupAt(30, null, now), tonight)
  assert.equal(nextBackupAt(1, now - DAY, now), tonight)
})

function png(width, height) {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gif(width, height) {
  const buf = Buffer.alloc(13)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

test('a picture declaring a huge size is refused before anything decodes it', () => {
  assert.equal(decodableSize(png(30000, 30000)), false, 'PNG bomb')
  assert.equal(decodableSize(gif(65535, 65535)), false, 'GIF bomb')
  assert.equal(decodableSize(Buffer.alloc(64)), false, 'unknown format')
})

test('ordinary posters and animated profile pictures pass', () => {
  assert.deepEqual(sourceDimensions(png(780, 1170)), { width: 780, height: 1170 })
  assert.equal(decodableSize(png(2000, 3000)), true)
  assert.equal(decodableSize(gif(498, 498)), true)
  assert.equal(decodableSize(png(6000, 6000)), true, '36 MP is still fine')
})

test('a merge archive holding Postgres counters can be written and read back', () => {
  const row = { overallTimeWatched: 4597446n, timeOffset: null, timeWatched: 1394894n }
  const text = JSON.stringify({ donorRows: { watchSnapshot: [row] } }, bigintAsText, 2)
  assert.deepEqual(JSON.parse(text).donorRows.watchSnapshot[0], { overallTimeWatched: '4597446', timeOffset: null, timeWatched: '1394894' })
})
