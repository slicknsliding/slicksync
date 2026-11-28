// Stremio profiles and the people they count for.
//
// A Stremio account can hold several profiles. Unlike Nuvio, where every
// profile shares one login, each Stremio profile is a sign-in of its own:
// the account's key can list the profiles and ask Stremio for any one's own
// key (with its PIN, when it has one), and that key reads and writes only
// that profile's addons and library.
//
// So the account's sign-in here only ever sees the main profile. This keeps
// what Stremio says about the others (StremioProfile rows), holds a key for
// each one that can be opened, and tells the activity read which of them to
// read and for whom. Whose viewing a profile is follows the same rules as a
// Nuvio profile - utils/nuvioProfiles.js, under the group key from
// groupKey() - so the Profiles card works the same for both.

const API = 'https://api.strem.io/api/'
const TIMEOUT_MS = 15000
// How often the activity read asks Stremio which profiles an account has.
const DISCOVER_EVERY_MS = 6 * 60 * 60 * 1000
// A look that failed - Stremio not answering, say - is tried again sooner.
const DISCOVER_RETRY_MS = 10 * 60 * 1000

// Stremio profiles carry a picture, not a color; tiles get one by slot.
const TILE_COLORS = ['#8b7ec8', '#5fd4c4', '#fb7185', '#fbbf24', '#60a5fa', '#34d399']

const groupKey = (stremioAccountId) => `stremio:${stremioAccountId}`
const isGroupKey = (key) => typeof key === 'string' && key.startsWith('stremio:')
const accountIdOfKey = (key) => (isGroupKey(key) ? key.slice('stremio:'.length) : null)
const colorForSlot = (slot) => TILE_COLORS[(Math.max(1, Number(slot) || 1) - 1) % TILE_COLORS.length]

/** One call to Stremio's API; resolves to its result or throws its message. */
async function call(method, body) {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: method.split('/').pop(), ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  let json = null
  try { json = await res.json() } catch { /* not JSON: handled below */ }
  if (json?.error) {
    const err = new Error(json.error.message || `Stremio refused ${method}`)
    err.code = json.error.code
    throw err
  }
  if (!res.ok || !json) throw new Error(`Stremio did not answer ${method} (${res.status})`)
  return json.result
}

/**
 * What a sign-in key belongs to: the account's id and its profiles, main
 * first. A key that is itself a profile's key says so instead (isProfileKey).
 */
async function readAccount(authKey) {
  const user = await call('getUser', { authKey })
  if (!user?._id) throw new Error('Stremio did not say whose sign-in this is')
  if (user.parent_id) return { id: user.parent_id, isProfileKey: true, profileId: user._id, profiles: [], limit: 0 }
  const listed = user.premiumPrefs?.userProfiles && typeof user.premiumPrefs.userProfiles === 'object' ? user.premiumPrefs.userProfiles : {}
  const profiles = Object.entries(listed).map(([profileId, p]) => ({
    profileId,
    name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : null,
    hasPin: p?.hasPin === true,
    canManageAddons: p?.canManageAddons !== false,
    isMain: profileId === user._id,
  }))
  // An account that has never opened profiles lists none; it still has its main one.
  if (!profiles.some((p) => p.isMain)) profiles.unshift({ profileId: user._id, name: null, hasPin: false, canManageAddons: true, isMain: true })
  profiles.sort((a, b) => Number(b.isMain) - Number(a.isMain))
  return { id: user._id, isProfileKey: false, profiles, limit: Number(user.features?.profiles) || 0 }
}

/** A profile's own sign-in key, asked for with the account's key. */
async function profileKey(authKey, profileId, pin = null) {
  const result = await call('premiumPrefs/authenticateProfile', { authKey, profileId, pin: pin || null })
  if (!result?.authKey) throw new Error('Stremio did not give a key for that profile')
  return result.authKey
}

const isAuthFailure = (message) => /session does not exist|unauthori[sz]ed|invalid auth| 401/i.test(message || '')
const isWrongPin = (error) => /pin/i.test(error?.message || '')

function crypt(accountId) {
  const { encrypt, decrypt } = require('./encryption')
  const req = { appAccountId: accountId }
  return { enc: (v) => encrypt(v, req), dec: (v) => decrypt(v, req) }
}

/** The lowest slot from 2 up that no row and no person on the account holds. */
function freeSlot(taken) {
  let slot = 2
  while (taken.has(slot)) slot++
  return slot
}

/**
 * Bring the StremioProfile rows for one account's sign-in in line with what
 * Stremio lists now, and fetch a key for every profile that can be opened
 * without asking (no PIN, or a PIN already given). Returns the account and
 * its rows, main first - or null for a key that belongs to a profile.
 */
async function syncProfiles(prisma, { accountId, mainUser, authKey }) {
  const account = await readAccount(authKey)
  if (account.isProfileKey) return null
  const { enc, dec } = crypt(accountId)

  if (mainUser.stremioAccountId !== account.id) {
    await prisma.user.update({ where: { id: mainUser.id }, data: { stremioAccountId: account.id } })
    mainUser.stremioAccountId = account.id
  }

  const where = { accountId, stremioAccountId: account.id }
  const [existing, people] = await Promise.all([
    prisma.stremioProfile.findMany({ where }),
    prisma.user.findMany({ where: { accountId, providerType: 'stremio', stremioAccountId: account.id }, select: { id: true, nuvioProfileId: true, stremioProfileId: true } }),
  ])
  const byProfile = new Map(existing.map((r) => [r.profileId, r]))
  const live = new Set(account.profiles.map((p) => p.profileId))

  // Gone from Stremio: forget it, unless a person here was made for it.
  for (const row of existing) {
    if (live.has(row.profileId) || people.some((p) => p.stremioProfileId === row.profileId)) continue
    await prisma.stremioProfile.delete({ where: { id: row.id } })
    byProfile.delete(row.profileId)
  }
  // Slots in use: the rows that are left, and every person on the account.
  const taken = new Set([1, ...[...byProfile.values()].map((r) => r.slot), ...people.map((p) => Number(p.nuvioProfileId) || 1)])

  const rows = []
  for (const p of account.profiles) {
    let row = byProfile.get(p.profileId)
    const facts = { name: p.name, hasPin: p.hasPin, canManageAddons: p.canManageAddons }
    if (!row) {
      const slot = p.isMain ? 1 : freeSlot(taken)
      taken.add(slot)
      row = await prisma.stremioProfile.create({ data: { ...where, profileId: p.profileId, slot, ...facts } })
    } else if (row.name !== facts.name || row.hasPin !== facts.hasPin || row.canManageAddons !== facts.canManageAddons) {
      row = await prisma.stremioProfile.update({ where: { id: row.id }, data: facts })
    }
    if (!p.isMain && !row.authKey && (!row.hasPin || row.pin)) {
      try {
        const key = await profileKey(authKey, p.profileId, row.pin ? dec(row.pin) : null)
        row = await prisma.stremioProfile.update({ where: { id: row.id }, data: { authKey: enc(key) } })
      } catch (e) {
        // A changed PIN: the stored one is no use any more.
        if (row.pin && isWrongPin(e)) row = await prisma.stremioProfile.update({ where: { id: row.id }, data: { pin: null } })
        console.warn(`[StremioProfiles] Could not open profile ${row.slot} of ${mainUser.id}:`, e.message)
      }
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.slot - b.slot)
  return { account, rows }
}

/** Open a PIN profile: check the PIN with Stremio, keep the key and the PIN. */
async function unlockProfile(prisma, { accountId, authKey, row, pin }) {
  const { enc } = crypt(accountId)
  let key
  try {
    key = await profileKey(authKey, row.profileId, pin)
  } catch (e) {
    if (isAuthFailure(e.message)) throw e
    throw Object.assign(new Error("That PIN didn't open the profile. Check it and try again."), { status: 400 })
  }
  return prisma.stremioProfile.update({ where: { id: row.id }, data: { authKey: enc(key), pin: enc(String(pin)) } })
}

/** The main profile's person on a Stremio account here, or null. */
async function mainPersonOf(prisma, accountId, stremioAccountId) {
  if (!stremioAccountId) return null
  const rows = await prisma.user.findMany({
    where: { accountId, providerType: 'stremio', stremioAccountId, stremioProfileId: null },
    orderBy: { createdAt: 'asc' },
  })
  return rows.find((r) => r.stremioAuthKey) || null
}

/**
 * A profile's person whose key stopped working: ask Stremio for a new one
 * with the account's key. True when they have a working key again.
 */
async function refreshPersonKey(prisma, accountId, person) {
  if (!person?.stremioProfileId || !person.stremioAccountId) return false
  const { enc, dec } = crypt(accountId)
  try {
    const main = await mainPersonOf(prisma, accountId, person.stremioAccountId)
    if (!main) return false
    const row = await prisma.stremioProfile.findFirst({ where: { accountId, stremioAccountId: person.stremioAccountId, profileId: person.stremioProfileId } })
    if (row?.hasPin && !row.pin) return false
    const key = await profileKey(dec(main.stremioAuthKey), person.stremioProfileId, row?.pin ? dec(row.pin) : null)
    await prisma.user.update({ where: { id: person.id }, data: { stremioAuthKey: enc(key) } })
    if (row) await prisma.stremioProfile.update({ where: { id: row.id }, data: { authKey: enc(key) } })
    return true
  } catch (e) {
    console.warn(`[StremioProfiles] Could not renew the key for ${person.id}:`, e.message)
    return false
  }
}

/** A merged profile's stored key was refused: drop it so the next look asks again. */
async function dropKey(prisma, rowId) {
  try { await prisma.stremioProfile.update({ where: { id: rowId }, data: { authKey: null } }) } catch { /* row already gone */ }
}

const isMainSignIn = (u) => (u.providerType || 'stremio') === 'stremio' && !!u.stremioAuthKey && !u.stremioProfileId

const lastDiscovery = new Map()

/**
 * Ask Stremio which profiles each Stremio sign-in on this account has - on
 * the first read after a start and every few hours after that, never on
 * every pass. A sign-in Stremio refuses is left for the library read to
 * report; nothing here marks anyone as disconnected.
 */
async function discover(prisma, accountId, users, now = Date.now()) {
  const { dec } = crypt(accountId)
  for (const user of users.filter(isMainSignIn)) {
    const last = lastDiscovery.get(user.id) || 0
    if (now - last < DISCOVER_EVERY_MS) continue
    lastDiscovery.set(user.id, now)
    try {
      await syncProfiles(prisma, { accountId, mainUser: user, authKey: dec(user.stremioAuthKey) })
    } catch (e) {
      lastDiscovery.set(user.id, now - DISCOVER_EVERY_MS + DISCOVER_RETRY_MS)
      console.warn(`[StremioProfiles] Could not read the profiles of ${user.id}:`, e.message)
    }
  }
}

/**
 * The profiles the activity read should read as well as the people: every
 * profile with a key and no person of its own that counts for someone. Each
 * comes back shaped like a person, under an id of its own so its progress
 * baselines stay apart, recorded for its owner and labelled with its name.
 */
async function trackedLogins(prisma, accountId, users) {
  const np = require('./nuvioProfiles')
  const out = []
  const accountIds = [...new Set(users.filter(isMainSignIn).map((u) => u.stremioAccountId).filter(Boolean))]
  for (const stremioAccountId of accountIds) {
    const rows = await prisma.stremioProfile.findMany({ where: { accountId, stremioAccountId, slot: { gt: 1 }, authKey: { not: null } } })
    if (!rows.length) continue
    const key = groupKey(stremioAccountId)
    const [siblings, routes] = await Promise.all([np.loadSiblings(prisma, accountId, key), np.loadRoutes(prisma, accountId, key)])
    for (const row of rows) {
      if (siblings.some((s) => np.profileOf(s) === row.slot)) continue
      const ownerId = np.ownerOf(row.slot, siblings, routes)
      const owner = ownerId && users.find((u) => u.id === ownerId)
      if (!owner) continue
      out.push({
        ...owner,
        id: `sp-${row.id}`,
        providerType: 'stremio',
        stremioAuthKey: row.authKey,
        stremioProfileId: row.profileId,
        providerConnectionError: null,
        providerConnectionErrorAt: null,
        __recordAs: owner.id,
        __profileLabel: row.name || `Profile ${row.slot}`,
        __stremioProfileRowId: row.id,
      })
    }
  }
  return out
}

/** A library as read with a profile's key, every title marked with the profile's name. */
function labelLibrary(library, label) {
  if (!label || !Array.isArray(library)) return library
  return library.map((item) => (item && typeof item === 'object' ? { ...item, state: { ...(item.state || {}), profileLabel: label } } : item))
}

/** How many profiles each Stremio account here has, for the Users page. */
async function profileCounts(prisma, accountId) {
  const rows = await prisma.stremioProfile.groupBy({ by: ['stremioAccountId'], where: { accountId }, _count: { _all: true } })
  return new Map(rows.map((r) => [r.stremioAccountId, r._count._all]))
}

module.exports = {
  groupKey,
  isGroupKey,
  accountIdOfKey,
  colorForSlot,
  readAccount,
  profileKey,
  syncProfiles,
  unlockProfile,
  mainPersonOf,
  refreshPersonKey,
  dropKey,
  discover,
  trackedLogins,
  labelLibrary,
  profileCounts,
  isMainSignIn,
  freeSlot,
  _resetDiscovery: () => lastDiscovery.clear(),
}
