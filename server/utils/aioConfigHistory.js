// AIOStreams configuration history: every version SlickSync has seen, what
// changed between them, and putting an earlier one back.
//
// The configuration change check (aiostreamsConfig.js) reads each watched
// configuration every 30 minutes; a version it hasn't seen before is kept
// here (reason "seen"), as is the configuration straight after one of
// SlickSync's own writes ("slicksync") and after a restore ("restore"). A
// configuration holds debrid keys, so the whole of it is encrypted with the
// account's key - the summary beside it names addons, services and household
// users only (services by a hash of their key, never the key).
//
// Restore puts an earlier version back through the usual write sequence
// (outside changes reported, written, re-baselined). By default it keeps
// what is there now for the debrid services, the household users and the
// API keys - an old version must not bring back a dead key or a removed PIN.
// Its variants and household users are checked against the instance's
// limits first (GET /api/v1/status), and AIOStreams' own refusal (an addon
// limit it doesn't publish) is passed on in plain words.

const { summarize, describeChanges, readConfig, writeConfig, rebaseline, noteOutsideChanges, instanceBase } = require('./aiostreamsConfig')

const KEEP_PER_CONFIG = 20
// Read-only or recomputed by AIOStreams - always the configuration's current values.
const CURRENT_KEYS = ['uuid', 'encryptedPassword', 'ip', 'trusted', 'healthResults', 'showChanges']

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function configKeyOf(person) {
  return `${instanceBase(person.jellyfinServerUrl)}|${person.aioConfigId}`
}

/** Keep this version unless it is the newest one already. */
async function remember(prisma, person, config, reason) {
  try {
    const { encrypt } = require('./encryption')
    const accountId = person.accountId || 'default'
    const configKey = configKeyOf(person)
    const summary = summarize(config)
    const latest = await prisma.aioConfigSnapshot.findFirst({ where: { accountId, configKey }, orderBy: { createdAt: 'desc' }, select: { hash: true } })
    if (latest?.hash === summary.hash) return false
    await prisma.aioConfigSnapshot.create({
      data: {
        accountId,
        configKey,
        userId: person.id,
        hash: summary.hash,
        summary: JSON.stringify(summary),
        config: encrypt(JSON.stringify(config), { appAccountId: accountId }),
        reason,
      },
    })
    const old = await prisma.aioConfigSnapshot.findMany({ where: { accountId, configKey }, orderBy: { createdAt: 'desc' }, skip: KEEP_PER_CONFIG, select: { id: true } })
    if (old.length) await prisma.aioConfigSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    return true
  } catch (e) {
    console.warn('[AioConfigHistory] could not keep this version:', e?.message)
    return false
  }
}

/** The versions, newest first, each with what changed from the one before. */
async function historyFor(prisma, accountId, userId) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { id: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true, jellyfinServerKind: true } })
  if (!person) throw fail('User not found', 404)
  if (person.jellyfinServerKind !== 'aiostreams' || !person.aioConfigId || !person.aioConfigPassword) return { available: false, versions: [] }
  const rows = await prisma.aioConfigSnapshot.findMany({
    where: { accountId, configKey: configKeyOf(person) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, reason: true, createdAt: true },
  })
  const parsed = rows.map((r) => ({ ...r, summary: JSON.parse(r.summary || '{}') }))
  return {
    available: true,
    versions: parsed.map((r, i) => {
      const before = parsed[i + 1]
      return {
        id: r.id,
        at: r.createdAt,
        reason: r.reason,
        current: i === 0,
        changes: before ? describeChanges(before.summary, r.summary) : [],
        addons: r.summary.addons?.length || 0,
        services: r.summary.services?.length || 0,
        users: r.summary.users?.length || 0,
      }
    }),
  }
}

async function limitsOf(base) {
  try {
    const res = await fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(15000) })
    const s = (await res.json())?.data?.settings || {}
    return { variants: Number(s.variants?.max) || 0, personas: Number(s.jellyfin?.maxPersonas) || 0 }
  } catch {
    return { variants: 0, personas: 0 }
  }
}

/** What restoring `old` over `current` would save. */
function merge(old, current, { keepServices = true, keepPersonas = true, keepApiKeys = true } = {}) {
  const next = JSON.parse(JSON.stringify(old))
  for (const k of CURRENT_KEYS) {
    if (current[k] === undefined) delete next[k]
    else next[k] = current[k]
  }
  if (keepServices) next.services = current.services
  if (keepPersonas || keepApiKeys) {
    next.jellyfin = { ...(next.jellyfin || {}) }
    const cur = current.jellyfin || {}
    if (keepPersonas) {
      for (const k of ['personas', 'primary']) {
        if (cur[k] === undefined) delete next.jellyfin[k]
        else next.jellyfin[k] = cur[k]
      }
    }
    if (keepApiKeys) {
      if (cur.apiKeys === undefined) delete next.jellyfin.apiKeys
      else next.jellyfin.apiKeys = cur.apiKeys
    }
  }
  return next
}

async function restore(prisma, decrypt, accountId, userId, snapshotId, options = {}) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId } })
  if (!person) throw fail('User not found', 404)
  if (person.jellyfinServerKind !== 'aiostreams' || !person.aioConfigId || !person.aioConfigPassword) {
    throw fail(`SlickSync needs ${person.username}'s AIOStreams configuration password for this - reconnect them with it.`, 409)
  }
  const snapshot = await prisma.aioConfigSnapshot.findFirst({ where: { id: snapshotId, accountId, configKey: configKeyOf(person) } })
  if (!snapshot) throw fail('That version is no longer kept', 404)

  const access = { serverUrl: person.jellyfinServerUrl, account: person.aioConfigId, password: decrypt(person.aioConfigPassword, { appAccountId: accountId }) }
  const current = await readConfig(access)
  const old = JSON.parse(decrypt(snapshot.config, { appAccountId: accountId }))
  const next = merge(old, current, options)

  const limits = await limitsOf(instanceBase(person.jellyfinServerUrl))
  const variants = Array.isArray(next.variants) ? next.variants.length : 0
  if (limits.variants && variants > limits.variants) throw fail(`That version has ${variants} variants, and this AIOStreams allows ${limits.variants} now.`, 409)
  const personas = Array.isArray(next.jellyfin?.personas) ? next.jellyfin.personas.length : 0
  if (limits.personas && personas > limits.personas) throw fail(`That version has ${personas} household users, and this AIOStreams allows ${limits.personas} now.`, 409)

  // Anything changed since the last look is reported, and kept, first.
  try {
    await noteOutsideChanges(prisma, person, current)
  } catch (e) {
    console.warn('[AioConfigHistory] could not compare with the last look:', e?.message)
  }
  try {
    await writeConfig(access, next)
  } catch (e) {
    const m = /maximum allowed is (\d+)/i.exec(String(e?.message || ''))
    if (m) throw fail(`That version has more addons than this AIOStreams allows now (${m[1]}). Remove some there first.`, 409)
    throw fail(e?.message || 'AIOStreams refused it', 409)
  }
  await rebaseline(prisma, person, await readConfig(access), 'restore')
  return { restored: true }
}

module.exports = { remember, historyFor, restore, merge, configKeyOf, KEEP_PER_CONFIG }
