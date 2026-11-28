// Where a Vault key is used: which of the account's addons carry it inside
// their address, and which people's AIOStreams configurations carry it.
// Read-only and local for addons; the AIOStreams side reads configurations
// (utils/aiostreamsConfig.js) and is cut off after a few seconds.
//
// The matching is the key rotation's own (utils/keyRotation.js), so "used by"
// and "will be rewritten when the key changes" always agree.

const { urlCarriesSecret, MIN_SECRET_LENGTH } = require('./keyRotation')

/**
 * The text that identifies an entry's key inside other places. Usenet
 * providers keep a { username, password } login: the password is what travels.
 * Notes carry no key (null).
 */
function matchableSecret(category, plain) {
  if (category === 'note' || typeof plain !== 'string' || !plain) return null
  if (category === 'usenet_provider') {
    try {
      const parsed = JSON.parse(plain)
      if (parsed && typeof parsed === 'object') return typeof parsed.password === 'string' && parsed.password ? parsed.password : null
    } catch { /* a plain text secret is matched as it is */ }
  }
  return plain
}

/** The ids of the addons (of those given as { id, url }) whose address carries the secret. */
function addonIdsCarrying(addonUrls, secret) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return []
  return addonUrls.filter((a) => urlCarriesSecret(a.url, secret)).map((a) => a.id)
}

/** [{ id, name, url }] for every addon of the account whose address can be read. */
async function readAddonUrls(prisma, accountId, req, getDecryptedManifestUrl) {
  const addons = await prisma.addon.findMany({ where: { accountId }, select: { id: true, name: true, manifestUrl: true } })
  const out = []
  for (const addon of addons) {
    const url = getDecryptedManifestUrl(addon, req)
    if (url) out.push({ id: addon.id, name: addon.name, url })
  }
  return out
}

/** { [entryId]: number } for the entries that are used at least once. */
async function usageCounts(prisma, accountId, req, { decrypt, getDecryptedManifestUrl }) {
  const [entries, addonUrls] = await Promise.all([
    prisma.vaultEntry.findMany({ where: { accountId }, select: { id: true, category: true, encryptedSecret: true } }),
    readAddonUrls(prisma, accountId, req, getDecryptedManifestUrl),
  ])
  const counts = {}
  for (const entry of entries) {
    if (entry.category === 'note') continue
    let plain
    try { plain = decrypt(entry.encryptedSecret, req) } catch { continue }
    const n = addonIdsCarrying(addonUrls, matchableSecret(entry.category, plain)).length
    if (n > 0) counts[entry.id] = n
  }
  return counts
}

/** [{ id, name, groups: string[] }] for the addons carrying this entry's key. */
async function addonsUsing(prisma, accountId, req, { secret, getDecryptedManifestUrl }) {
  const addonUrls = await readAddonUrls(prisma, accountId, req, getDecryptedManifestUrl)
  const ids = new Set(addonIdsCarrying(addonUrls, secret))
  if (!ids.size) return []
  const groups = await prisma.group.findMany({
    where: { accountId },
    select: { name: true, addons: { select: { addonId: true } } },
  })
  return addonUrls.filter((a) => ids.has(a.id)).map((a) => ({
    id: a.id,
    name: a.name,
    groups: groups.filter((g) => g.addons.some((ga) => ga.addonId === a.id)).map((g) => g.name),
  }))
}

/** Whether an AIOStreams configuration holds the secret as a debrid key, an IPTV password or a playlist address. */
function configCarriesSecret(config, secret) {
  if (!config || !secret || secret.length < MIN_SECRET_LENGTH) return false
  for (const svc of Array.isArray(config.services) ? config.services : []) {
    const creds = svc && typeof svc.credentials === 'object' && svc.credentials ? svc.credentials : null
    if (creds && Object.values(creds).some((v) => v === secret)) return true
  }
  for (const preset of Array.isArray(config.presets) ? config.presets : []) {
    const type = String(preset?.type || '').toLowerCase()
    const o = preset && typeof preset.options === 'object' && preset.options ? preset.options : null
    if (!o) continue
    if (type === 'xtream' && o.password === secret) return true
    if (type === 'm3u' && String(o.playlist || '').trim() === secret) return true
  }
  return false
}

/**
 * The people whose AIOStreams configuration carries the secret, as far as it
 * could be read within `timeoutMs`. Configurations that did not answer in time
 * are left out rather than guessed. Never writes anything.
 */
async function aioConfigsUsing(prisma, accountId, { secret, decrypt, timeoutMs = 8000, read }) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return []
  const { instanceBase, readConfig } = require('./aiostreamsConfig')
  const readOne = read || readConfig
  const people = await prisma.user.findMany({
    where: { accountId, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', aioConfigId: { not: null }, aioConfigPassword: { not: null } },
    select: { id: true, username: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true },
  })
  // One configuration can be reached through several people (a household).
  const byConfig = new Map()
  for (const person of people) {
    const key = `${instanceBase(person.jellyfinServerUrl)}|${person.aioConfigId}`
    if (!byConfig.has(key)) byConfig.set(key, [])
    byConfig.get(key).push(person)
  }
  const found = []
  const tasks = [...byConfig.values()].map(async (group) => {
    const person = group[0]
    try {
      const password = decrypt(person.aioConfigPassword, { appAccountId: accountId })
      const config = await readOne({ serverUrl: person.jellyfinServerUrl, account: person.aioConfigId, password })
      if (configCarriesSecret(config, secret)) found.push(...group)
    } catch { /* unreachable or turned away: not counted */ }
  })
  let timer
  // Not unref'd: it is the only thing holding the answer open when a configuration never replies,
  // and it is cleared as soon as the race is over.
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
  await Promise.race([Promise.allSettled(tasks), deadline])
  clearTimeout(timer)
  return found.map((p) => ({ userId: p.id, username: p.username }))
}

module.exports = { matchableSecret, addonIdsCarrying, usageCounts, addonsUsing, configCarriesSecret, aioConfigsUsing }
