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
// This is the only thing SlickSync writes to an AIOStreams configuration. It
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
}

module.exports = { setProfileVariant, healProfileVariants, variantIdFor, slickTraxPreset, profileManifestUrl, VARIANT_PREFIX }
