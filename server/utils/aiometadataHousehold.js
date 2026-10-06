// AIOMetadata household users from the household card: add one, and - on an
// AIOMetadata that has PINs (newer than 3.4.1) - set or remove their PIN.
//
// AIOMetadata keeps its users in the configuration (config.jellyfinUsers:
// { id, name, pin? }), read and saved through its own configuration API with
// the configuration password: POST /api/config/load/<id>, then PUT
// /api/config/update/<id> with the whole of it back - what its configure page
// does. A PIN goes in plain and AIOMetadata keeps only its hash; one already
// set comes back as that hash and is saved unchanged. An AIOMetadata without
// PINs would keep a PIN exactly as sent, so none is ever sent to one.
//
// The configuration password is kept (encrypted, in the same fields as an
// AIOStreams one: aioConfigId / aioConfigPassword) only when the password
// typed at sign-in opens the configuration - a client password doesn't.
//
// Profiles are matched to users by AIOMetadata's own Jellyfin user id for
// them: md5("<configuration id, dashes removed>|user|<user id>").

const crypto = require('crypto')
const { jfRequest, restrictsPrivateAddresses } = require('../providers/jellyfinAuth')

const PIN = /^\d{4,12}$/
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const REQUEST_TIMEOUT_MS = 20000

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

/** The configuration id and the instance's address, from "https://host/jellyfin/<id>". */
function configOf(serverUrl) {
  try {
    const u = new URL(serverUrl)
    const m = /^(.*?)\/jellyfin\/([^/]+)\/?$/i.exec(u.pathname)
    if (!m) return null
    return { base: `${u.origin}${m[1]}`, uuid: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** AIOMetadata's Jellyfin user id for one of a configuration's users. */
function userIdFor(uuid, userId) {
  const serverId = String(uuid || '').replace(/-/g, '').toLowerCase()
  return crypto.createHash('md5').update(`${serverId}|user|${userId}`).digest('hex')
}

async function request(url, { method = 'GET', body } = {}) {
  if (restrictsPrivateAddresses()) {
    const { assertSafeUrl } = require('./safeUrl')
    await assertSafeUrl(url)
  }
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw fail(`Could not reach AIOMetadata: ${e?.cause?.code || e?.message || 'network error'}`, 502)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw fail(data?.error || `AIOMetadata answered ${res.status}`, res.status === 401 ? 409 : res.status >= 500 ? 502 : 400)
  return data
}

async function readConfig({ base, uuid, password }) {
  const data = await request(`${base}/api/config/load/${encodeURIComponent(uuid)}`, { method: 'POST', body: { password } })
  if (!data?.config || typeof data.config !== 'object') throw fail('AIOMetadata sent no configuration', 502)
  return data.config
}

async function writeConfig({ base, uuid, password }, config) {
  await request(`${base}/api/config/update/${encodeURIComponent(uuid)}`, { method: 'PUT', body: { config, password } })
}

/** At sign-in: keep the password when it opens the configuration (a client password doesn't). */
async function rememberAccess(prisma, encrypt, person, { probe, password }) {
  if (probe?.kind !== 'aiometadata' || !password) return false
  const where = configOf(probe.serverUrl)
  if (!where) return false
  try {
    await readConfig({ ...where, password })
    await prisma.user.update({
      where: { id: person.id },
      data: { aioConfigId: where.uuid, aioConfigPassword: encrypt(password, { appAccountId: person.accountId || 'default' }) },
    })
    return true
  } catch {
    return false
  }
}

function canManage(owner) {
  return owner?.providerType === 'jellyfin' && owner.jellyfinServerKind === 'aiometadata' && !!owner.aioConfigId && !!owner.aioConfigPassword
}

function accessFor(owner, decrypt) {
  if (!canManage(owner)) throw fail(`SlickSync needs ${owner?.username || 'their'}'s AIOMetadata configuration password for this - reconnect them with it.`, 409)
  const where = configOf(owner.jellyfinServerUrl)
  if (!where) throw fail('That isn’t an AIOMetadata configuration address', 409)
  return { ...where, uuid: owner.aioConfigId || where.uuid, password: decrypt(owner.aioConfigPassword, { appAccountId: owner.accountId || 'default' }) }
}

/** Whether this AIOMetadata keeps PINs: a release newer than 3.4.1. */
async function hasPins(owner) {
  try {
    const info = await jfRequest(owner.jellyfinServerUrl, '/System/Info/Public', { timeoutMs: 5000 })
    const { parseVersion, isNewer } = require('./serverVersions')
    const v = parseVersion(info?.aiostreams?.version?.tag || info?.Version)
    return !!v && isNewer(v, [3, 4, 1])
  } catch {
    return false
  }
}

async function signInOnce(prisma, encrypt, owner, { jellyfinUserId, name }, password, pin) {
  const profiles = require('./jellyfinProfiles')
  const secret = pin ? `${password}/${pin}` : password
  const signed = await profiles.signInAs(owner.jellyfinServerUrl, [name], jellyfinUserId, secret).catch(() => ({ token: null }))
  await profiles.saveHousehold(prisma, encrypt, owner, [{
    jellyfinUserId,
    name,
    loginName: signed.loginName || name,
    token: signed.token || null,
    needsPin: !signed.token && !!pin,
  }])
  return !!signed.token
}

/** Add a household user. Returns { tracked }. */
async function addUser(prisma, decrypt, encrypt, owner, { name, pin }) {
  const access = accessFor(owner, decrypt)
  const clean = String(name || '').trim()
  if (!clean || clean.length > 32) throw fail('A name is 1 to 32 characters')
  const lock = pin == null || pin === '' ? null : String(pin)
  if (lock && !PIN.test(lock)) throw fail('A PIN is 4 to 12 digits')
  if (lock && !(await hasPins(owner))) throw fail('This AIOMetadata doesn’t have PINs yet - add them without one, and set it once it’s updated.', 409)

  const config = await readConfig(access)
  const users = Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []
  const mainName = String(config.jellyfinUserName || config.addonName || '').toLowerCase()
  if ([mainName, ...users.map((u) => String(u?.name || '').toLowerCase())].includes(clean.toLowerCase())) throw fail(`There is already a household user called ${clean}`)
  let id = clean.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user'
  if (!ID.test(id) || users.some((u) => u?.id === id)) id = `${id.slice(0, 20)}-${crypto.randomBytes(3).toString('hex')}`.replace(/^-+/, '')
  config.jellyfinUsers = [...users, { id, name: clean, ...(lock ? { pin: lock } : {}) }]
  await writeConfig(access, config)

  const tracked = await signInOnce(prisma, encrypt, owner, { jellyfinUserId: userIdFor(access.uuid, id), name: clean }, access.password, lock)
  return { tracked }
}

/** Set or remove (pin null) a household user's PIN. Returns { tracked }. */
async function setUserPin(prisma, decrypt, encrypt, owner, profile, pin) {
  const access = accessFor(owner, decrypt)
  const lock = pin == null || pin === '' ? null : String(pin)
  if (lock && !PIN.test(lock)) throw fail('A PIN is 4 to 12 digits')
  if (!(await hasPins(owner))) throw fail('This AIOMetadata doesn’t have PINs yet - they come with its next release.', 409)
  const config = await readConfig(access)
  const users = Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []
  const user = users.find((u) => typeof u?.id === 'string' && userIdFor(access.uuid, u.id) === String(profile.jellyfinUserId || '').toLowerCase())
  if (!user) throw fail(`${profile.name} isn't a household user in this AIOMetadata configuration any more.`, 409)
  if (lock) user.pin = lock
  else delete user.pin
  await writeConfig(access, config)

  const tracked = await signInOnce(prisma, encrypt, owner, { jellyfinUserId: profile.jellyfinUserId, name: user.name }, access.password, lock)
  if (!tracked) await prisma.jellyfinProfile.update({ where: { id: profile.id }, data: { token: null, needsPin: !!lock } })
  return { tracked }
}

module.exports = { rememberAccess, canManage, hasPins, addUser, setUserPin, userIdFor, configOf }
