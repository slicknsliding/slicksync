// AIOStreams and AIOMetadata household users, as profiles.
//
// An AIOStreams or AIOMetadata configuration is a Jellyfin-compatible server
// with a user for everyone in the household, all behind the one
// configuration password - much like a Nuvio account and its profiles. So a
// person added with their sign-in brings the rest of the household along as
// profiles: SlickSync signs each of them in while it has the password (it is
// never stored), keeps each one's token, and reads their viewing as this
// person's, labelled with the profile's name. A profile can then be
// separated into its own person, merged back, or left untracked - the same
// choices Nuvio profiles have.
//
// A real Jellyfin server has no such thing: its users are separate accounts
// with their own passwords, each added as their own person.

const jfAuth = require('../providers/jellyfinAuth')
const { migrateTable, runMembershipTransaction } = require('./userMerge')
const { moveProfileHistory } = require('./nuvioProfiles')

const HOUSEHOLD_KINDS = new Set(['aiostreams', 'aiometadata'])

function hasHousehold(kind) {
  return HOUSEHOLD_KINDS.has(kind)
}

function isPlainAddress(serverUrl) {
  try { return /\/jellyfin$/i.test(new URL(serverUrl).pathname.replace(/\/+$/, '')) } catch { return false }
}

/**
 * The names a household user might sign in as, most likely first. On
 * AIOStreams' plain address the configuration is named in the user name:
 * its main user signs in as the configuration UUID (or alias) alone, everyone
 * else as "<uuid>/Sam". Which one is the main user is not marked anywhere, so
 * both are tried and the one that signs in as that very user is kept. On a
 * sign-in picker address, and on AIOMetadata, the plain name is enough. So is
 * it at a personal address (/jellyfin/p/<code>), which is not a plain address
 * and lists only that one person.
 */
function loginNamesFor(kind, serverUrl, account, user) {
  if (kind !== 'aiostreams' || !isPlainAddress(serverUrl)) return [user.name]
  if (!account) return []
  return [`${account}/${user.name}`, account]
}

/** The configuration part of what someone typed to sign in: "<uuid>" from "<uuid>/Sam". */
function accountOf(typedLogin) {
  const typed = String(typedLogin || '').trim()
  if (!typed) return null
  return typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/')) : typed
}

/**
 * What to do with each sign-in made on the way: hand it to everyone holding
 * that server user (jellyfinConnect.rememberSignIn). Signing a household user
 * in retires the token they held for this device, and the name tried second
 * on AIOStreams is the main user's own, so every sign-in counts, not only
 * the one that is kept.
 */
function handToHolders(prisma, encrypt, serverUrl) {
  return (signed) => require('./jellyfinConnect').rememberSignIn(prisma, encrypt, { serverUrl }, signed)
}

/**
 * Sign one household user in, trying each possible name; the first that is
 * really them wins. `onSignIn(signed)` hears of every successful sign-in.
 */
async function signInAs(serverUrl, names, userId, secret, onSignIn) {
  let pinNeeded = false
  for (const name of names) {
    try {
      const signed = await jfAuth.authenticateByName(serverUrl, name, secret)
      if (typeof onSignIn === 'function') await Promise.resolve(onSignIn(signed)).catch(() => {})
      if (signed.userId === userId) return { token: signed.token, loginName: name }
    } catch (e) {
      if (e?.pinNeeded) pinNeeded = true
    }
  }
  return { token: null, loginName: null, pinNeeded }
}

/**
 * Sign in everyone else in the household, with the password just used when
 * there is one. Users that need a PIN, or that would not sign in, come back
 * without a token so the household card can offer to finish them.
 */
async function signInHousehold({ probe, login, password, typedLogin, onSignIn, skip = null }) {
  if (!hasHousehold(probe.kind)) return []
  let users = []
  try {
    users = await jfAuth.listServerUsers(probe.serverUrl, login.token)
  } catch (e) {
    console.warn('[JellyfinProfiles] Could not list the household:', e?.message)
    return []
  }
  const account = accountOf(typedLogin)
  const out = []
  for (const user of users.filter((u) => u.id !== login.userId && !(skip && skip.has(u.id)))) {
    const names = loginNamesFor(probe.kind, probe.serverUrl, account, user)
    // On AIOStreams, a user that can't sign in automatically is one with a PIN,
    // and isn't tried: wrong guesses count towards its lockout, and the
    // household card asks for the PIN instead. AIOMetadata marks every user
    // that way, PIN or not, so there the sign-in itself is the test.
    const pinHint = probe.kind === 'aiostreams' && user.needsPin === true
    const entry = { jellyfinUserId: user.id, name: user.name, loginName: names[0] || null, token: null, needsPin: pinHint }
    if (names.length && password != null && !entry.needsPin) {
      const signed = await signInAs(probe.serverUrl, names, user.id, password, onSignIn)
      if (signed.token) { entry.token = signed.token; entry.loginName = signed.loginName }
      else if (signed.pinNeeded) entry.needsPin = true
    }
    // Which name a PIN user answers to is only known once they sign in; the
    // household card tries the same names in the same order.
    if (!entry.token && names.length > 1) entry.loginName = names.join('\n')
    out.push(entry)
  }
  return out
}

/**
 * Rows that are not a real household profile. A person separated out of a
 * household signs in at the same configuration, so their own household check
 * listed everyone there again - the person they were separated from included -
 * and built a second household that mirrors the first, with the original owner
 * "Separated" in it. A row is such an echo when its owner was already someone
 * else's profile (separated) before the row existed. Older data has them; they
 * are ignored when reading, and tidied away by repairEchoedHouseholds.
 */
function echoRows(rows, memberRows) {
  const since = new Map()
  for (const m of memberRows) {
    const at = new Date(m.createdAt).getTime()
    if (!since.has(m.ownUserId) || at < since.get(m.ownUserId).at) since.set(m.ownUserId, { at, ownerUserId: m.ownerUserId })
  }
  return rows.filter((r) => {
    const s = since.get(r.ownerUserId)
    return s && s.at < new Date(r.createdAt).getTime()
  }).map((r) => ({ row: r, trueOwnerId: since.get(r.ownerUserId).ownerUserId }))
}

async function memberRowsOf(prisma, ownerIds) {
  if (!ownerIds.length) return []
  return prisma.jellyfinProfile.findMany({ where: { ownUserId: { in: ownerIds } }, select: { ownUserId: true, ownerUserId: true, createdAt: true } })
}

/** The rows that really belong to these owners' households. */
async function withoutEchoes(prisma, rows) {
  const owners = [...new Set(rows.map((r) => r.ownerUserId))]
  const echoes = new Set(echoRows(rows, await memberRowsOf(prisma, owners)).map((e) => e.row.id))
  return echoes.size ? rows.filter((r) => !echoes.has(r.id)) : rows
}

/** True when this person is a separated profile of someone else's household. */
async function isSeparatedMember(prisma, userId) {
  const mine = await prisma.jellyfinProfile.findMany({ where: { ownUserId: userId } })
  if (!mine.length) return false
  return (await withoutEchoes(prisma, mine)).length > 0
}

/**
 * Tidy the echoes of separated people's households. Only a row that repeats
 * what the real household already has is removed: the person it names, or a
 * server user the real owner's household lists too. Idempotent; returns how
 * many went.
 */
async function repairEchoedHouseholds(prisma, accountId) {
  const members = await prisma.jellyfinProfile.findMany({ where: { accountId, ownUserId: { not: null } } })
  if (!members.length) return 0
  const echoes = echoRows(await prisma.jellyfinProfile.findMany({ where: { accountId, ownerUserId: { in: [...new Set(members.map((m) => m.ownUserId))] } } }), members)
  if (!echoes.length) return 0
  const trueRows = await prisma.jellyfinProfile.findMany({ where: { accountId, ownerUserId: { in: [...new Set(echoes.map((e) => e.trueOwnerId))] } }, select: { ownerUserId: true, jellyfinUserId: true } })
  const have = new Set(trueRows.map((t) => `${t.ownerUserId}:${t.jellyfinUserId}`))
  const redundant = echoes.filter((e) => e.row.ownUserId === e.trueOwnerId || have.has(`${e.trueOwnerId}:${e.row.jellyfinUserId}`)).map((e) => e.row.id)
  if (!redundant.length) return 0
  const { count } = await prisma.jellyfinProfile.deleteMany({ where: { id: { in: redundant } } })
  return count
}

/**
 * Keep the household on the person. A profile someone already separated into
 * their own person stays theirs, and an untracked one stays untracked; only
 * the sign-in is refreshed.
 */
async function saveHousehold(prisma, encrypt, owner, household) {
  const accountId = owner.accountId || 'default'
  for (const p of household) {
    const token = p.token ? encrypt(p.token, { appAccountId: accountId }) : null
    const existing = await prisma.jellyfinProfile.findUnique({
      where: { ownerUserId_jellyfinUserId: { ownerUserId: owner.id, jellyfinUserId: p.jellyfinUserId } },
    })
    if (existing) {
      await prisma.jellyfinProfile.update({
        where: { id: existing.id },
        data: { name: p.name, loginName: p.loginName || existing.loginName, needsPin: p.token ? false : p.needsPin, ...(token ? { token } : {}) },
      })
      // A separated profile's person reads with its own sign-in; keep it fresh too.
      if (existing.ownUserId && token) {
        await prisma.user.updateMany({ where: { id: existing.ownUserId, providerType: 'jellyfin' }, data: { jellyfinToken: token, providerConnectionError: null, providerConnectionErrorAt: null } })
      }
    } else {
      // Someone already here as their own person (added on their own before)
      // is that person, not a profile.
      const own = await prisma.user.findFirst({
        where: { accountId, providerType: 'jellyfin', jellyfinUserId: p.jellyfinUserId, jellyfinServerUrl: owner.jellyfinServerUrl },
        select: { id: true },
      })
      await prisma.jellyfinProfile.create({
        data: { accountId, ownerUserId: owner.id, jellyfinUserId: p.jellyfinUserId, name: p.name, loginName: p.loginName || null, token, needsPin: p.token ? false : p.needsPin, ownUserId: own?.id || null },
      })
    }
  }
}

/**
 * Household users added since: someone added on AIOStreams' or AIOMetadata's
 * own page (a protected AIOStreams only takes them there) shows up here by
 * itself. Only users not known yet are signed in, so nobody's sign-in is
 * disturbed. Returns how many were found.
 */
/**
 * The configuration's main user, as the first profile on the household card:
 * the name the server has for them (cached a while), and their limits are
 * the person's own.
 */
const mainNames = new Map()
async function describeMain(decrypt, owner) {
  if (!owner || owner.providerType !== 'jellyfin' || !hasHousehold(owner.jellyfinServerKind)) return null
  const hit = mainNames.get(owner.id)
  let name = hit && Date.now() - hit.at < 20 * 1000 ? hit.name : null
  if (!name && owner.jellyfinToken) {
    try {
      const me = await jfAuth.currentUser(owner.jellyfinServerUrl, decrypt(owner.jellyfinToken, { appAccountId: owner.accountId || 'default' }), { timeoutMs: 8000 })
      name = me.userName || null
    } catch { /* the stored name will do */ }
    if (name) mainNames.set(owner.id, { at: Date.now(), name })
  }
  // An AIOStreams main user signs in with the configuration UUID; never show that.
  const stored = owner.jellyfinUserName && !/^[0-9a-f-]{32,36}$/i.test(owner.jellyfinUserName) ? owner.jellyfinUserName : null
  return { name: name || stored || owner.username, avatarUrl: owner.avatarUrl || null, limitId: owner.id }
}

const lastLook = new Map()
async function refreshHousehold(prisma, decrypt, encrypt, owner, { minIntervalMs = 0 } = {}) {
  if (!owner || owner.providerType !== 'jellyfin' || !hasHousehold(owner.jellyfinServerKind) || !owner.jellyfinToken) return 0
  // A separated person belongs to the household they came from; they do not start another.
  if (await isSeparatedMember(prisma, owner.id)) return 0
  const at = lastLook.get(owner.id) || 0
  if (minIntervalMs && Date.now() - at < minIntervalMs) return 0
  lastLook.set(owner.id, Date.now())
  const seal = { appAccountId: owner.accountId || 'default' }
  const known = await prisma.jellyfinProfile.findMany({ where: { ownerUserId: owner.id }, select: { jellyfinUserId: true } })
  const found = await signInHousehold({
    probe: { serverUrl: owner.jellyfinServerUrl, kind: owner.jellyfinServerKind },
    login: { token: decrypt(owner.jellyfinToken, seal), userId: owner.jellyfinUserId },
    password: owner.aioConfigPassword ? decrypt(owner.aioConfigPassword, seal) : null,
    typedLogin: owner.aioConfigId || null,
    onSignIn: handToHolders(prisma, encrypt, owner.jellyfinServerUrl),
    skip: new Set(known.map((k) => k.jellyfinUserId)),
  })
  if (found.length) await saveHousehold(prisma, encrypt, owner, found)
  return found.length
}

let refreshTimer = null
function scheduleHouseholdRefresh(prisma, decrypt, encrypt) {
  if (refreshTimer) clearInterval(refreshTimer)
  const run = async () => {
    try {
      const owners = await prisma.user.findMany({ where: { providerType: 'jellyfin', isActive: true, jellyfinToken: { not: null }, jellyfinServerKind: { in: [...HOUSEHOLD_KINDS] } } })
      for (const accountId of new Set(owners.map((o) => o.accountId || 'default'))) {
        try {
          const n = await repairEchoedHouseholds(prisma, accountId)
          if (n) console.log(`[JellyfinProfiles] tidied ${n} repeated household row(s)`)
        } catch (e) { console.warn('[JellyfinProfiles] household tidy failed:', e?.message) }
      }
      for (const o of owners) {
        try {
          mainNames.delete(o.id)
          const n = await refreshHousehold(prisma, decrypt, encrypt, o)
          if (n) console.log(`[JellyfinProfiles] ${n} new household user(s) for ${o.username}`)
        } catch (e) { console.warn(`[JellyfinProfiles] household check for ${o.username} failed:`, e?.message) }
      }
    } catch (e) { console.warn('[JellyfinProfiles] household check failed:', e?.message) }
  }
  // Every 20 seconds: someone added on the server's own page, or a renamed
  // main user, shows up here almost at once. One small read of the server's
  // user list per person - nobody is signed in again unless they're new.
  setTimeout(run, 20 * 1000)
  refreshTimer = setInterval(run, 20 * 1000)
}

/**
 * Someone is being deleted: the household they brought (and the sign-ins it
 * holds) goes with them, and a profile that had been separated into them stops
 * being tracked rather than quietly counting for its old owner again.
 */
async function forgetPersonHousehold(prisma, userId) {
  try {
    await prisma.jellyfinProfile.deleteMany({ where: { ownerUserId: userId } })
    await prisma.jellyfinProfile.updateMany({ where: { ownUserId: userId }, data: { ownUserId: null, skip: true } })
  } catch (e) {
    console.warn('[JellyfinProfiles] Could not clear the household of a deleted person:', e?.message)
  }
}

/** A profile whose sign-in stopped working waits for a fresh one on the household card. */
async function forgetProfileSignIn(prisma, profileId) {
  await prisma.jellyfinProfile.update({ where: { id: profileId }, data: { token: null } }).catch(() => {})
}

/** The profiles this person reads, with decrypted sign-ins, for the provider. */
async function trackedProfiles(prisma, decrypt, userId) {
  const rows = await withoutEchoes(prisma, await prisma.jellyfinProfile.findMany({
    where: { ownerUserId: userId, skip: false, ownUserId: null, token: { not: null } },
  }))
  const out = []
  for (const r of rows) {
    try {
      out.push({ id: r.id, jellyfinUserId: r.jellyfinUserId, name: r.name, token: decrypt(r.token, { appAccountId: r.accountId }) })
    } catch { /* a token from a rotated key; the person page offers a fresh sign-in */ }
  }
  return out
}

/** The household as the person page shows it. */
async function describeHousehold(prisma, userId) {
  const rows = await withoutEchoes(prisma, await prisma.jellyfinProfile.findMany({ where: { ownerUserId: userId }, orderBy: { name: 'asc' } }))
  const people = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.ownUserId).filter(Boolean) } },
    select: { id: true, username: true },
  })
  const byId = new Map(people.map((p) => [p.id, p]))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.ownUserId && byId.has(r.ownUserId) ? 'own' : r.skip ? 'untracked' : !r.token ? (r.needsPin ? 'needs-pin' : 'needs-sign-in') : 'tracked',
    person: r.ownUserId && byId.has(r.ownUserId) ? { id: r.ownUserId, username: byId.get(r.ownUserId).username } : null,
    avatarUrl: r.avatarUrl || null,
    // Whose limits its Limits pill opens: its own person's, or its own as a
    // household user merged into this one (screenSubjects.js).
    limitId: r.ownUserId && byId.has(r.ownUserId) ? r.ownUserId : require('./screenSubjects').householdSubject(r.id),
  }))
}

/** Track a profile again, or stop. */
async function setTracked(prisma, profile, tracked) {
  await prisma.jellyfinProfile.update({ where: { id: profile.id }, data: { skip: !tracked } })
}

/** Finish a profile that needs a PIN, or a password after a Quick Connect add. */
async function signInProfile(prisma, encrypt, { profile, owner, password, pin }) {
  const names = String(profile.loginName || profile.name).split('\n').filter(Boolean)
  const secret = pin ? `${password || ''}/${pin}` : (password || '')
  const signed = await signInAs(owner.jellyfinServerUrl, names, profile.jellyfinUserId, secret, handToHolders(prisma, encrypt, owner.jellyfinServerUrl))
  if (!signed.token) {
    throw Object.assign(new Error(signed.pinNeeded ? 'That PIN did not work' : 'Wrong password'), { status: 400 })
  }
  await prisma.jellyfinProfile.update({
    where: { id: profile.id },
    data: { token: encrypt(signed.token, { appAccountId: owner.accountId || 'default' }), loginName: signed.loginName, needsPin: false },
  })
}

/**
 * Separate a profile into its own person: they get the profile's sign-in, the
 * owner's groups, and everything watched on that profile so far.
 */
async function separateProfile(prisma, { profile, owner }) {
  if (profile.ownUserId) throw Object.assign(new Error('That profile is already its own person'), { status: 400 })
  if (!profile.token) throw Object.assign(new Error('Sign this profile in first'), { status: 400 })
  const accountId = owner.accountId || 'default'
  let username = profile.name
  for (let attempt = 1; await prisma.user.findFirst({ where: { accountId, username } }); attempt++) {
    if (attempt > 100) throw Object.assign(new Error('Pick a different name first'), { status: 409 })
    username = `${profile.name}${attempt}`
  }
  let created
  let moved = { movies: 0, episodes: 0, activity: 0 }
  await runMembershipTransaction(prisma, accountId, async (tx) => {
    created = await tx.user.create({
      data: {
        accountId,
        username,
        email: jfAuth.identityEmail(owner.jellyfinServerUrl, profile.jellyfinUserId),
        providerType: 'jellyfin',
        jellyfinServerUrl: owner.jellyfinServerUrl,
        jellyfinServerId: owner.jellyfinServerId,
        jellyfinServerKind: owner.jellyfinServerKind,
        jellyfinUserId: profile.jellyfinUserId,
        jellyfinUserName: profile.name,
        jellyfinToken: profile.token,
        isActive: true,
        colorIndex: ((owner.colorIndex || 0) + 1) % 10,
      },
    })
    moved = await moveProfileHistory(tx, { accountId, fromUserId: owner.id, toUserId: created.id, profileLabel: profile.name })
    // The new person joins the owner's group.
    const ownerGroup = await tx.group.findFirst({ where: { accountId, userIds: { contains: owner.id } }, select: { id: true } })
    if (ownerGroup) await require('./helpers/database').moveIntoGroup(tx, accountId, created.id, ownerGroup.id)
    await tx.jellyfinProfile.update({ where: { id: profile.id }, data: { ownUserId: created.id, skip: false } })
  })
  return { person: { id: created.id, username }, moved }
}

/**
 * Merge a separated profile's person back into the person whose household it
 * is: everything they recorded moves across, labelled with the profile so a
 * later Separate takes it with them again, and the person leaves the Users
 * list. Their sign-in goes back to the profile.
 */
async function mergeProfileBack(prisma, { profile, owner }) {
  const accountId = owner.accountId || 'default'
  const person = profile.ownUserId ? await prisma.user.findFirst({ where: { id: profile.ownUserId, accountId } }) : null
  if (!person) throw Object.assign(new Error('That profile has no person of its own'), { status: 400 })
  await runMembershipTransaction(prisma, accountId, async (tx) => {
    // Label first, so the profile can take its viewing with it again later.
    await tx.watchActivity.updateMany({ where: { userId: person.id, profileLabel: null }, data: { profileLabel: profile.name } })
    await tx.movieWatchHistory.updateMany({ where: { userId: person.id, profileLabel: null }, data: { profileLabel: profile.name } })
    await tx.episodeWatchHistory.updateMany({ where: { userId: person.id, profileLabel: null }, data: { profileLabel: profile.name } })
    await tx.watchActivity.updateMany({ where: { userId: person.id }, data: { userId: owner.id } })
    // migrateTable records what it moved for an undo; a merge back is undone by separating again.
    const archive = { donorRows: {}, overwrittenSurvivorRows: {} }
    await migrateTable(tx, 'movieWatchHistory', owner.id, person.id, 'watchedAt', (row) => ({ userId: owner.id, accountId: row.accountId, itemId: row.itemId }), { archive })
    await migrateTable(tx, 'episodeWatchHistory', owner.id, person.id, 'watchedAt', (row) => ({ userId: owner.id, accountId: row.accountId, videoId: row.videoId }), { archive })
    // Progress baselines are per sign-in, and the profile keeps its own
    // through the owner's read from now on; the person's are not needed.
    await tx.watchSnapshot.deleteMany({ where: { userId: person.id } })
    await tx.watchSession.deleteMany({ where: { userId: person.id } })
    await tx.dismissedContinueWatching.deleteMany({ where: { userId: person.id } })
    await require('./helpers/database').dropFromAllGroups(tx, accountId, person.id)
    await tx.jellyfinProfile.update({
      where: { id: profile.id },
      data: { ownUserId: null, skip: false, ...(person.jellyfinToken ? { token: person.jellyfinToken, needsPin: false } : {}) },
    })
    await tx.user.delete({ where: { id: person.id } })
  })
  try { require('./jellyfinLive').forgetUser(person.id) } catch {}
  return { mergedInto: owner.id, removed: { id: person.id, username: person.username } }
}

module.exports = { describeMain,
  echoRows,
  isSeparatedMember,
  repairEchoedHouseholds, refreshHousehold, scheduleHouseholdRefresh,
  forgetPersonHousehold,
  forgetProfileSignIn,
  hasHousehold,
  loginNamesFor,
  signInAs,
  handToHolders,
  signInHousehold,
  saveHousehold,
  trackedProfiles,
  describeHousehold,
  setTracked,
  signInProfile,
  separateProfile,
  mergeProfileBack,
}
