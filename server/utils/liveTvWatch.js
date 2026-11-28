// Live TV watch: the playlists (M3U) and IPTV logins inside the AIOStreams
// setups SlickSync already reads are checked by themselves, and the household
// hears when one stops working, when it works again, and when a login is
// about to run out. Nothing to set up: whatever a setup carries is watched,
// including a source someone adds later.
//
// A source is checked a few times a day, more often while it is failing. One
// failed look is not an alarm (servers hiccup); two in a row are. What was
// seen is kept in the account's sync settings under `liveTv`, per person and
// source, so a restart neither forgets an outage nor reports it again.
//
// Addresses and passwords never leave here: an alert names the person and the
// source's own name, nothing else.

const crypto = require('crypto')
const { liveTvSources } = require('./aioServiceKeys')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RECHECK_FAILING_MS = 25 * 60 * 1000
const FAILS_BEFORE_ALERT = 2
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000

function sourceKey(source) {
  const id = source.kind === 'm3u' ? `m3u|${source.playlist}` : `xtream|${String(source.server).toLowerCase()}|${source.username}`
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 12)
}

function isDue(state, now) {
  if (!state || !state.checkedAt) return true
  const since = now - Date.parse(state.checkedAt)
  if (!Number.isFinite(since)) return true
  return since >= (state.fails > 0 ? RECHECK_FAILING_MS : CHECK_EVERY_MS)
}

/**
 * What one look at a source means, given what was known before.
 * Returns the state to keep and the things worth telling the household.
 */
function nextState(prev, result, now) {
  const state = { ...(prev || {}), checkedAt: new Date(now).toISOString() }
  const events = []
  if (!result.ok) {
    state.fails = (prev?.fails || 0) + 1
    state.message = String(result.message || 'It did not answer')
    if (state.fails >= FAILS_BEFORE_ALERT && !prev?.down) {
      state.down = true
      state.since = state.checkedAt
      events.push({ type: 'down', message: state.message })
    }
    return { state, events }
  }
  if (prev?.down) events.push({ type: 'back', since: prev.since || null })
  state.fails = 0
  delete state.down
  delete state.since
  delete state.message
  const expiresAt = result.expiresAt instanceof Date && !Number.isNaN(result.expiresAt.getTime()) ? result.expiresAt : null
  if (expiresAt) {
    state.expiresAt = expiresAt.toISOString()
    const left = expiresAt.getTime() - now
    const day = state.expiresAt.slice(0, 10)
    // Once for each end date: a renewed login gets a new date and, when its time comes, a new warning.
    if (left > 0 && left <= EXPIRY_WARNING_MS && prev?.warned !== day) {
      state.warned = day
      events.push({ type: 'expiring', expiresAt, days: Math.max(1, Math.ceil(left / (24 * 60 * 60 * 1000))) })
    }
  } else {
    delete state.expiresAt
  }
  return { state, events }
}

// A failure's wording comes from the network layer and can name the server.
// Whatever belongs to the source - its host, its username, its password, its
// whole address - is taken out before the wording is kept or shown.
function scrub(message, source) {
  let text = String(message || 'It did not answer')
  const parts = []
  for (const address of [source.playlist, source.server]) {
    if (!address) continue
    parts.push(String(address))
    try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`); parts.push(u.host, u.hostname); for (const v of u.searchParams.values()) if (v.length >= 3) parts.push(v) } catch { /* not an address */ }
  }
  for (const v of [source.username, source.password]) if (v && String(v).length >= 3) parts.push(String(v))
  for (const part of parts.sort((x, y) => y.length - x.length)) text = text.split(part).join('its server')
  return text.replace(/(its server[\s:/]*)+/g, 'its server ').replace(/\s+/g, ' ').trim()
}

const kindWord = (source) => (source.kind === 'm3u' ? 'Live TV playlist' : 'IPTV login')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`

/** The bell entry for one event. Names the person and the source, never its address or login. */
function describe(event, person, source) {
  const who = person.username
  const what = `${kindWord(source)} “${source.name}”`
  const url = `/users/${person.id}`
  if (event.type === 'down') {
    return { title: `${who}’s ${what} stopped working`, body: `${event.message}. SlickSync keeps checking and will say when it is back.`, url }
  }
  if (event.type === 'back') {
    return { title: `${who}’s ${what} is working again`, body: 'It answered on the latest check.', url }
  }
  return { title: `${who}’s ${what} runs out ${event.days === 1 ? 'tomorrow' : `in ${event.days} days`}`, body: `It ends ${day(event.expiresAt)}. Renew it with the provider to keep Live TV working.`, url }
}

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/**
 * Look at one person's setup: check each Live TV source that is due, keep
 * what was seen, and return the bell entries to send (the caller sends them).
 * `check(source)` does the actual reaching out, so a test can stand in for it.
 */
async function watchLiveTv(prisma, person, config, { now = Date.now(), check } = {}) {
  const accountId = person.accountId || 'default'
  const sources = liveTvSources(config)
  const { cfg } = await readSync(prisma, accountId)
  const all = cfg.liveTv && typeof cfg.liveTv === 'object' ? { ...cfg.liveTv } : {}
  const mine = all[person.id] && typeof all[person.id] === 'object' ? { ...all[person.id] } : {}
  const alerts = []
  let changed = false
  const present = new Set()
  for (const source of sources) {
    const key = sourceKey(source)
    present.add(key)
    if (!isDue(mine[key], now)) continue
    let result
    try { result = await check(source) } catch (e) { result = { ok: false, message: e?.message || 'It did not answer' } }
    if (result && !result.ok) result = { ...result, message: scrub(result.message, source) }
    const { state, events } = nextState(mine[key], result || { ok: false }, now)
    mine[key] = { ...state, name: source.name, kind: source.kind }
    changed = true
    for (const event of events) {
      const text = describe(event, person, source)
      alerts.push({ ...text, type: 'task', dedupeKey: `livetv:${person.id}:${key}:${event.type}:${event.type === 'expiring' ? state.warned : state.checkedAt}` })
    }
  }
  // A source taken out of the setup is forgotten, outage and all.
  for (const key of Object.keys(mine)) if (!present.has(key)) { delete mine[key]; changed = true }
  if (changed) {
    // The checks above can take a minute. The settings are read again here and
    // only this person's Live TV entry is set in them, so nothing saved in the
    // meantime (a limit, a pause, a theme) is put back to what it was.
    const fresh = await readSync(prisma, accountId)
    const latest = fresh.cfg.liveTv && typeof fresh.cfg.liveTv === 'object' ? { ...fresh.cfg.liveTv } : {}
    if (Object.keys(mine).length) latest[person.id] = mine
    else delete latest[person.id]
    const next = { ...fresh.cfg, liveTv: latest }
    if (!Object.keys(latest).length) delete next.liveTv
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: fresh.asString ? JSON.stringify(next) : next } })
  }
  return { alerts, sources: sources.length }
}

/** The real check for a source: the same ones the Vault uses. */
async function checkSource(source) {
  const { runCheck } = require('./vaultCheckers')
  return source.kind === 'm3u'
    ? runCheck('m3u_playlist', source.playlist)
    : runCheck('xtream_auth', source.password, { url: source.server, identifier: source.username })
}

/** What a person's page shows: each source's name, kind and how it stands. No addresses. */
async function liveTvStatus(prisma, accountId, userId) {
  const { cfg } = await readSync(prisma, accountId)
  const mine = cfg.liveTv?.[userId]
  if (!mine || typeof mine !== 'object') return []
  return Object.values(mine).map((s) => ({ name: s.name, kind: s.kind, working: !s.down, since: s.since || null, message: s.down ? s.message || null : null, expiresAt: s.expiresAt || null, checkedAt: s.checkedAt || null }))
}

module.exports = { watchLiveTv, checkSource, liveTvStatus, nextState, describe, sourceKey, isDue, CHECK_EVERY_MS, RECHECK_FAILING_MS, EXPIRY_WARNING_MS }
