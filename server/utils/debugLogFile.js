// Size-capped append for the on-disk debug/heartbeat logs.
//
// Several subsystems write a heartbeat line to a file under data/ to prove
// their scheduler is actually running - console output was found to be
// unreliable under bun, so these files are the ground truth when something
// silently stops ticking. That part is genuinely useful and stays.
//
// What was missing is any bound. Every one of these writers used a bare
// fs.appendFileSync, so the files only ever grew: 160MB across three live
// instances when this was added, the largest single file 63MB, all of it
// heartbeat lines nobody would ever read past the last few hundred.
//
// This keeps the RECENT tail (the only part with diagnostic value) and
// discards the rest once a file crosses the cap, rather than rotating into
// .1/.2 files that would themselves need cleaning up. Everything is
// best-effort and swallowed: a debug log must never be able to break the
// thing it is observing.

const fs = require('fs')

const MAX_BYTES = 5 * 1024 * 1024
// How much of the tail survives a trim. Deliberately well under the cap so
// trimming happens rarely rather than on nearly every write once full.
const KEEP_BYTES = 1 * 1024 * 1024

// Avoids a stat() syscall on every single line: track what we've written
// since the last check and only re-stat once that alone could matter.
const bytesSinceCheck = new Map()
const CHECK_EVERY_BYTES = 64 * 1024

function trimIfNeeded(filePath) {
  try {
    const { size } = fs.statSync(filePath)
    if (size <= MAX_BYTES) return
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(KEEP_BYTES)
      const read = fs.readSync(fd, buf, 0, KEEP_BYTES, size - KEEP_BYTES)
      let tail = buf.subarray(0, read)
      // Start at a line boundary so the first surviving entry isn't a
      // fragment of one.
      const nl = tail.indexOf(0x0a)
      if (nl !== -1 && nl + 1 < tail.length) tail = tail.subarray(nl + 1)
      fs.writeFileSync(filePath, `[trimmed - older entries discarded at ${new Date().toISOString()}]\n`)
      fs.appendFileSync(filePath, tail)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // Unreadable/locked - leave it alone rather than risk losing the file.
  }
}

/** Appends one line, trimming the file first if it has grown past the cap. */
function appendCapped(filePath, line) {
  try {
    const since = (bytesSinceCheck.get(filePath) || 0) + Buffer.byteLength(line)
    if (since >= CHECK_EVERY_BYTES) {
      bytesSinceCheck.set(filePath, 0)
      trimIfNeeded(filePath)
    } else {
      bytesSinceCheck.set(filePath, since)
    }
    fs.appendFileSync(filePath, line)
  } catch {
    // Never let a debug write break its caller.
  }
}

module.exports = { appendCapped, MAX_BYTES }
