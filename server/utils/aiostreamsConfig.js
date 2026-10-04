// Watching AIOStreams configurations for outside changes (reads only; the
// one write, for profile variants, is writeConfig below - see its callers).
//
// Someone who watches in AIOStreams' own apps has no Stremio or Nuvio account
// for Account Guard to watch; their AIOStreams configuration is their setup.
// When they were added with the configuration's password, SlickSync keeps it
// (encrypted - AIOStreams' configuration API takes nothing else) and reads the
// configuration now and then. If it changed since the last look, the
// household hears about it: which addons came or went, which debrid services,
// which household users, or that some other setting moved.
//
// The one thing SlickSync ever writes to a configuration is its own profile
// variants, when the household gives a profile collections of its own
// (utils/aioProfileVariants.js) - and it re-reads the configuration straight
// after, so that write is never reported as an outside change.

const crypto = require('crypto')

const CHECK_INTERVAL_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20000

// Values that change without anyone touching the configuration.
const VOLATILE_KEYS = new Set(['encryptedPassword', 'ip', 'uuid', 'healthResults', 'trusted', 'showChanges'])

function restrictsPrivateAddresses() {
  try { return require('./config').INSTANCE_TYPE === 'public' } catch { return false }
}

/** The AIOStreams instance behind a Jellyfin address: everything before /jellyfin. */
function instanceBase(serverUrl) {
  try {
    const url = new URL(serverUrl)
    const i = url.pathname.toLowerCase().indexOf('/jellyfin')
    const prefix = i >= 0 ? url.pathname.slice(0, i) : ''
    return `${url.origin}${prefix.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * Which configuration a sign-in was to. A sign-in picker address names it in
 * its path (/jellyfin/u/<alias>, or /jellyfin/<uuid>/<key>); on the plain
 * address it is the first part of the user name ("<uuid>" or "<uuid>/Sam").
 */
function configAccountFrom(serverUrl, typedLogin) {
  try {
    const path = new URL(serverUrl).pathname
    const alias = /\/jellyfin\/u\/([^/]+)\/?$/i.exec(path)
    if (alias) return decodeURIComponent(alias[1])
    const picker = /\/jellyfin\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+\/?$/i.exec(path)
    if (picker) return picker[1]
  } catch {
    return null
  }
  const typed = String(typedLogin || '').trim()
  if (!typed) return null
  return typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/')) : typed
}

async function readConfig({ serverUrl, account, password }) {
  const base = instanceBase(serverUrl)
  if (!base || !account) throw Object.assign(new Error('Not an AIOStreams configuration'), { status: 400 })
  if (restrictsPrivateAddresses()) {
    const { assertSafeUrl } = require('./safeUrl')
    await assertSafeUrl(base)
  }
  const auth = Buffer.from(`${account}:${password}`).toString('base64')
  let res
  try {
    res = await fetch(`${base}/api/v1/user?raw=true`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw Object.assign(new Error(`Could not reach AIOStreams: ${e?.cause?.code || e?.message || 'network error'}`), { status: 502 })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success || !body?.data?.userData) {
    throw Object.assign(new Error(body?.error?.message || `AIOStreams answered ${res.status}`), { status: res.status })
  }
  return body.data.userData
}

/**
 * Save a configuration read with readConfig. AIOStreams replaces the whole
 * configuration on save, so callers change only their own parts of what they
 * just read and send all of it back.
 */
async function writeConfig({ serverUrl, account, password }, config) {
  const base = instanceBase(serverUrl)
  if (!base || !account) throw Object.assign(new Error('Not an AIOStreams configuration'), { status: 400 })
  if (restrictsPrivateAddresses()) {
    const { assertSafeUrl } = require('./safeUrl')
    await assertSafeUrl(base)
  }
  const auth = Buffer.from(`${account}:${password}`).toString('base64')
  let res
  try {
    res = await fetch(`${base}/api/v1/user`, {
      method: 'PUT',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw Object.assign(new Error(`Could not reach AIOStreams: ${e?.cause?.code || e?.message || 'network error'}`), { status: 502 })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    throw Object.assign(new Error(body?.error?.message || `AIOStreams answered ${res.status}`), { status: res.status >= 500 ? 502 : 400 })
  }
}

/**
 * After SlickSync's own write: take the configuration as it is now as the
 * baseline for everyone it is watched through, so the next look finds no
 * outside change.
 */
async function rebaseline(prisma, person, config) {
  const state = JSON.stringify({ ...summarize(config), checkedAt: new Date().toISOString() })
  await prisma.user.updateMany({
    where: { accountId: person.accountId, aioConfigId: person.aioConfigId, jellyfinServerUrl: person.jellyfinServerUrl },
    data: { aioConfigStateJson: state },
  })
}

/**
 * The password that opens the configuration's API: what was typed, or - for a
 * household user with a PIN, typed as password/1234 - the part before the PIN.
 */
async function findWorkingPassword({ serverUrl, account, password }) {
  const candidates = [password]
  const slash = String(password || '').lastIndexOf('/')
  if (slash > 0) candidates.push(password.slice(0, slash))
  for (const candidate of candidates) {
    try {
      const config = await readConfig({ serverUrl, account, password: candidate })
      return { password: candidate, config }
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e
    }
  }
  return null
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => !VOLATILE_KEYS.has(k)).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/** What a person would recognise in a configuration, and a hash of all of it. */
function summarize(config) {
  const addons = (Array.isArray(config?.presets) ? config.presets : []).map((p) => ({
    id: String(p.instanceId || ''),
    name: String(p.options?.name || p.type || 'Addon'),
    enabled: p.enabled !== false,
  }))
  const services = (Array.isArray(config?.services) ? config.services : []).map((s) => ({
    id: String(s.id || ''),
    enabled: s.enabled !== false,
    // Whether its key changed, never the key itself.
    keyHash: crypto.createHash('sha256').update(stableJson(s.credentials || {})).digest('hex').slice(0, 12),
  }))
  const users = (Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []).map((p) => String(p.name || p.id || ''))
  const hash = crypto.createHash('sha256').update(stableJson(config || {})).digest('hex').slice(0, 16)
  return { addons, services, users, hash }
}

const SERVICE_NAMES = {
  realdebrid: 'Real-Debrid', alldebrid: 'AllDebrid', premiumize: 'Premiumize', debridlink: 'Debrid-Link',
  torbox: 'TorBox', easydebrid: 'EasyDebrid', offcloud: 'Offcloud', putio: 'put.io', pikpak: 'PikPak',
  seedr: 'Seedr', easynews: 'Easynews',
}
const serviceName = (id) => SERVICE_NAMES[id] || id

/** The changes between two looks, in words. */
function describeChanges(before, after) {
  const out = []
  const beforeAddons = new Map((before.addons || []).map((a) => [a.id, a]))
  const afterAddons = new Map((after.addons || []).map((a) => [a.id, a]))
  for (const [id, a] of afterAddons) if (!beforeAddons.has(id)) out.push(`added ${a.name}`)
  for (const [id, a] of beforeAddons) if (!afterAddons.has(id)) out.push(`removed ${a.name}`)
  for (const [id, a] of afterAddons) {
    const was = beforeAddons.get(id)
    if (was && was.enabled !== a.enabled) out.push(`${a.enabled ? 'turned on' : 'turned off'} ${a.name}`)
  }
  const beforeServices = new Map((before.services || []).map((s) => [s.id, s]))
  const afterServices = new Map((after.services || []).map((s) => [s.id, s]))
  for (const [id] of afterServices) if (!beforeServices.has(id)) out.push(`added ${serviceName(id)}`)
  for (const [id] of beforeServices) if (!afterServices.has(id)) out.push(`removed ${serviceName(id)}`)
  for (const [id, s] of afterServices) {
    const was = beforeServices.get(id)
    if (!was) continue
    if (was.keyHash !== s.keyHash) out.push(`changed the ${serviceName(id)} key`)
    else if (was.enabled !== s.enabled) out.push(`${s.enabled ? 'turned on' : 'turned off'} ${serviceName(id)}`)
  }
  const beforeUsers = new Set(before.users || [])
  const afterUsers = new Set(after.users || [])
  for (const u of afterUsers) if (!beforeUsers.has(u)) out.push(`added household user ${u}`)
  for (const u of beforeUsers) if (!afterUsers.has(u)) out.push(`removed household user ${u}`)
  if (!out.length && before.hash !== after.hash) out.push('changed other settings')
  return out
}

/**
 * When an AIOStreams person was signed in with the configuration's password,
 * keep it so the configuration can be watched. Best-effort: a sign-in through
 * Quick Connect, or a password the API turns down, just leaves it unwatched.
 */
async function rememberConfigAccess(prisma, encrypt, person, { probe, typedLogin, password }) {
  if (probe?.kind !== 'aiostreams' || password == null || password === '') return false
  const account = configAccountFrom(probe.serverUrl, typedLogin)
  if (!account) return false
  try {
    const found = await findWorkingPassword({ serverUrl: probe.serverUrl, account, password })
    if (!found) return false
    const state = { ...summarize(found.config), checkedAt: new Date().toISOString() }
    await prisma.user.update({
      where: { id: person.id },
      data: {
        aioConfigId: account,
        aioConfigPassword: encrypt(found.password, { appAccountId: person.accountId || 'default' }),
        aioConfigStateJson: JSON.stringify(state),
      },
    })
    return true
  } catch (e) {
    console.warn('[AIOStreamsConfig] Could not keep configuration access:', e?.message)
    return false
  }
}

async function alert(prisma, accountId, { title, body, url, dedupeKey }) {
  try {
    const { createNotification } = require('./notificationStore')
    await createNotification(prisma, accountId, { type: 'sync', title, body, url, dedupeKey })
  } catch (e) {
    console.warn('[AIOStreamsConfig] bell dispatch failed:', e?.message)
  }
  try {
    const { isPushEnabled, sendPushToAccount } = require('./pushNotifications')
    if (isPushEnabled()) await sendPushToAccount(prisma, accountId, { title, body, url })
  } catch (e) {
    console.warn('[AIOStreamsConfig] push dispatch failed:', e?.message)
  }
}

/** One look at every watched configuration; tells the household about any change. */
async function checkConfigs(prisma, decrypt) {
  const people = await prisma.user.findMany({
    where: { providerType: 'jellyfin', aioConfigPassword: { not: null } },
    select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true, aioConfigStateJson: true },
  })
  // One configuration can be behind several people; look once per account.
  const seen = new Set()
  for (const person of people) {
    const accountId = person.accountId || 'default'
    const key = `${accountId}|${instanceBase(person.jellyfinServerUrl)}|${person.aioConfigId}`
    if (seen.has(key)) continue
    seen.add(key)
    let before = {}
    try { before = JSON.parse(person.aioConfigStateJson || '{}') || {} } catch { before = {} }
    let config
    try {
      const password = decrypt(person.aioConfigPassword, { appAccountId: accountId })
      config = await readConfig({ serverUrl: person.jellyfinServerUrl, account: person.aioConfigId, password })
    } catch (e) {
      if ((e.status === 401 || e.status === 403) && !before.passwordRejected) {
        await prisma.user.update({ where: { id: person.id }, data: { aioConfigStateJson: JSON.stringify({ ...before, passwordRejected: true }) } })
        await alert(prisma, accountId, {
          title: `SlickSync can no longer check ${person.username}'s AIOStreams configuration`,
          body: 'Its password changed. Reconnect them with the new password to keep watching it for changes.',
          url: `/users/${person.id}`,
          dedupeKey: `aioconfig-password:${person.id}`,
        })
      }
      continue
    }
    await noteOutsideChanges(prisma, person, config, before)
  }
}

/**
 * Compare a configuration as just read with the last look; tell the
 * household what changed, and remember this look. Also run right before
 * SlickSync's own write, so an outside change made since the last look is
 * reported rather than folded into the baseline that write leaves behind.
 */
async function noteOutsideChanges(prisma, person, config, before) {
  if (!before) {
    const row = await prisma.user.findUnique({ where: { id: person.id }, select: { aioConfigStateJson: true } })
    try { before = JSON.parse(row?.aioConfigStateJson || '{}') || {} } catch { before = {} }
  }
  const accountId = person.accountId || 'default'
  const after = { ...summarize(config), checkedAt: new Date().toISOString() }
  if (before.hash && before.hash !== after.hash) {
    const changes = describeChanges(before, after)
    const shown = changes.slice(0, 4).join(', ') + (changes.length > 4 ? `, and ${changes.length - 4} more` : '')
    await alert(prisma, accountId, {
      title: `${person.username}'s AIOStreams configuration was changed outside SlickSync`,
      body: `Someone ${shown}.`,
      url: `/users/${person.id}`,
      dedupeKey: `aioconfig:${person.id}:${after.hash}`,
    })
  }
  await prisma.user.update({ where: { id: person.id }, data: { aioConfigStateJson: JSON.stringify(after) } })
}

let timer = null
function scheduleConfigGuard(prisma, decrypt) {
  if (timer) clearInterval(timer)
  const run = async () => {
    // Profile variants first: a write here re-baselines, so the look that
    // follows doesn't report SlickSync's own fix as an outside change.
    await require('./aioProfileVariants').healProfileVariants(prisma, decrypt).catch((e) => console.warn('[AIOStreamsConfig] profile variants check failed:', e?.message))
    await checkConfigs(prisma, decrypt).catch((e) => console.warn('[AIOStreamsConfig] check failed:', e?.message))
  }
  setTimeout(run, 2 * 60 * 1000)
  timer = setInterval(run, CHECK_INTERVAL_MS)
}

module.exports = {
  instanceBase,
  configAccountFrom,
  readConfig,
  writeConfig,
  rebaseline,
  noteOutsideChanges,
  summarize,
  describeChanges,
  rememberConfigAccess,
  checkConfigs,
  scheduleConfigGuard,
}
