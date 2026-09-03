// OMDb daily-usage meter. OMDb's API reports NOTHING about quota consumption
// (unlike MDBList, whose /user endpoint states used/limit outright) - the
// first sign of the free tier's 1,000/day cap used to be requests suddenly
// failing. So SlickSync counts its own outgoing OMDb requests per key per
// UTC day and surfaces the running total next to the key in Settings, the
// same way MDBList's real figure already appears.
//
// Honest limits of self-counting, stated in the UI as "counted by
// SlickSync": requests made with the same key by anything OTHER than this
// instance are invisible here, so the true burn can only be higher than
// this number, never lower. Counted per key hash (never the key itself),
// persisted to data/omdb-meter.json so a redeploy mid-day does not zero the
// figure, flushed lazily so hot paths never wait on disk.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FILE = path.join(process.cwd(), 'data', 'omdb-meter.json')
const OMDB_FREE_DAILY_LIMIT = 1000

let state = null // { [tag]: { date: 'YYYY-MM-DD', count: number } }
let dirtyWrites = 0
let flushTimer = null

function keyTag(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12)
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

function load() {
  if (state) return state
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!state || typeof state !== 'object') state = {}
  } catch {
    state = {}
  }
  return state
}

function flushSoon() {
  dirtyWrites++
  if (flushTimer) return
  // 10s debounce - a burst of poster lookups becomes one write.
  flushTimer = setTimeout(() => {
    flushTimer = null
    dirtyWrites = 0
    try {
      fs.writeFileSync(FILE, JSON.stringify(state))
    } catch { /* metering is best-effort - never let it hurt a request */ }
  }, 10000)
  if (flushTimer.unref) flushTimer.unref()
}

/** Count one real OMDb API request made with this key. */
function recordOmdbRequest(apiKey) {
  if (!apiKey) return
  try {
    const s = load()
    const tag = keyTag(apiKey)
    const date = todayUtc()
    const cur = s[tag]
    s[tag] = cur && cur.date === date ? { date, count: cur.count + 1 } : { date, count: 1 }
    flushSoon()
  } catch { /* never throw from a meter */ }
}

/** Today's count for this key, shaped like MDBList's usage block. */
function readOmdbUsage(apiKey) {
  if (!apiKey) return null
  try {
    const s = load()
    const cur = s[keyTag(apiKey)]
    const used = cur && cur.date === todayUtc() ? cur.count : 0
    return {
      used,
      limit: OMDB_FREE_DAILY_LIMIT,
      percentUsed: Math.round((used / OMDB_FREE_DAILY_LIMIT) * 1000) / 10,
      plan: null,
      // The UI adds "counted by SlickSync" for this - other apps using the
      // same key are invisible here, so the truth is >= this number.
      approximate: true,
    }
  } catch {
    return null
  }
}

module.exports = { recordOmdbRequest, readOmdbUsage, OMDB_FREE_DAILY_LIMIT }
