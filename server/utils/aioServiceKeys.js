// Debrid keys and IPTV logins inside AIOStreams configurations, kept in step
// with the Vault.
//
// When a Vault key changes - rotated by hand, a backup taking over from a
// failing key, or the original swapped back once it recovers - every addon
// carrying it is rewritten (utils/keyRotation.js). An AIOStreams
// configuration holds its debrid keys itself, in services[].credentials, so
// without this a household watching through AIOStreams kept the dead key.
//
// Opt-in per person, from their page (off by default).
//
// Only debrid service credentials that exactly match the old key are
// changed - nothing else in the configuration is touched - and only in
// configurations SlickSync holds the password for (someone added with their
// AIOStreams configuration password). Any outside change since the last look
// is reported first, and the change warning is re-baselined after, so this
// write is never reported as an outside change itself.

const {
  instanceBase, readConfig, writeConfig, rebaseline, noteOutsideChanges,
} = require('./aiostreamsConfig')

/** Swap one key for another in a configuration's debrid services. Returns the services changed. */
function replaceServiceKey(config, oldSecret, newSecret) {
  const changed = []
  for (const svc of Array.isArray(config?.services) ? config.services : []) {
    const creds = svc && typeof svc.credentials === 'object' && svc.credentials ? svc.credentials : null
    if (!creds) continue
    let hit = false
    for (const [field, value] of Object.entries(creds)) {
      if (value === oldSecret) { creds[field] = newSecret; hit = true }
    }
    if (hit) changed.push(String(svc.id || 'service'))
  }
  return changed
}

// Opt-in, per person: sync.aioRotateKeys[personId] === true. Off unless
// switched on from that person's page.
async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

async function statusFor(prisma, accountId, userId) {
  const person = await prisma.user.findFirst({
    where: { id: String(userId), accountId, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
    select: { id: true, aioConfigId: true, aioConfigPassword: true },
  })
  if (!person) return { available: false }
  const { cfg } = await readSync(prisma, accountId)
  return { available: true, canWrite: !!(person.aioConfigId && person.aioConfigPassword), enabled: cfg.aioRotateKeys?.[person.id] === true }
}

async function setEnabled(prisma, accountId, userId, enabled) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const map = { ...(cfg.aioRotateKeys && typeof cfg.aioRotateKeys === 'object' ? cfg.aioRotateKeys : {}) }
  if (enabled) map[userId] = true
  else delete map[userId]
  const next = { ...cfg, aioRotateKeys: map }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
}

async function rotateInAioConfigs(prisma, decrypt, { accountId, oldSecret, newSecret }) {
  if (!oldSecret || !newSecret || oldSecret === newSecret) return { updated: [], failed: [] }
  return changeOptedInConfigs(prisma, decrypt, accountId, (config) => replaceServiceKey(config, oldSecret, newSecret))
}

// IPTV (Xtream) logins inside a configuration's presets. Only a preset whose
// server, username and password all match the old login is changed.
function sameServer(a, b) {
  const { xtreamBase } = require('./vaultCheckers')
  const x = xtreamBase(a)
  return !!x && x.toLowerCase() === String(xtreamBase(b) || '').toLowerCase()
}

function replaceIptvLogin(config, before, after) {
  const changed = []
  for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
    if (!preset || String(preset.type || '').toLowerCase() !== 'xtream') continue
    const o = preset.options && typeof preset.options === 'object' ? preset.options : null
    if (!o || o.username !== before.username || o.password !== before.password || !sameServer(o.server, before.server)) continue
    if (after.server !== before.server) o.server = after.server
    o.username = after.username
    o.password = after.password
    changed.push(String(o.name || preset.instanceId || 'IPTV'))
  }
  return changed
}

// Live TV playlists (AIOStreams' M3U option) inside a configuration: only a
// preset holding exactly the old address is changed.
function replaceIptvPlaylist(config, before, after) {
  const changed = []
  const was = String(before || '').trim()
  const now = String(after || '').trim()
  if (!was || !now || was === now) return changed
  for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
    if (!preset || String(preset.type || '').toLowerCase() !== 'm3u') continue
    const o = preset.options && typeof preset.options === 'object' ? preset.options : null
    if (!o || String(o.playlist || '').trim() !== was) continue
    o.playlist = now
    changed.push(String(o.name || preset.instanceId || 'Live TV playlist'))
  }
  return changed
}

// Every Live TV source a configuration carries: M3U playlists and Xtream
// logins that are switched on. What a check of a setup's Live TV walks.
function liveTvSources(config) {
  const out = []
  for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
    if (!preset || preset.enabled === false) continue
    const type = String(preset.type || '').toLowerCase()
    const o = preset.options && typeof preset.options === 'object' ? preset.options : null
    if (!o) continue
    if (type === 'm3u' && String(o.playlist || '').trim()) {
      out.push({ kind: 'm3u', name: String(o.name || preset.instanceId || 'Live TV playlist'), playlist: String(o.playlist).trim() })
    } else if (type === 'xtream' && o.server && o.username && o.password) {
      out.push({ kind: 'xtream', name: String(o.name || preset.instanceId || 'IPTV'), server: String(o.server), username: String(o.username), password: String(o.password) })
    }
  }
  return out
}

async function rotateIptvInAioConfigs(prisma, decrypt, { accountId, before, after }) {
  const ok = (l) => l && l.server && l.username && l.password
  if (!ok(before) || !ok(after)) return { updated: [], failed: [] }
  if (before.username === after.username && before.password === after.password && before.server === after.server) return { updated: [], failed: [] }
  return changeOptedInConfigs(prisma, decrypt, accountId, (config) => replaceIptvLogin(config, before, after))
}

// Every configuration of a person who switched this on, changed by `change`
// (which returns what it changed; nothing changed = nothing written).
async function changeOptedInConfigs(prisma, decrypt, accountId, change) {
  const updated = []
  const failed = []
  const { cfg } = await readSync(prisma, accountId)
  const optedIn = Object.keys(cfg.aioRotateKeys || {}).filter((id) => cfg.aioRotateKeys[id] === true)
  if (!optedIn.length) return { updated, failed }
  const people = await prisma.user.findMany({
    where: { accountId, id: { in: optedIn }, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', aioConfigId: { not: null }, aioConfigPassword: { not: null } },
    select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true },
  })
  // One configuration can be reached through several people (a household).
  const seen = new Set()
  for (const person of people) {
    const key = `${instanceBase(person.jellyfinServerUrl)}|${person.aioConfigId}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const access = {
        serverUrl: person.jellyfinServerUrl,
        account: person.aioConfigId,
        password: decrypt(person.aioConfigPassword, { appAccountId: person.accountId || accountId }),
      }
      const config = await readConfig(access)
      // Report anything changed elsewhere before this write is folded into the baseline.
      try { await noteOutsideChanges(prisma, person, config) } catch {}
      const services = change(config)
      if (!services.length) continue
      await writeConfig(access, config)
      try { await rebaseline(prisma, person, await readConfig(access)) } catch {}
      updated.push({ username: person.username, services })
    } catch (e) {
      failed.push({ username: person.username, error: e?.message || 'unknown' })
    }
  }
  return { updated, failed }
}

module.exports = { rotateInAioConfigs, rotateIptvInAioConfigs, replaceServiceKey, replaceIptvLogin, replaceIptvPlaylist, liveTvSources, statusFor, setEnabled }
