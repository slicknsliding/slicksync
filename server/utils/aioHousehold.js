// Adding AIOStreams household users, and changing or removing their PINs,
// from the household card - for people added with their configuration
// password (the only way AIOStreams' user API lets anyone write).
//
// A household user is a persona in the configuration
// (config.jellyfin.personas: { id, name, history: own | shared, lock? }).
// Writing one follows the same sequence as every other write to a
// configuration (aiostreamsConfig.js): read, report outside changes, write,
// re-baseline. AIOStreams replaces the whole configuration on save, so
// everything else - other personas' PIN hashes included - goes back exactly
// as it was read; a new PIN is sent plain and AIOStreams hashes it.
//
// Profiles are matched to personas by id, never by name (a rename would
// break that): AIOStreams gives each persona the Jellyfin user id
// sha256("jellyfin-persona:<config uuid>:<persona id>"), first 32 hex - the
// same id the profile row already holds.
//
// A new household user is tracked straight away: signed in once with the
// configuration password (and its PIN). After a PIN change it is signed in
// once again with the new PIN, so SlickSync holds a sign-in that matches it
// (AIOStreams 2.35 keeps existing sign-ins through a PIN change, but that is
// not something to lean on). Once, never retried: five wrong PINs pause a
// household user for 15 minutes.
//
// Not the main user's own PIN: that is SlickSync's sign-in to the whole
// configuration.

const crypto = require('crypto')
const { readConfig, writeConfig, rebaseline, noteOutsideChanges, instanceBase } = require('./aiostreamsConfig')

const PIN = /^\d{4,12}$/
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

/** AIOStreams' own Jellyfin user id for a persona. */
function personaUserId(configUuid, personaId) {
  return crypto.createHash('sha256').update(`jellyfin-persona:${configUuid}:${personaId}`).digest('hex').slice(0, 32)
}

function canManage(owner) {
  return owner?.providerType === 'jellyfin' && owner.jellyfinServerKind === 'aiostreams' && !!owner.aioConfigId && !!owner.aioConfigPassword
}

function accessFor(owner, decrypt) {
  if (!canManage(owner)) {
    throw fail(`SlickSync needs ${owner?.username || 'their'}'s AIOStreams configuration password for this - reconnect them with it.`, 409)
  }
  return {
    serverUrl: owner.jellyfinServerUrl,
    account: owner.aioConfigId,
    password: decrypt(owner.aioConfigPassword, { appAccountId: owner.accountId || 'default' }),
  }
}

async function save(prisma, owner, access, config) {
  try {
    await noteOutsideChanges(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioHousehold] could not compare with the last look:', e?.message)
  }
  try {
    await writeConfig(access, config)
  } catch (e) {
    throw fail(e?.message || 'AIOStreams refused the change', 409)
  }
  try {
    await rebaseline(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioHousehold] could not re-read the configuration after saving:', e?.message)
  }
}

async function maxPersonas(owner) {
  try {
    const res = await fetch(`${instanceBase(owner.jellyfinServerUrl)}/api/v1/status`, { signal: AbortSignal.timeout(15000) })
    const body = await res.json()
    return Number(body?.data?.settings?.jellyfin?.maxPersonas) || 0
  } catch {
    return 0
  }
}

/** Sign one household user in, once, and keep the sign-in on their profile. */
async function signInOnce(prisma, encrypt, owner, { jellyfinUserId, name }, password, pin) {
  const profiles = require('./jellyfinProfiles')
  const names = profiles.loginNamesFor('aiostreams', owner.jellyfinServerUrl, owner.aioConfigId, { name })
  const secret = pin ? `${password}/${pin}` : password
  const signed = await profiles.signInAs(owner.jellyfinServerUrl, names, jellyfinUserId, secret).catch(() => ({ token: null }))
  await profiles.saveHousehold(prisma, encrypt, owner, [{
    jellyfinUserId,
    name,
    loginName: signed.loginName || names.join('\n') || name,
    token: signed.token || null,
    needsPin: !signed.token && !!pin,
  }])
  return !!signed.token
}

/** Add a household user. Returns { tracked } - whether it is tracked already. */
async function addPersona(prisma, decrypt, encrypt, owner, { name, pin, history }) {
  const access = accessFor(owner, decrypt)
  const clean = String(name || '').trim()
  if (!clean || clean.length > 32) throw fail('A name is 1 to 32 characters')
  const lock = pin == null || pin === '' ? null : String(pin)
  if (lock && !PIN.test(lock)) throw fail('A PIN is 4 to 12 digits')
  const mode = history === 'shared' ? 'shared' : 'own'

  const config = await readConfig(access)
  const uuid = config.uuid || owner.aioConfigId
  config.jellyfin = config.jellyfin && typeof config.jellyfin === 'object' ? config.jellyfin : {}
  const personas = Array.isArray(config.jellyfin.personas) ? config.jellyfin.personas : []
  const taken = [config.jellyfin.primary?.name, ...personas.map((p) => p.name)].filter(Boolean).map((n) => String(n).toLowerCase())
  if (taken.includes(clean.toLowerCase())) throw fail(`There is already a household user called ${clean}`)
  const max = await maxPersonas(owner)
  if (max > 0 && personas.length >= max) throw fail(`This AIOStreams allows ${max} household users, and there are ${personas.length} already.`, 409)

  let id = clean.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user'
  if (!ID.test(id) || personas.some((p) => p.id === id)) id = `${id.slice(0, 20)}-${crypto.randomBytes(3).toString('hex')}`.replace(/^-+/, '')
  // Never trackers on a shared one: it uses the main user's.
  const persona = { id, name: clean, history: mode, ...(lock ? { lock } : {}) }
  config.jellyfin.personas = [...personas, persona]
  await save(prisma, owner, access, config)

  const tracked = await signInOnce(prisma, encrypt, owner, { jellyfinUserId: personaUserId(uuid, id), name: clean }, access.password, lock)
  return { tracked }
}

/** Change a household user's PIN, or remove it (pin null). Returns { tracked }. */
async function setPersonaPin(prisma, decrypt, encrypt, owner, profile, pin) {
  const access = accessFor(owner, decrypt)
  const lock = pin == null || pin === '' ? null : String(pin)
  if (lock && !PIN.test(lock)) throw fail('A PIN is 4 to 12 digits')

  const config = await readConfig(access)
  const uuid = config.uuid || owner.aioConfigId
  const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
  const persona = personas.find((p) => personaUserId(uuid, p.id) === profile.jellyfinUserId)
  if (!persona) throw fail(`${profile.name} isn't a household user in this AIOStreams configuration any more.`, 409)
  if (lock) persona.lock = lock
  else delete persona.lock
  await save(prisma, owner, access, config)

  const tracked = await signInOnce(prisma, encrypt, owner, { jellyfinUserId: profile.jellyfinUserId, name: persona.name }, access.password, lock)
  // The old sign-in stopped working with the change; without a new one the
  // card asks for the PIN rather than holding a dead token.
  if (!tracked) {
    await prisma.jellyfinProfile.update({ where: { id: profile.id }, data: { token: null, needsPin: !!lock } })
  }
  return { tracked }
}

module.exports = { addPersona, setPersonaPin, personaUserId, canManage }
