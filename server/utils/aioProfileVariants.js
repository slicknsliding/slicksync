// A household profile's own AIOStreams collections, set up in AIOStreams.
//
// AIOStreams loads collections once per configuration and doesn't say which
// profile is asking, so SlickSync can't tell profiles apart on its own link.
// What AIOStreams does have is variants - small patches to the configuration
// applied while one profile is signed in. When the household gives a profile
// collections of its own, SlickSync adds a variant to that profile which
// points SlickTrax at the profile's own link (/trax/<token>/aio/p/<profile
// id>/, see routes/traxAddon.js). Watch history on that link works as on the
// plain one; only the collections differ.
//
// These variants (and the one for a household user's own AIOMetadata rows,
// further down) are the only things SlickSync writes to an AIOStreams configuration. It
// touches only variants with its own id prefix and the profile's reference to
// them, keeps everything else exactly as read, and re-reads the configuration
// afterwards so the change warning (utils/aiostreamsConfig.js) stays quiet.

const { readConfig, writeConfig, rebaseline, noteOutsideChanges } = require('./aiostreamsConfig')

const VARIANT_PREFIX = 'slicksync-'

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

/** The variant id for one profile: AIOStreams allows 1-32 of [a-z0-9_-]. */
function variantIdFor(personaId) {
  const slug = String(personaId || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 32 - VARIANT_PREFIX.length)
  return `${VARIANT_PREFIX}${slug || 'profile'}`
}

/** The SlickTrax entry in a configuration: the addon whose link is this person's. */
function slickTraxPreset(config, token) {
  const needle = `/trax/${token}/aio/`
  return (Array.isArray(config?.presets) ? config.presets : []).find((p) => {
    const url = String(p?.options?.manifestUrl || p?.options?.url || '')
    return url.includes(needle) && !url.includes(`${needle}p/`)
  }) || null
}

/** The profile's own link, on whatever address the configuration already uses. */
function profileManifestUrl(presetUrl, token, profileId) {
  const needle = `/trax/${token}/aio/`
  const at = presetUrl.indexOf(needle)
  return `${presetUrl.slice(0, at)}${needle}p/${encodeURIComponent(profileId)}/manifest.json`
}

/**
 * Turn a profile's own collections on or off in AIOStreams. On: the profile
 * gets SlickSync's variant (added, or brought up to date). Off: it's removed.
 * Throws with a message for the household when it can't be done.
 */
async function setProfileVariant(prisma, decrypt, owner, profile, on) {
  if (!owner.aioConfigPassword || !owner.aioConfigId) {
    throw fail(`To give ${profile.name} collections of their own, SlickSync needs ${owner.username}'s AIOStreams configuration password - sign ${owner.username} in again with it.`, 409)
  }
  if (!owner.traxToken || !owner.watchStateEnabled) {
    throw fail(`${owner.username}'s AIOStreams watch history link is off - turn it on and add it to AIOStreams first.`, 409)
  }
  const access = {
    serverUrl: owner.jellyfinServerUrl,
    account: owner.aioConfigId,
    password: decrypt(owner.aioConfigPassword, { appAccountId: owner.accountId || 'default' }),
  }
  const config = await readConfig(access)
  const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
  const persona = personas.find((p) => String(p.name || '').trim().toLowerCase() === String(profile.name || '').trim().toLowerCase())
  if (!persona) throw fail(`${profile.name} isn't a household user in this AIOStreams configuration any more.`, 409)

  const variantId = variantIdFor(persona.id)
  const variants = Array.isArray(config.variants) ? config.variants : []
  const refs = Array.isArray(persona.variants) ? persona.variants : []

  if (on) {
    const preset = slickTraxPreset(config, owner.traxToken)
    if (!preset) {
      throw fail(`The AIOStreams watch history link isn't in ${owner.username}'s AIOStreams configuration - press "Add it to AIOStreams again" under AIOStreams watch history on their page first.`, 409)
    }
    const url = profileManifestUrl(String(preset.options.manifestUrl || preset.options.url), owner.traxToken, profile.id)
    const field = preset.options.manifestUrl !== undefined ? 'manifestUrl' : 'url'
    const variant = {
      id: variantId,
      name: `SlickSync - ${profile.name}'s collections`,
      script: `set presets[instanceId=${preset.instanceId}].options.${field} = ${JSON.stringify(url)}`,
    }
    const existing = variants.find((v) => v.id === variantId)
    if (existing && existing.script === variant.script && existing.enabled !== false && refs.includes(variantId)) return
    config.variants = existing ? variants.map((v) => (v.id === variantId ? variant : v)) : [...variants, variant]
    persona.variants = refs.includes(variantId) ? refs : [...refs, variantId]
  } else {
    if (!variants.some((v) => v.id === variantId) && !refs.includes(variantId)) return
    config.variants = variants.filter((v) => v.id !== variantId)
    if (!config.variants.length) delete config.variants
    persona.variants = refs.filter((id) => id !== variantId)
    if (!persona.variants.length) delete persona.variants
  }

  // Anything changed outside SlickSync since the last look is reported now -
  // the baseline this write leaves behind must only absorb SlickSync's edit.
  try {
    await noteOutsideChanges(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioProfileVariants] could not compare with the last look:', e?.message)
  }
  await writeConfig(access, config)
  try {
    await rebaseline(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioProfileVariants] could not re-read the configuration after saving:', e?.message)
  }
}

/**
 * Every profile with collections of its own keeps its variant pointed at the
 * SlickTrax link that is in AIOStreams now. Rotating a SlickTrax link gives it
 * a new address; once the new one is in AIOStreams, the old address in a
 * profile's variant would leave that profile without its collections and its
 * watch history. Checked with the change warning, every 30 minutes - a
 * variant that is already right costs one read and no write.
 */
async function healProfileVariants(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  for (const acc of accounts) {
    let cfg = acc.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    const byProfile = cfg?.aioCollections?.byProfile
    const ids = byProfile && typeof byProfile === 'object' ? Object.keys(byProfile).filter((id) => byProfile[id]) : []
    if (!ids.length) continue
    const profiles = await prisma.jellyfinProfile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ownerUserId: true } })
    for (const profile of profiles) {
      const owner = await prisma.user.findFirst({
        where: { id: profile.ownerUserId, accountId: acc.id, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
        select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true, watchStateEnabled: true, traxToken: true },
      })
      if (!owner) continue
      try {
        await setProfileVariant(prisma, decrypt, owner, profile, true)
      } catch (e) {
        // Most often: the new link isn't in AIOStreams yet. Next time, then.
        console.warn(`[AioProfileVariants] ${profile.name}'s variant not brought up to date:`, e?.message)
      }
    }
  }
  await healOwnRows(prisma, decrypt)
}

// ---------------------------------------------------------------------------
// Their own rows: AIOMetadata's Recommendations and lists, per household user.
//
// AIOMetadata answers a catalog read as a named household user when the
// catalog link carries ?viewer=<name> (a user card's name or slug, or a name
// under "Also known as (AIOStreams)"). AIOStreams passes an addon link's query
// on to every read, so a household user's row set is another variant, like the
// one above: while that user is signed in, the existing AIOMetadata addon's
// link gets ?viewer=<their name>. The addon is never added twice, only
// repointed. The household's choice is kept per profile in
// AppAccount.sync.aioAiometadataOwn[<profile id>], and the 30-minute check
// keeps the variant right, or takes it away when it can no longer work.

const { safeFetch, instancePolicy } = require('./safeUrl')

const AIOM_PREFIX = 'slicksync-aiom-'
const AIOM_FLAGS = 'aioAiometadataOwn'
const AIOM_FIRST_VERSION = [3, 8, 3] // newer than this (the dev build answers viewers before it has a number)
const SHORT_MS = 3000
const SUPPORT_TTL_MS = 10 * 60 * 1000
const MISS_TTL_MS = 60 * 1000
const CONFIG_TTL_MS = 60 * 1000

/** The variant id for one household user's rows: AIOStreams allows 1-32 of [a-z0-9][a-z0-9_-]. */
function aiometadataVariantId(personaId) {
  const slug = String(personaId || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || 'user'
  const room = 32 - AIOM_PREFIX.length
  if (slug.length <= room) return `${AIOM_PREFIX}${slug}`
  // Too long: a short stretch of it and a fingerprint of all of it, so two long ids never share a variant.
  const hash = require('crypto').createHash('sha1').update(String(personaId)).digest('hex').slice(0, 8)
  return `${AIOM_PREFIX}${slug.slice(0, room - 9)}-${hash}`
}

function presetUrl(preset) {
  return String(preset?.options?.manifestUrl || preset?.options?.url || '')
}

/**
 * The AIOMetadata addon in a configuration: the preset whose link ends in
 * /stremio/<id>/manifest.json, leaving out SlickSync's own /trax/ one.
 * Returns { preset, several }: none found is { preset: null, several: false };
 * more than one is { preset: null, several: true }.
 */
function aiometadataPreset(config) {
  const found = (Array.isArray(config?.presets) ? config.presets : []).filter((p) => {
    if (!p || p.enabled === false) return false
    const raw = presetUrl(p)
    if (!raw) return false
    let path
    try { path = new URL(raw).pathname } catch { return false }
    return !path.includes('/trax/') && /\/stremio\/[^/]+\/manifest\.json$/i.test(path)
  })
  return { preset: found.length === 1 ? found[0] : null, several: found.length > 1 }
}

/** The addon's link with ?viewer=<name> - any viewer already there replaced, the rest kept. */
function viewerManifestUrl(url, name) {
  const u = new URL(url)
  const kept = u.search.replace(/^\?/, '').split('&').filter((pair) => {
    if (!pair) return false
    let key = pair.split('=')[0]
    try { key = decodeURIComponent(key.replace(/\+/g, ' ')) } catch { /* keep as is */ }
    return key !== 'viewer'
  })
  kept.push(`viewer=${encodeURIComponent(name)}`)
  return `${u.origin}${u.pathname}?${kept.join('&')}`
}

function withTimeout(promise, ms = SHORT_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function aiomGet(url) {
  return safeFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(SHORT_MS) }, instancePolicy())
}

// Answers kept for a while: opening the household card must stay quick.
const supportSeen = new Map() // manifest link -> { at, ttl, value }
const nameSeen = new Map() // manifest link + name -> { at, ttl, value }
const configSeen = new Map() // owner id -> { at, value }

function cached(map, key) {
  const hit = map.get(key)
  return hit && Date.now() - hit.at < hit.ttl ? hit : null
}

function forgetOwnRowsChecks() {
  supportSeen.clear()
  nameSeen.clear()
  configSeen.clear()
}

/** The catalog link to probe: the first catalog in the manifest, with ?viewer=<name>. */
function probeUrl(manifestUrl, manifest, viewer) {
  const first = (Array.isArray(manifest?.catalogs) ? manifest.catalogs : []).find((c) => c && c.type && c.id)
  if (!first) return null
  const u = new URL(manifestUrl)
  const base = `${u.origin}${u.pathname.replace(/manifest\.json$/i, '')}`
  return `${base}catalog/${encodeURIComponent(first.type)}/${encodeURIComponent(first.id)}.json?viewer=${encodeURIComponent(viewer)}`
}

/** The HTTP status a catalog read answers, or null when it couldn't be asked. */
async function probeStatus(url) {
  try {
    const res = await aiomGet(url)
    try { await res.body?.cancel?.() } catch { /* the status is all that is wanted */ }
    return res.status
  } catch {
    return null
  }
}

async function readManifest(manifestUrl) {
  try {
    const res = await aiomGet(manifestUrl)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Whether this AIOMetadata answers per-person catalog reads: true, false, or
 * null when it couldn't be found out. There's no flag for it, so: a version
 * newer than 3.8.3, or a catalog read for a made-up viewer that is refused
 * with a 404 (it means the viewer is looked up - which needs user cards or
 * aliases; a 200 proves nothing, so is not taken as a no).
 */
async function aiometadataSupport(manifestUrl) {
  const key = manifestUrl.split('?')[0]
  const hit = cached(supportSeen, key)
  if (hit) return hit.value
  let value = null
  const manifest = await readManifest(manifestUrl)
  if (manifest) {
    const { parseVersion, isNewer } = require('./serverVersions')
    const v = parseVersion(manifest.version)
    if (v && isNewer(v, AIOM_FIRST_VERSION)) {
      value = true
    } else {
      const url = probeUrl(manifestUrl, manifest, `slicksync-probe-${require('crypto').randomBytes(4).toString('hex')}`)
      if (!url) value = false
      else {
        const status = await probeStatus(url)
        value = status === null ? null : status === 404
      }
    }
  }
  supportSeen.set(key, { at: Date.now(), ttl: value === null ? MISS_TTL_MS : SUPPORT_TTL_MS, value })
  return value
}

/**
 * Whether AIOMetadata knows this name: true, false, or null when it couldn't
 * be found out. An unknown viewer is a 404; anything else means it was found.
 */
async function aiometadataNameKnown(manifestUrl, name) {
  const key = `${manifestUrl.split('?')[0]}\n${String(name).toLowerCase()}`
  const hit = cached(nameSeen, key)
  if (hit) return hit.value
  let value = null
  const manifest = await readManifest(manifestUrl)
  const url = manifest ? probeUrl(manifestUrl, manifest, name) : null
  if (url) {
    const status = await probeStatus(url)
    value = status === null || status >= 500 ? null : status !== 404
  }
  nameSeen.set(key, { at: Date.now(), ttl: value === true ? SUPPORT_TTL_MS : MISS_TTL_MS, value })
  return value
}

/**
 * Where a household user stands: { state, preset?, url? } with state one of
 * ready, no-preset, several, unsupported, needs-name, unknown (AIOMetadata
 * couldn't be asked just now - nothing should change on that).
 */
async function assessOwnRows(config, persona) {
  const { preset, several } = aiometadataPreset(config)
  if (several) return { state: 'several' }
  if (!preset) return { state: 'no-preset' }
  const url = presetUrl(preset)
  const supported = await aiometadataSupport(url)
  if (supported === null) return { state: 'unknown' }
  if (!supported) return { state: 'unsupported' }
  const known = await aiometadataNameKnown(url, persona.name)
  if (known === null) return { state: 'unknown' }
  return known ? { state: 'ready', preset, url } : { state: 'needs-name' }
}

const OWN_ROWS_REFUSALS = (name) => ({
  'no-preset': 'AIOMetadata isn’t in this AIOStreams configuration.',
  several: 'There’s more than one AIOMetadata in this AIOStreams.',
  unsupported: 'This AIOMetadata doesn’t give people their own rows yet - it comes with its next release.',
  'needs-name': `AIOMetadata doesn’t know “${name}” yet. Add ${name} under Also known as (AIOStreams) in AIOMetadata, then turn this on.`,
  unknown: 'Couldn’t reach AIOMetadata just now - SlickSync will try again.',
})

function ownerAccess(owner, decrypt) {
  if (!owner.aioConfigPassword || !owner.aioConfigId) {
    throw fail(`To give ${owner.username}'s household their own rows, SlickSync needs ${owner.username}'s AIOStreams configuration password - sign ${owner.username} in again with it.`, 409)
  }
  return {
    serverUrl: owner.jellyfinServerUrl,
    account: owner.aioConfigId,
    password: decrypt(owner.aioConfigPassword, { appAccountId: owner.accountId || 'default' }),
  }
}

/** The household user in a configuration that a profile stands for - matched by id, never by name. */
function personaFor(config, owner, profile) {
  const { personaUserId } = require('./aioHousehold')
  const uuid = config?.uuid || owner.aioConfigId
  const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
  return personas.find((p) => personaUserId(uuid, p.id) === profile.jellyfinUserId) || null
}

async function commitConfig(prisma, owner, access, config) {
  // Same sequence as every write here: outside changes reported first, the
  // baseline afterwards only absorbs this edit.
  try {
    await noteOutsideChanges(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioProfileVariants] could not compare with the last look:', e?.message)
  }
  await writeConfig(access, config)
  try {
    await rebaseline(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioProfileVariants] could not re-read the configuration after saving:', e?.message)
  }
}

/**
 * Bring a household user's rows variant to the state asked for.
 * mode 'on': add it, or throw with a plain reason when it can't work.
 * mode 'off': take it away. mode 'heal': keep it right if it's wanted and can
 * work, take it away if it can no longer work, leave it be if AIOMetadata
 * couldn't be asked. Writes only when something differs.
 */
async function applyOwnRows(prisma, decrypt, owner, profile, mode) {
  const access = ownerAccess(owner, decrypt)
  const config = await readConfig(access)
  const persona = personaFor(config, owner, profile)
  if (!persona) {
    if (mode === 'on') throw fail(`${profile.name} isn't a household user in this AIOStreams configuration any more.`, 409)
    return
  }
  const variantId = aiometadataVariantId(persona.id)
  const variants = Array.isArray(config.variants) ? config.variants : []
  const refs = Array.isArray(persona.variants) ? persona.variants : []

  let want = null
  if (mode !== 'off') {
    const seen = await assessOwnRows(config, persona)
    if (seen.state === 'ready') want = seen
    else if (mode === 'on') throw fail(OWN_ROWS_REFUSALS(persona.name || profile.name)[seen.state], 409)
    else if (seen.state === 'unknown') return
  }

  if (want) {
    const field = want.preset.options.manifestUrl !== undefined ? 'manifestUrl' : 'url'
    const variant = {
      id: variantId,
      name: `SlickSync - ${persona.name || profile.name}'s own rows`,
      script: `set presets[instanceId=${want.preset.instanceId}].options.${field} = ${JSON.stringify(viewerManifestUrl(want.url, persona.name || profile.name))}`,
    }
    const existing = variants.find((v) => v.id === variantId)
    if (existing && existing.script === variant.script && existing.enabled !== false && refs.includes(variantId)) return
    config.variants = existing ? variants.map((v) => (v.id === variantId ? variant : v)) : [...variants, variant]
    persona.variants = refs.includes(variantId) ? refs : [...refs, variantId]
  } else {
    if (!variants.some((v) => v.id === variantId) && !refs.includes(variantId)) return
    config.variants = variants.filter((v) => v.id !== variantId)
    if (!config.variants.length) delete config.variants
    persona.variants = refs.filter((id) => id !== variantId)
    if (!persona.variants.length) delete persona.variants
  }
  await commitConfig(prisma, owner, access, config)
}

/** Give a household user their own rows (on) or the shared ones again (off) in AIOStreams. Throws with a reason for the household. */
function setOwnRowsVariant(prisma, decrypt, owner, profile, on) {
  return applyOwnRows(prisma, decrypt, owner, profile, on ? 'on' : 'off')
}

/** One profile's variant brought in line with its choice and whether it's tracked (the 30-minute check, for one). */
function syncOwnRows(prisma, decrypt, owner, profile) {
  return applyOwnRows(prisma, decrypt, owner, profile, profile.skip ? 'off' : 'heal')
}

/** The household's choices for an account: { [profile id]: true }. */
async function ownRowsChoices(prisma, accountId) {
  const { readSync } = require('./aioSlickTrax')
  const { cfg } = await readSync(prisma, accountId)
  const flags = cfg[AIOM_FLAGS]
  return flags && typeof flags === 'object' ? flags : {}
}

/** Keep (or forget, when off) the choice. Kept whether or not AIOStreams takes the change. */
async function saveOwnRowsChoice(prisma, accountId, profileId, on) {
  await require('./aioSlickTrax').patchMap(prisma, accountId, AIOM_FLAGS, profileId, on ? true : null)
}

/**
 * Every household user with rows of their own keeps their variant right, or
 * loses it when it can no longer work (no AIOMetadata in the configuration,
 * one that doesn't support it, a name it doesn't know) or when the profile
 * isn't tracked. The choice itself is kept, so it returns when it can work.
 * A profile that no longer exists loses its choice.
 */
async function healOwnRows(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true, sync: true } })
  for (const acc of accounts) {
    let cfg = acc.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
    const flags = cfg?.[AIOM_FLAGS]
    const ids = flags && typeof flags === 'object' ? Object.keys(flags).filter((id) => flags[id]) : []
    if (!ids.length) continue
    const profiles = await prisma.jellyfinProfile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ownerUserId: true, jellyfinUserId: true, skip: true } })
    for (const id of ids) {
      if (!profiles.some((p) => p.id === id)) await saveOwnRowsChoice(prisma, acc.id, id, false).catch(() => {})
    }
    for (const profile of profiles) {
      const owner = await prisma.user.findFirst({
        where: { id: profile.ownerUserId, accountId: acc.id, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
        select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true },
      })
      if (!owner) continue
      try {
        await syncOwnRows(prisma, decrypt, owner, profile)
      } catch (e) {
        console.warn(`[AioProfileVariants] ${profile.name}'s own rows not brought up to date:`, e?.message)
      }
    }
  }
}

/**
 * Someone with a household is being deleted: their household users lose the
 * rows SlickSync set up in their AIOStreams, and the choices go too. Called
 * before the person is removed, while their configuration can still be read.
 * Never stops the deletion.
 */
async function forgetOwnRows(prisma, decrypt, ownerId) {
  try {
    const owner = await prisma.user.findFirst({
      where: { id: ownerId, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
      select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true },
    })
    if (!owner) return
    const accountId = owner.accountId || 'default'
    const choices = await ownRowsChoices(prisma, accountId)
    const profiles = await prisma.jellyfinProfile.findMany({ where: { ownerUserId: ownerId }, select: { id: true, name: true, ownerUserId: true, jellyfinUserId: true, skip: true } })
    for (const profile of profiles.filter((p) => choices[p.id] === true)) {
      if (owner.aioConfigId && owner.aioConfigPassword) {
        await setOwnRowsVariant(prisma, decrypt, owner, profile, false)
          .catch((e) => console.warn(`[AioProfileVariants] ${profile.name}'s own rows not taken away:`, e?.message))
      }
      await saveOwnRowsChoice(prisma, accountId, profile.id, false).catch(() => {})
    }
  } catch (e) {
    console.warn('[AioProfileVariants] own rows of a deleted person not cleared:', e?.message)
  }
}

/** What the owner's configuration holds that matters here, read once a minute at most: { several, noPreset, names }. */
async function configFacts(decrypt, owner) {
  const hit = configSeen.get(owner.id)
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value
  const config = await withTimeout(readConfig(ownerAccess(owner, decrypt)))
  const { personaUserId } = require('./aioHousehold')
  const uuid = config?.uuid || owner.aioConfigId
  const { preset, several } = aiometadataPreset(config)
  const names = new Map()
  for (const p of Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []) names.set(personaUserId(uuid, p.id), p.name)
  const value = { several, url: preset ? presetUrl(preset) : null, names }
  configSeen.set(owner.id, { at: Date.now(), value })
  return value
}

/**
 * For the household card: { [profile id]: { available, on, reason? } } for the
 * profiles that are household users in the owner's AIOStreams. Empty when the
 * switch doesn't apply at all (no stored configuration password, no AIOMetadata,
 * one that doesn't support it, or it couldn't be checked quickly).
 */
async function describeOwnRows(prisma, decrypt, owner, rows) {
  const out = {}
  try {
    if (!owner || owner.providerType !== 'jellyfin' || owner.jellyfinServerKind !== 'aiostreams' || !owner.aioConfigPassword || !owner.aioConfigId) return out
    const facts = await configFacts(decrypt, owner)
    if (!facts.several && !facts.url) return out
    if (!facts.several && (await withTimeout(aiometadataSupport(facts.url), SHORT_MS + 1000)) !== true) return out
    const choices = await ownRowsChoices(prisma, owner.accountId || 'default').catch(() => ({}))
    const page = facts.several ? null : await require('./aioHousehold').protectedPage(owner)
    await Promise.all(rows.map(async (row) => {
      const name = facts.names.get(row.jellyfinUserId)
      if (name === undefined) return
      const on = choices[row.id] === true
      if (facts.several) { out[row.id] = { available: false, on, reason: 'several' }; return }
      if (page) { out[row.id] = { available: false, on, reason: 'protected' }; return }
      const known = await withTimeout(aiometadataNameKnown(facts.url, name), SHORT_MS + 1000).catch(() => null)
      if (known === null) return // couldn't be asked: no switch rather than a wrong one
      out[row.id] = known ? { available: true, on } : { available: false, on, reason: 'needs-name' }
    }))
  } catch (e) {
    console.warn('[AioProfileVariants] own rows not read:', e?.message)
    return {}
  }
  return out
}

module.exports = {
  setProfileVariant, healProfileVariants, variantIdFor, slickTraxPreset, profileManifestUrl, VARIANT_PREFIX,
  aiometadataPreset, aiometadataVariantId, viewerManifestUrl, aiometadataSupport, aiometadataNameKnown,
  setOwnRowsVariant, syncOwnRows, saveOwnRowsChoice, ownRowsChoices, healOwnRows, describeOwnRows, forgetOwnRowsChecks, forgetOwnRows, AIOM_PREFIX,
}
