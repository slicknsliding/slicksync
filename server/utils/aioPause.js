// Pausing someone's streaming on AIOStreams - a daily limit or a bedtime
// (utils/screenTime.js).
//
// AIOStreams can't switch one person off, but it has variants: small patches
// to the configuration, applied while a given user is signed in. A pause adds
// SlickSync's "slicksync-pause" variant, which takes the stream out of every
// addon that offers one - an addon that only plays streams is switched off,
// one that also has catalogs keeps them - and gives it to the person's users
// in the configuration: the user they sign in as, and any household user
// merged into them. Ending the pause takes it away again, and drops the
// variant once nobody has it. The apps still open and browse; the next thing
// they press play on finds nothing to play.
//
// Like every write to a configuration (aiostreamsConfig.js): read, report
// outside changes, write, re-baseline - and only SlickSync's own variant and
// the references to it are touched. Needs the configuration password; for a
// household user separated into a person of their own, the password of the
// person whose configuration it is.

const { readConfig, writeConfig, rebaseline, noteOutsideChanges, instanceBase } = require('./aiostreamsConfig')
const { personaUserId } = require('./aioHousehold')

const PAUSE_VARIANT = 'slicksync-pause'
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
 * person: { owner, users } - or null when SlickSync can't write to it.
 */
async function pauseAccess(prisma, accountId, person) {
  // A household user merged into a person, with limits of their own
  // (screenSubjects.js): just them, on their person's configuration.
  if (person.subject?.kind === 'household') {
    const owner = await prisma.user.findFirst({ where: { id: person.subject.ownerId, accountId }, select: OWNER_SELECT })
    if (!owner || owner.jellyfinServerKind !== 'aiostreams' || !owner.aioConfigId || !owner.aioConfigPassword) return null
    return { owner, users: [plainId(person.subject.jellyfinUserId)] }
  }
  const me = await prisma.user.findFirst({ where: { id: person.id, accountId }, select: OWNER_SELECT })
  if (!me || me.providerType !== 'jellyfin' || me.jellyfinServerKind !== 'aiostreams') return null
  if (me.aioConfigId && me.aioConfigPassword) {
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
  if (!owner?.aioConfigId || !owner.aioConfigPassword) return null
  return { owner, users: [plainId(profile.jellyfinUserId)] }
}

/** AIOStreams' own list of what each kind of addon offers: preset type -> resources. */
async function presetResources(base) {
  try {
    const res = await fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(15000) })
    const body = await res.json()
    const list = body?.data?.settings?.presets || body?.data?.presets || []
    return new Map((Array.isArray(list) ? list : []).map((p) => [p?.ID, Array.isArray(p?.SUPPORTED_RESOURCES) ? p.SUPPORTED_RESOURCES : []]))
  } catch {
    return new Map()
  }
}

async function manifestResources(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const manifest = await res.json()
    return (Array.isArray(manifest?.resources) ? manifest.resources : []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The variant's lines: each addon that plays streams loses them. Built from
 * the configuration as it is when the pause starts; an addon added during a
 * pause is caught the next time one starts.
 */
async function pauseScript(base, config) {
  const known = await presetResources(base)
  const lines = []
  for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
    if (!preset?.instanceId || preset.enabled === false) continue
    const chosen = Array.isArray(preset.options?.resources) && preset.options.resources.length ? preset.options.resources : null
    let resources = chosen || known.get(preset.type) || []
    const manifestUrl = preset.options?.manifestUrl || preset.options?.url
    if (!chosen && !resources.length && typeof manifestUrl === 'string' && manifestUrl) resources = await manifestResources(manifestUrl)
    if (!resources.includes('stream')) continue
    const rest = resources.filter((r) => r !== 'stream')
    const id = String(preset.instanceId)
    const at = `presets[instanceId=${/^[a-z0-9_-]+$/i.test(id) ? id : JSON.stringify(id)}]`
    lines.push(rest.length ? `set ${at}.options.resources = ${JSON.stringify(rest)}` : `disable ${at}`)
  }
  return lines.length ? lines.join('\n') : '# No addon here plays streams.'
}

/** The configuration's user objects for these Jellyfin user ids. */
function usersIn(config, uuid, ids) {
  config.jellyfin = config.jellyfin && typeof config.jellyfin === 'object' ? config.jellyfin : {}
  const out = []
  if (ids.includes(plainId(uuid))) {
    config.jellyfin.primary = config.jellyfin.primary && typeof config.jellyfin.primary === 'object' ? config.jellyfin.primary : {}
    out.push(config.jellyfin.primary)
  }
  for (const p of Array.isArray(config.jellyfin.personas) ? config.jellyfin.personas : []) {
    if (ids.includes(personaUserId(uuid, p.id))) out.push(p)
  }
  return out
}

const refsOf = (user) => (Array.isArray(user?.variants) ? user.variants : [])

/**
 * Pause (or end the pause of) a person on AIOStreams. Pausing returns
 * { users } - the Jellyfin user ids it was given to, kept with the pause so
 * ending it reaches the same users even if the household changed meanwhile.
 */
async function setAioPaused(prisma, accountId, person, paused, { decrypt, users: earlier = [] } = {}) {
  const found = await pauseAccess(prisma, accountId, person)
  if (!found) throw fail(`Pausing ${person.username || 'them'} needs the AIOStreams configuration password - reconnect them with it.`)
  const { owner } = found
  const dec = decrypt || require('./encryption').decrypt
  const access = {
    serverUrl: owner.jellyfinServerUrl,
    account: owner.aioConfigId,
    password: dec(owner.aioConfigPassword, { appAccountId: owner.accountId || accountId }),
  }
  const config = await readConfig(access)
  const uuid = config.uuid || owner.aioConfigId
  const ids = paused ? found.users : [...new Set([...found.users, ...(earlier || []).map(plainId)])]
  const targets = usersIn(config, uuid, ids)
  const variants = Array.isArray(config.variants) ? config.variants : []

  if (paused) {
    if (!targets.length) throw fail(`${person.username || 'They'} isn't a user in this AIOStreams configuration any more.`)
    const variant = { id: PAUSE_VARIANT, name: 'SlickSync - streaming paused', script: await pauseScript(instanceBase(owner.jellyfinServerUrl), config) }
    config.variants = variants.some((v) => v.id === PAUSE_VARIANT) ? variants.map((v) => (v.id === PAUSE_VARIANT ? variant : v)) : [...variants, variant]
    // Last, so it applies after their own variants.
    for (const user of targets) user.variants = [...refsOf(user).filter((id) => id !== PAUSE_VARIANT), PAUSE_VARIANT]
  } else {
    for (const user of targets) {
      const refs = refsOf(user).filter((id) => id !== PAUSE_VARIANT)
      if (refs.length) user.variants = refs
      else delete user.variants
    }
    const j = config.jellyfin || {}
    const stillUsed = [j.primary, ...(Array.isArray(j.personas) ? j.personas : [])].some((u) => refsOf(u).includes(PAUSE_VARIANT))
    if (!stillUsed) {
      config.variants = variants.filter((v) => v.id !== PAUSE_VARIANT)
      if (!config.variants.length) delete config.variants
    }
    if (j.primary && !Object.keys(j.primary).length) delete j.primary
  }

  try {
    await noteOutsideChanges(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioPause] could not compare with the last look:', e?.message)
  }
  try {
    await writeConfig(access, config)
  } catch (e) {
    throw fail(e?.message || 'AIOStreams refused the change')
  }
  try {
    await rebaseline(prisma, owner, await readConfig(access), paused ? 'pause' : 'unpause')
  } catch (e) {
    console.warn('[AioPause] could not re-read the configuration after saving:', e?.message)
  }
  return { users: ids }
}

module.exports = { setAioPaused, pauseAccess, pauseScript, PAUSE_VARIANT }
