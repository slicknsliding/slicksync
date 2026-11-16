// Pausing someone's streaming on AIOMetadata - a daily limit or a bedtime
// (utils/screenTime.js).
//
// AIOMetadata finds what to play by asking a stream addon: the configuration's
// own (jellyfinStreamUrl) for its main user, and for a household user their
// own one when they have it (jellyfinUsers[].streamUrl), else the main one.
// A pause points the person's users at SlickSync's "paused" addon
// (/trax/paused, routes/traxAddon.js), which has nothing to play for any
// title. Catalogs and browsing stay; the next thing they press play on finds
// nothing. AIOMetadata keeps what it found for up to three minutes (3.5+), so
// a pause takes hold within that; lifting it is immediate.
//
// Pausing the main user changes the configuration's own address, which every
// household user without one of their own also uses - so each of those is
// first given a copy of the address as it was, and that copy is taken away
// again when the pause ends. Ending a pause only puts back what still holds
// SlickSync's own value: anything the household changed meanwhile is theirs.
//
// Needs the configuration password (aioConfigId / aioConfigPassword, kept at
// sign-in by aiometadataHousehold.rememberAccess); for a household user
// separated into a person of their own, the password of the person whose
// configuration it is. Household users merged into a person pause with them.

const { configOf, userIdFor, readConfig, writeConfig } = require('./aiometadataHousehold')

const OWNER_SELECT = {
  id: true, username: true, accountId: true, providerType: true, jellyfinServerUrl: true, jellyfinServerKind: true,
  jellyfinUserId: true, aioConfigId: true, aioConfigPassword: true,
}

function fail(message, status = 409) {
  return Object.assign(new Error(message), { status })
}

const plainId = (id) => String(id || '').replace(/-/g, '').toLowerCase()

/**
 * Whose configuration a pause is written to, and which of its users are this
 * person (as Jellyfin user ids): { owner, users } - or null when SlickSync
 * can't write to it.
 */
async function pauseAccess(prisma, accountId, person) {
  // A household user merged into a person, with limits of their own
  // (screenSubjects.js): just them, on their person's configuration.
  if (person.subject?.kind === 'household') {
    const owner = await prisma.user.findFirst({ where: { id: person.subject.ownerId, accountId }, select: OWNER_SELECT })
    if (!owner || owner.jellyfinServerKind !== 'aiometadata' || !owner.aioConfigId || !owner.aioConfigPassword && configOf(owner.jellyfinServerUrl)) return null
    return { owner, users: [plainId(person.subject.jellyfinUserId)] }
  }
  const me = await prisma.user.findFirst({ where: { id: person.id, accountId }, select: OWNER_SELECT })
  if (!me || me.providerType !== 'jellyfin' || me.jellyfinServerKind !== 'aiometadata') return null
  if (me.aioConfigId && me.aioConfigPassword && configOf(me.jellyfinServerUrl)) {
    // Household users merged into them watch as them, so they pause with them -
    // except those with limits of their own, who follow their own.
    const merged = await prisma.jellyfinProfile.findMany({ where: { ownerUserId: me.id, ownUserId: null, skip: false }, select: { id: true, jellyfinUserId: true } })
    const { cfg } = await require('./screenTime').readSync(prisma, accountId).catch(() => ({ cfg: {} }))
    const own = (p) => !!cfg.screenTime?.[require('./screenSubjects').householdSubject(p.id)]
    return { owner: me, users: [...new Set([me.jellyfinUserId, ...merged.filter((p) => !own(p)).map((p) => p.jellyfinUserId)].filter(Boolean).map(plainId))] }
  }
  const profile = await prisma.jellyfinProfile.findFirst({ where: { ownUserId: me.id }, select: { ownerUserId: true, jellyfinUserId: true } })
  if (!profile) return null
  const owner = await prisma.user.findFirst({ where: { id: profile.ownerUserId, accountId }, select: OWNER_SELECT })
  if (!owner?.aioConfigId || !owner.aioConfigPassword || !configOf(owner.jellyfinServerUrl)) return null
  return { owner, users: [plainId(profile.jellyfinUserId)] }
}

/** SlickSync's "paused" stream addon, at the address AIOMetadata reaches it by. */
async function pausedAddress(prisma, accountId) {
  const base = await require('./serverAvatars').publicBase(prisma, accountId)
  // Without a known address of its own, an unreachable one still leaves
  // nothing to play - only with a vaguer message in the app.
  return `${base || 'http://slicksync.invalid'}/trax/paused/manifest.json`
}

/**
 * Pause (or end the pause of) a person on AIOMetadata. Pausing returns the
 * state to keep with the pause - which users were pointed away, what they
 * had before, and which household users were given a copy of the main
 * address - so ending it puts back exactly that.
 */
async function setAiomPaused(prisma, accountId, person, paused, { decrypt, state = null } = {}) {
  const found = await pauseAccess(prisma, accountId, person)
  if (!found) throw fail(`Pausing ${person.username || 'them'} needs the AIOMetadata configuration password - reconnect them with it.`)
  const { owner } = found
  const where = configOf(owner.jellyfinServerUrl)
  const dec = decrypt || require('./encryption').decrypt
  const access = { ...where, password: dec(owner.aioConfigPassword, { appAccountId: owner.accountId || accountId }) }
  const config = await readConfig(access)
  const uuid = owner.aioConfigId || where.uuid
  const users = Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []
  const idOf = (u) => userIdFor(uuid, u.id)

  if (paused) {
    const address = await pausedAddress(prisma, accountId)
    const out = { address, users: [], main: null }
    const targets = users.filter((u) => u && typeof u.id === 'string' && found.users.includes(idOf(u)))
    for (const u of targets) {
      out.users.push({ id: u.id, was: typeof u.streamUrl === 'string' ? u.streamUrl : null })
      u.streamUrl = address
    }
    if (found.users.includes(plainId(uuid))) {
      const was = typeof config.jellyfinStreamUrl === 'string' ? config.jellyfinStreamUrl : ''
      const pinned = []
      if (was.trim()) {
        for (const u of users) {
          if (!u || typeof u.id !== 'string' || targets.includes(u)) continue
          if (typeof u.streamUrl === 'string' && u.streamUrl.trim()) continue
          u.streamUrl = was
          pinned.push(u.id)
        }
      }
      out.main = { was, pinned }
      config.jellyfinStreamUrl = address
    }
    if (!out.users.length && !out.main) throw fail(`${person.username || 'They'} isn't a user in this AIOMetadata configuration any more.`)
    await writeConfig(access, config)
    return out
  }

  const s = state || {}
  const address = s.address
  for (const entry of Array.isArray(s.users) ? s.users : []) {
    const u = users.find((x) => x && x.id === entry.id)
    if (!u || u.streamUrl !== address) continue
    if (typeof entry.was === 'string' && entry.was) u.streamUrl = entry.was
    else delete u.streamUrl
  }
  if (s.main) {
    if (config.jellyfinStreamUrl === address) {
      if (s.main.was) config.jellyfinStreamUrl = s.main.was
      else delete config.jellyfinStreamUrl
    }
    for (const id of Array.isArray(s.main.pinned) ? s.main.pinned : []) {
      const u = users.find((x) => x && x.id === id)
      if (u && u.streamUrl === s.main.was) delete u.streamUrl
    }
  }
  await writeConfig(access, config)
  return null
}

/**
 * The configuration's main sign-in, for commands to its apps' screens: the
 * main user may command every profile's devices (AIOMetadata 4.0 lists and
 * reaches them all); a profile's own sign-in reaches only its own. Null when
 * there is none, or the server is older than 4.0 and passes nothing on.
 */
async function screensAccess(prisma, accountId, person, decrypt) {
  const found = await pauseAccess(prisma, accountId, person)
  if (!found) return null
  const row = await prisma.user.findFirst({ where: { id: found.owner.id, accountId }, select: { jellyfinServerUrl: true, jellyfinToken: true, jellyfinUserId: true } })
  if (!row?.jellyfinToken || !row.jellyfinServerUrl || !row.jellyfinUserId) return null
  if (!(await require('../providers/jellyfin').takesRemoteControl(row.jellyfinServerUrl, 'aiometadata'))) return null
  const dec = decrypt || require('./encryption').decrypt
  return { base: row.jellyfinServerUrl, userId: row.jellyfinUserId, token: dec(row.jellyfinToken, { appAccountId: found.owner.accountId || accountId }), users: found.users }
}

/** Whether "Stop what's playing" can work for them: AIOMetadata 4.0 and newer. */
async function canStopAiom(prisma, accountId, person) {
  // The version only; no sign-in is needed to know.
  const found = await pauseAccess(prisma, accountId, person)
  return !!found && require('../providers/jellyfin').takesRemoteControl(found.owner.jellyfinServerUrl, 'aiometadata')
}

/**
 * Their screens on AIOMetadata 4.0+ that are playing something: put a message
 * on each, and with `stop`, stop the playback - what a real Jellyfin server
 * does (screenTime.js messageJellyfinScreens). AIOMetadata takes the message
 * as a DisplayMessage command (it has no /Message). Returns how many screens
 * it reached; 0 on an older AIOMetadata.
 */
async function messageAiomScreens(prisma, accountId, person, { text, stop = false, decrypt } = {}) {
  const access = await screensAccess(prisma, accountId, person, decrypt)
  if (!access) return 0
  const { jfRequest, signInDeviceId } = require('../providers/jellyfinAuth')
  const deviceId = signInDeviceId(access.base, 'slicksync-screen-time')
  const call = (path, opts = {}) => jfRequest(access.base, path, { token: access.token, deviceId, ...opts })
  const sessions = await call(`/Sessions?${new URLSearchParams({ ControllableByUserId: access.userId, ActiveWithinSeconds: '600' })}`)
  const playing = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s?.Id && s.NowPlayingItem && s.SupportsRemoteControl && access.users.includes(plainId(s.UserId)))
  let reached = 0
  for (const s of playing) {
    const id = encodeURIComponent(s.Id)
    try {
      if (stop) await call(`/Sessions/${id}/Playing/Stop`, { method: 'POST' })
      await call(`/Sessions/${id}/Command`, { method: 'POST', body: { Name: 'DisplayMessage', Arguments: { Header: 'SlickSync', Text: text, TimeoutMs: '15000' } } })
      reached++
    } catch (e) {
      console.warn(`[ScreenTime] could not reach an AIOMetadata screen of ${person.id}:`, e?.message)
    }
  }
  return reached
}

module.exports = { pauseAccess, setAiomPaused, pausedAddress, messageAiomScreens, canStopAiom }
