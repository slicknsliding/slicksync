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
// A household user can be kept separate (AIOStreams 2.36): hidden from the
// sign-in picker and everyone else's list, with a sign-in address of their own
// (<instance>/jellyfin/p/<code>). Both live on the persona, so SlickSync only
// sets or removes those two fields, the same way as a PIN.
//
// Not the main user's own PIN: that is SlickSync's sign-in to the whole
// configuration.

const { safeFetch, instancePolicy } = require('./safeUrl')
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

// Whether an AIOStreams is protected - it only saves configuration changes
// made while signed in on its own page, so SlickSync can't make them - and
// where that page is. Its public status says so; checked now and then.
const protectedSeen = new Map()
const PROTECTED_TTL_MS = 10 * 60 * 1000

async function protectedPage(owner) {
  if (owner?.jellyfinServerKind !== 'aiostreams') return null
  const base = instanceBase(owner.jellyfinServerUrl)
  if (!base) return null
  const hit = protectedSeen.get(base)
  if (hit && Date.now() - hit.at < PROTECTED_TTL_MS) return hit.page
  let page = null
  try {
    const res = await safeFetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(15000) }, instancePolicy())
    const body = await res.json()
    if (body?.data?.settings?.protected === true) page = `${base}/stremio/configure`
  } catch { /* unknown: offered as usual, and a refusal says why */ }
  protectedSeen.set(base, { at: Date.now(), page })
  return page
}

async function maxPersonas(owner) {
  try {
    const res = await safeFetch(`${instanceBase(owner.jellyfinServerUrl)}/api/v1/status`, { signal: AbortSignal.timeout(15000) }, instancePolicy())
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
  const signed = await profiles.signInAs(owner.jellyfinServerUrl, names, jellyfinUserId, secret, profiles.handToHolders(prisma, encrypt, owner.jellyfinServerUrl)).catch(() => ({ token: null }))
  await profiles.saveHousehold(prisma, encrypt, owner, [{
    jellyfinUserId,
    name,
    loginName: signed.loginName || names.join('\n') || name,
    token: signed.token || null,
    needsPin: !signed.token && !!pin,
  }])
  return !!signed.token
}

const ADDRESS_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A personal sign-in address code: 10 random letters and digits (what
 * AIOStreams' own page makes), different from every one already in use in
 * this configuration.
 */
function newAddress(personas) {
  const used = new Set(personas.map((p) => p?.address).filter(Boolean))
  for (;;) {
    let code = ''
    for (let i = 0; i < 10; i++) code += ADDRESS_CHARS[crypto.randomInt(ADDRESS_CHARS.length)]
    if (!used.has(code)) return code
  }
}

function personalInfo(owner, persona) {
  const separate = persona.hidden === true
  const address = separate && persona.address ? String(persona.address) : null
  return { separate, address, url: address ? `${instanceBase(owner.jellyfinServerUrl)}/jellyfin/p/${address}` : null }
}

/**
 * For each household user SlickSync holds a profile for: whether they are
 * kept separate and where their personal address is. Read from the
 * configuration, because a separate user does not show in the server's user
 * list. Returns { [profileId]: { separate, address, url } }, or null when the
 * configuration can't be read or SlickSync has no access to it.
 */
async function personalSettings(decrypt, owner, profiles) {
  if (!canManage(owner)) return null
  try {
    const config = await readConfig(accessFor(owner, decrypt))
    const uuid = config.uuid || owner.aioConfigId
    const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
    const out = {}
    for (const profile of profiles) {
      const persona = personas.find((p) => personaUserId(uuid, p.id) === profile.jellyfinUserId)
      if (persona) out[profile.id] = personalInfo(owner, persona)
    }
    return out
  } catch (e) {
    console.warn('[AioHousehold] could not read personal addresses:', e?.message)
    return null
  }
}

/** Add a household user. Returns { tracked } - whether it is tracked already. */
async function addPersona(prisma, decrypt, encrypt, owner, { name, pin, history, separate }) {
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
  const persona = { id, name: clean, history: mode, ...(lock ? { lock } : {}), ...(separate === true ? { hidden: true, address: newAddress(personas) } : {}) }
  config.jellyfin.personas = [...personas, persona]
  await save(prisma, owner, access, config)

  const tracked = await signInOnce(prisma, encrypt, owner, { jellyfinUserId: personaUserId(uuid, id), name: clean }, access.password, lock)
  return { tracked, ...(persona.hidden ? { personal: personalInfo(owner, persona) } : {}) }
}

/**
 * Keep a household user separate (own sign-in address, seen by nobody else),
 * stop, or give them a new address - mode 'on', 'off' or 'renew'. Only that
 * user's hidden and address change; the rest goes back as it was read. The
 * old address stops answering with a renewal or with 'off'. SlickSync's own
 * sign-in for them is a token, which keeps working. Returns the user's
 * { separate, address, url }.
 */
async function setPersonaSeparation(prisma, decrypt, owner, profile, mode) {
  if (!['on', 'off', 'renew'].includes(mode)) throw fail('Choose on, off or renew')
  const access = accessFor(owner, decrypt)
  const config = await readConfig(access)
  const uuid = config.uuid || owner.aioConfigId
  const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
  const persona = personas.find((p) => personaUserId(uuid, p.id) === profile.jellyfinUserId)
  if (!persona) throw fail(`${profile.name} isn't a household user in this AIOStreams configuration any more.`, 409)
  if (mode === 'renew' && persona.hidden !== true) throw fail(`${persona.name} isn't kept separate, so there is no address to renew.`, 409)

  const already = persona.hidden === true && !!persona.address
  if (mode === 'on' && already) return personalInfo(owner, persona)
  if (mode === 'off' && persona.hidden !== true && !persona.address) return personalInfo(owner, persona)
  if (mode === 'off') {
    delete persona.hidden
    delete persona.address
  } else {
    persona.hidden = true
    persona.address = newAddress(personas)
  }
  await save(prisma, owner, access, config)
  return personalInfo(owner, persona)
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

module.exports = { protectedPage, addPersona, setPersonaPin, setPersonaSeparation, personalSettings, personaUserId, canManage }
