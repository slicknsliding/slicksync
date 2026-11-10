// Keep in step: a person's sign-ins and profiles kept in step with each
// other, a few minutes at a time. Off by default, per person.
//
// Each sign-in or profile is set to "both" (sends and receives), "receive"
// (only receives - a Kids profile that shouldn't push into a parent's
// history) or "off" (left out). Every pass reads all of them once, merges
// what the senders have (each title at its furthest: finished episodes
// together, the newest resume point), and brings every receiver up to that
// with the same writes as Copy watch history - so it never moves anything
// backwards, and a title further along on the receiver stays as it is.
//
// Only what happened since it was switched on moves ("from now on"): a pass
// looks at titles touched since the later of the switch-on time and the last
// pass (with a margin for clocks). Copying everything that came before is
// what the one-time copy is for.

const { plan } = require('./plan')
const { ADAPTERS } = require('./adapters')
const locks = require('./locks')

const PASS_MS = 4 * 60 * 1000
const MARGIN_MS = 15 * 60 * 1000
const MOVES_KEPT = 30
const MODES = new Set(['both', 'receive', 'off'])

function parse(json, fallback) {
  try { return JSON.parse(json) } catch { return fallback }
}

/** Every sign-in and profile the person has, as Keep in step lists them. */
function placesOf(sides) {
  const out = []
  for (const s of sides) {
    if (s.profiles?.length) for (const p of s.profiles) out.push({ side: p.side, provider: s.provider, kind: s.kind, name: s.name, profile: p.name, first: p === s.profiles[0] })
    else out.push({ side: s.side, provider: s.provider, kind: s.kind, name: s.name, profile: null, first: true })
  }
  return out
}

// Out of the box: each sign-in's own profile sends and receives; a second
// profile (often someone else's) is left out until it's chosen.
const defaultMode = (place) => (place.first ? 'both' : 'off')

async function describe(prisma, deps, accountId, userId) {
  const watchCopy = require('./index')
  const sides = await watchCopy.sides(prisma, deps, accountId, userId)
  const row = await prisma.watchSyncSetting.findUnique({ where: { userId } }).catch(() => null)
  const saved = new Map(parse(row?.members, []).map((m) => [m.side, m.mode]))
  const places = placesOf(sides).map((p) => ({ ...p, mode: saved.get(p.side) || defaultMode(p) }))
  const moves = await prisma.watchSyncMove.findMany({ where: { userId }, orderBy: { at: 'desc' }, take: MOVES_KEPT }).catch(() => [])
  return {
    enabled: row?.enabled === true,
    since: row?.enabledAt || null,
    lastPass: row?.lastPassAt || null,
    lastError: row?.lastError || null,
    places,
    moves: moves.map((m) => ({ at: m.at, title: m.title, what: m.what, from: m.fromLabel, to: parse(m.toLabels, []) })),
  }
}

async function save(prisma, deps, accountId, userId, body = {}) {
  const now = new Date(body.now || Date.now())
  const current = await prisma.watchSyncSetting.findUnique({ where: { userId } }).catch(() => null)
  const members = Array.isArray(body.members)
    ? body.members.filter((m) => m && typeof m.side === 'string' && MODES.has(m.mode)).map((m) => ({ side: m.side, mode: m.mode }))
    : parse(current?.members, [])
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : current?.enabled === true
  const turningOn = enabled && !current?.enabled
  const data = {
    accountId,
    enabled,
    members: JSON.stringify(members),
    // "From now on": switching on (again) starts the clock.
    ...(turningOn ? { enabledAt: now, lastPassAt: null, lastError: null } : {}),
  }
  await prisma.watchSyncSetting.upsert({ where: { userId }, create: { userId, ...data, enabledAt: enabled ? now : null }, update: data })
  return describe(prisma, deps, accountId, userId)
}

const epCount = (t) => t?.episodes?.size || 0

/** Senders merged: every title at its furthest, remembering who had it. */
function merge(reads) {
  const out = new Map()
  for (const { label, state } of reads) {
    for (const [key, t] of state) {
      if (!t.id) continue
      let m = out.get(key)
      if (!m) {
        m = { ...t, episodes: new Map(t.episodes), resume: t.resume ? { ...t.resume } : null, from: label }
        out.set(key, m)
        continue
      }
      if (t.watchedAt != null && (m.watchedAt == null || (t.watchedAt || 0) > (m.watchedAt || 0))) m.watchedAt = t.watchedAt
      for (const [k, at] of t.episodes) if (!m.episodes.has(k) || (at || 0) > (m.episodes.get(k) || 0)) m.episodes.set(k, at)
      if (t.resume && (!m.resume || (t.resume.at || 0) > (m.resume.at || 0))) m.resume = { ...t.resume }
      if ((t.lastActivity || 0) > (m.lastActivity || 0)) { m.lastActivity = t.lastActivity; m.from = label }
      m.name = m.name || t.name
      m.poster = m.poster || t.poster
      m.inLibrary = m.inLibrary || t.inLibrary
      if (epCount(t) > epCount(m) && t.type === 'series') m.type = 'series'
    }
  }
  return out
}

const placeLabel = (p) => `${p.name}${p.profile && p.profile !== p.name ? ` · ${p.profile}` : ''}`

// One person, one pass. Returns what moved. Anything that kept a place from
// being read or written goes in report.problems: the pass then doesn't count
// as done, so the next one looks back to the last complete pass and nothing
// watched during an outage is skipped.
async function runPerson(prisma, deps, setting, now = Date.now(), report = {}) {
  const problems = report.problems = []
  const { accountId, userId } = setting
  const info = await describe(prisma, deps, accountId, userId)
  const active = info.places.filter((p) => p.mode !== 'off')
  const senders = active.filter((p) => p.mode === 'both')
  if (!senders.length || active.length < 2) return []
  const watchCopy = require('./index')
  const reads = new Map()
  for (const p of active) {
    try {
      reads.set(p.side, { place: p, ...(await watchCopy.readSide(prisma, deps, accountId, userId, p.side)) })
    } catch (e) {
      console.warn(`[keepInStep] ${userId} could not read ${p.side}:`, e?.message)
      problems.push(e?.status === 409 ? e.message : `Couldn’t read ${placeLabel(p)} - trying again shortly`)
    }
  }
  const since = Math.max(new Date(setting.enabledAt || now).getTime(), setting.lastPassAt ? new Date(setting.lastPassAt).getTime() - MARGIN_MS : 0)
  const moved = new Map() // title key -> { title, what, from, to: Set }
  for (const p of active) {
    const target = reads.get(p.side)
    if (!target) continue
    const from = [...reads.values()].filter((r) => r.place.mode === 'both' && r.place.side !== p.side)
    if (!from.length) continue
    const merged = merge(from.map((r) => ({ label: placeLabel(r.place), state: r.read.state })))
    const result = plan(merged, target.read.state, { watched: true, resume: true, sinceMs: since })
    const items = result.items.filter((i) => i.outcome === 'copy')
    if (!items.length) continue
    // A copy into this sign-in is running: this place waits for the next pass.
    const lockKey = locks.keyOf(accountId, userId, target.kind)
    if (!locks.take(lockKey, 'keepInStep')) { problems.push(`${placeLabel(p)} is busy with a copy - trying again shortly`); continue }
    try {
      const w = await ADAPTERS[target.kind].write(target.provider, target.read, items, { ...deps, now })
      require('../ownWrites').note(target.signInId, w.own)
      const failed = new Set((w.failed || []).map((f) => f.key))
      for (const i of items) {
        if (failed.has(i.key)) continue
        const m = moved.get(i.key) || { title: i.name || i.id, what: i.from.text, from: merged.get(i.key)?.from || '', to: new Set() }
        m.to.add(placeLabel(p))
        moved.set(i.key, m)
      }
    } catch (e) {
      console.warn(`[keepInStep] ${userId} could not write ${p.side}:`, e?.message)
      problems.push(`Couldn’t update ${placeLabel(p)} - trying again shortly`)
    } finally {
      locks.release(lockKey)
    }
  }
  if (moved.size) {
    await prisma.watchSyncMove.createMany({
      data: [...moved.values()].map((m) => ({ accountId, userId, at: new Date(now), title: m.title, what: m.what, fromLabel: m.from, toLabels: JSON.stringify([...m.to]) })),
    })
    const old = await prisma.watchSyncMove.findMany({ where: { userId }, orderBy: { at: 'desc' }, skip: MOVES_KEPT, select: { id: true } })
    if (old.length) await prisma.watchSyncMove.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
  }
  return [...moved.values()]
}

let running = false
async function runAll(prisma, makeDeps, now = Date.now()) {
  if (running) return
  running = true
  try {
    const settings = await prisma.watchSyncSetting.findMany({ where: { enabled: true } }).catch(() => [])
    for (const s of settings) {
      let lastError = null
      const report = {}
      try {
        await runPerson(prisma, makeDeps(s.accountId), s, now, report)
        if (report.problems?.length) lastError = [...new Set(report.problems)].join(' · ')
      } catch (e) {
        // The person is gone: their setting goes too, instead of failing
        // every few minutes forever.
        if (e?.status === 404) {
          await prisma.watchSyncSetting.deleteMany({ where: { userId: s.userId } }).catch(() => {})
          continue
        }
        lastError = e?.message || 'Something went wrong'
        console.warn(`[keepInStep] ${s.userId}:`, lastError)
      }
      // Only a pass with nothing left out moves the clock forward.
      const data = lastError ? { lastError } : { lastPassAt: new Date(now), lastError: null }
      await prisma.watchSyncSetting.update({ where: { userId: s.userId }, data }).catch(() => {})
    }
  } finally {
    running = false
  }
}

function scheduleKeepInStep(prisma, { decrypt, encrypt }) {
  const { makeCreateProvider } = require('../../providers')
  const create = makeCreateProvider({ prisma, encrypt })
  const makeDeps = (accountId) => {
    const req = { appAccountId: accountId || 'default' }
    return {
      decrypt: (text, opts) => decrypt(text, opts || req),
      createProvider: (row) => create(row, { decrypt: (t) => decrypt(t, { appAccountId: row.accountId || req.appAccountId }), req }),
    }
  }
  const tick = () => runAll(prisma, makeDeps).catch((e) => console.warn('[keepInStep] pass failed:', e?.message))
  setTimeout(tick, 60 * 1000)
  return setInterval(tick, PASS_MS)
}

module.exports = { describe, save, runPerson, runAll, merge, placesOf, scheduleKeepInStep, PASS_MS }
