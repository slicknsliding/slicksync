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

const { readConfig, writeConfig, rebaseline } = require('./aiostreamsConfig')

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
      throw fail(`The AIOStreams watch history link isn't in ${owner.username}'s AIOStreams configuration - add it there first.`, 409)
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

  await writeConfig(access, config)
  try {
    await rebaseline(prisma, owner, await readConfig(access))
  } catch (e) {
    console.warn('[AioProfileVariants] could not re-read the configuration after saving:', e?.message)
  }
}

module.exports = { setProfileVariant, variantIdFor, slickTraxPreset, profileManifestUrl, VARIANT_PREFIX }
