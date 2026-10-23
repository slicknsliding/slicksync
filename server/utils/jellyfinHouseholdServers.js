// Jellyfin servers added on the Addons page and given to groups like an addon.
//
// The household adds a server once with an administrator's say-so (an API
// key, or a sign-in SlickSync turns into one), then gives it to groups. When
// a group syncs, everyone in it gets their own account on the server - named
// after them, with a password SlickSync keeps for apps that have no Quick
// Connect - or is linked to the account they already have there: their own
// SlickSync sign-in on that server, or a server account with their name. Any
// Jellyfin app works with it; the person approves the app's Quick Connect code
// on their SlickSync page.
//
// SlickSync signs in as each person it makes or links, as a stored sign-in
// (a UserProviderCredential with origin "jellyfin-server:<id>"), so what they
// watch is tracked like any Jellyfin sign-in. That needs the person's one
// Jellyfin credential slot to be free; someone whose own SlickSync login is a
// different Jellyfin server still gets the account, just not tracked.
//
// Someone taken out of every group the server is given to - or deactivated,
// expired or removed in SlickSync - has an account SlickSync made switched
// off (not deleted; adding them back switches it on). An account that existed
// before is never switched off or changed: it is only unlinked.
//
// Everything lives in AppAccount.sync.jellyfinHouseholdServers[id]:
//   { id, name, url, serverId, key (encrypted API key), keyMade, groupIds[],
//     accounts: { [personId]: { jellyfinUserId, userName, made, own, off,
//                               tracked, password (encrypted, made only) } } }

const crypto = require('crypto')
const jfAuth = require('../providers/jellyfinAuth')
const { rememberSignIn } = require('./jellyfinConnect')
const { encrypt, decrypt } = require('./encryption')

const MAP = 'jellyfinHouseholdServers'
// The accounts SlickSync made on a server that was removed, by the server's
// id (or address), so adding it back picks them up - passwords included -
// instead of making everyone a second one.
const PAST = 'jellyfinHouseholdServersPast'
const RECONCILE_MS = 10 * 60 * 1000
const KEY_APP = 'SlickSync'

const httpError = (status, message) => Object.assign(new Error(message), { status })
const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase()
const sealFor = (accountId) => ({ appAccountId: accountId || 'default' })
const originOf = (serverId) => `jellyfin-server:${serverId}`

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

const pastKey = (serverId, url) => (serverId ? `id:${normId(serverId)}` : `url:${String(url || '').toLowerCase()}`)

async function patchPast(prisma, accountId, key, value) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const map = { ...(cfg[PAST] && typeof cfg[PAST] === 'object' ? cfg[PAST] : {}) }
  if (value === null) delete map[key]
  else map[key] = value
  const all = { ...cfg, [PAST]: map }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(all) : all } })
}

async function readPast(prisma, accountId, serverId, url) {
  const { cfg } = await readSync(prisma, accountId)
  const map = cfg[PAST] && typeof cfg[PAST] === 'object' ? cfg[PAST] : {}
  const key = [pastKey(serverId, url), pastKey(null, url)].find((k) => map[k])
  return key ? { key, past: map[key] } : null
}

async function readServers(prisma, accountId) {
  const { cfg } = await readSync(prisma, accountId)
  const map = cfg[MAP]
  return map && typeof map === 'object' ? map : {}
}

/** Change one server on a fresh read. `change` gets the stored server and returns the new one, or null to remove it. */
async function patchServer(prisma, accountId, id, change) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const map = { ...(cfg[MAP] && typeof cfg[MAP] === 'object' ? cfg[MAP] : {}) }
  const next = change(map[id] || null)
  if (next === null) delete map[id]
  else map[id] = next
  const all = { ...cfg, [MAP]: map }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(all) : all } })
  return next
}

// ---------------------------------------------------------------------------
// Talking to the server as its administrator

const adminDevice = (url) => jfAuth.deviceIdFor(url, 'household-server')

function adminCall(server, accountId, path, opts = {}) {
  return jfAuth.jfRequest(server.url, path, { token: decrypt(server.key, sealFor(accountId)), deviceId: adminDevice(server.url), ...opts })
}

async function listKeys(url, token, deviceId) {
  const data = await jfAuth.jfRequest(url, '/Auth/Keys', { token, deviceId })
  return Array.isArray(data?.Items) ? data.Items : []
}

/** An API key for SlickSync, made with an administrator's sign-in: it outlives their password and their devices. */
async function makeKey(url, token, deviceId) {
  const before = new Set((await listKeys(url, token, deviceId)).map((k) => k.AccessToken))
  await jfAuth.jfRequest(url, `/Auth/Keys?app=${encodeURIComponent(KEY_APP)}`, { method: 'POST', token, deviceId })
  const made = (await listKeys(url, token, deviceId)).find((k) => k.AccessToken && !before.has(k.AccessToken))
  if (!made) throw httpError(502, 'The server did not make an API key for SlickSync')
  return made.AccessToken
}

/**
 * Check the address and the administrator's say-so. `auth` is
 * { method: 'apikey', apiKey } | { method: 'username', username, password }
 * | { method: 'quickconnect', secret, device }. Returns the server and an API key.
 */
async function connectAdmin(prisma, rawUrl, auth = {}) {
  const probe = await jfAuth.probeServer(rawUrl)
  if (probe.kind !== 'jellyfin') {
    throw httpError(400, `That's ${probe.kindLabel}, which can't make accounts for people - add a Jellyfin server here`)
  }
  const url = probe.serverUrl
  if (auth.method === 'apikey') {
    const apiKey = String(auth.apiKey || '').trim()
    if (!apiKey) throw httpError(400, 'Paste the API key')
    try {
      const users = await jfAuth.jfRequest(url, '/Users', { token: apiKey, deviceId: adminDevice(url) })
      if (!Array.isArray(users)) throw httpError(400, 'That API key isn’t accepted by the server')
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) throw httpError(400, 'That API key isn’t accepted by the server')
      throw e
    }
    return { probe, key: apiKey, keyMade: false }
  }
  let login
  let deviceId
  if (auth.method === 'quickconnect') {
    deviceId = auth.device
    login = await jfAuth.quickConnectAuthenticate(url, String(auth.secret || ''), { deviceId })
  } else {
    const username = String(auth.username || '').trim()
    if (!username) throw httpError(400, 'Enter the administrator’s username')
    deviceId = jfAuth.signInDeviceId(url, username)
    login = await jfAuth.authenticateByName(url, username, String(auth.password || ''), { deviceId })
    // This device may be someone's stored sign-in, and signing in just retired it.
    await rememberSignIn(prisma, encrypt, probe, login)
  }
  if (!login.isAdmin) {
    if (auth.method === 'quickconnect') await jfAuth.signOut(url, login.token, { deviceId })
    throw httpError(403, `${login.userName || 'That account'} isn’t an administrator on this server - only administrators can make accounts`)
  }
  const key = await makeKey(url, login.token, deviceId)
  // A Quick Connect sign-in was only ever for making the key.
  if (auth.method === 'quickconnect') await jfAuth.signOut(url, login.token, { deviceId })
  return { probe, key, keyMade: true }
}

async function addServer(prisma, accountId, { url, name, auth, groupIds }) {
  const { probe, key, keyMade } = await connectAdmin(prisma, url, auth)
  const existing = Object.values(await readServers(prisma, accountId)).find((s) => s.url === probe.serverUrl || (probe.serverId && s.serverId === probe.serverId))
  if (existing) throw httpError(409, `${existing.name} is already added`)
  const id = crypto.randomBytes(8).toString('hex')
  const fallbackName = require('./jellyfinServerCollections').serverDisplayName(probe.serverName, jfAuth.displayServer(probe.serverUrl))
  // Added before and removed: the accounts SlickSync made there are its own again.
  const found = await readPast(prisma, accountId, probe.serverId, probe.serverUrl)
  const accounts = {}
  for (const [personId, rec] of Object.entries(found?.past?.accounts || {})) {
    if (rec?.made && rec.jellyfinUserId) accounts[personId] = { ...rec, tracked: false }
  }
  const server = {
    id,
    name: String(name || '').trim().slice(0, 80) || fallbackName,
    url: probe.serverUrl,
    serverId: probe.serverId || null,
    key: encrypt(key, sealFor(accountId)),
    keyMade,
    groupIds: await ownGroups(prisma, accountId, groupIds),
    accounts,
    createdAt: new Date().toISOString(),
  }
  await patchServer(prisma, accountId, id, () => server)
  if (found) await patchPast(prisma, accountId, found.key, null)
  return server
}

async function ownGroups(prisma, accountId, groupIds) {
  const ids = [...new Set((Array.isArray(groupIds) ? groupIds : []).map(String))]
  if (!ids.length) return []
  const found = await prisma.group.findMany({ where: { accountId, id: { in: ids } }, select: { id: true } })
  const have = new Set(found.map((g) => g.id))
  return ids.filter((id) => have.has(id))
}

async function updateServer(prisma, accountId, id, { name, groupIds }) {
  const groups = groupIds === undefined ? undefined : await ownGroups(prisma, accountId, groupIds)
  const next = await patchServer(prisma, accountId, id, (s) => {
    if (!s) return null
    return {
      ...s,
      ...(name !== undefined ? { name: String(name || '').trim().slice(0, 80) || s.name } : {}),
      ...(groups !== undefined ? { groupIds: groups } : {}),
    }
  })
  if (!next) throw httpError(404, 'Server not found')
  return next
}

/**
 * Remove the server from SlickSync. Accounts on it stay as they are; the
 * sign-ins SlickSync kept for it go, and so does the API key it made.
 */
async function removeServer(prisma, accountId, id) {
  const server = (await readServers(prisma, accountId))[id]
  if (!server) throw httpError(404, 'Server not found')
  await prisma.userProviderCredential.deleteMany({ where: { origin: originOf(id) } })
  const made = Object.fromEntries(Object.entries(server.accounts || {}).filter(([, r]) => r?.made))
  if (Object.keys(made).length) {
    await patchPast(prisma, accountId, pastKey(server.serverId, server.url), { url: server.url, serverId: server.serverId || null, accounts: made, removedAt: new Date().toISOString() })
  }
  if (server.keyMade) {
    try {
      const token = decrypt(server.key, sealFor(accountId))
      await jfAuth.jfRequest(server.url, `/Auth/Keys/${encodeURIComponent(token)}`, { method: 'DELETE', token, deviceId: adminDevice(server.url), timeoutMs: 8000 })
    } catch (e) {
      console.warn(`[JellyfinServers] could not remove SlickSync's API key from ${server.name}:`, e?.message)
    }
  }
  await patchServer(prisma, accountId, id, () => null)
}

// ---------------------------------------------------------------------------
// Who should have an account, and keeping them in step

function sameServer(server, url, serverId) {
  if (!url && !serverId) return false
  const bare = (u) => String(u || '').replace(/^https?:\/\//i, '').toLowerCase()
  if (url && bare(url) === bare(server.url)) return true
  // A household install may reach one server by several names; on an
  // instance serving strangers only the address counts (jellyfinConnect.serverMatch).
  return !jfAuth.restrictsPrivateAddresses() && !!serverId && !!server.serverId && normId(serverId) === normId(server.serverId)
}

const isLive = (u) => u && u.isActive !== false && !(u.expiresAt && new Date(u.expiresAt) <= new Date())

async function membersOf(prisma, accountId, server) {
  if (!server.groupIds?.length) return []
  const groups = await prisma.group.findMany({ where: { accountId, id: { in: server.groupIds }, isActive: true }, select: { userIds: true } })
  const ids = new Set()
  for (const g of groups) {
    let list = []
    try { list = Array.isArray(g.userIds) ? g.userIds : JSON.parse(g.userIds || '[]') } catch {}
    for (const id of list) ids.add(String(id))
  }
  if (!ids.size) return []
  const people = await prisma.user.findMany({
    where: { accountId, id: { in: [...ids] } },
    select: { id: true, username: true, isActive: true, expiresAt: true, providerType: true, jellyfinServerUrl: true, jellyfinServerId: true, jellyfinUserId: true, jellyfinUserName: true },
  })
  return people.filter(isLive)
}

/** A user name Jellyfin takes (letters, digits, space and - ' . _ @ +), not already used on the server. */
function accountName(username, taken) {
  let base = String(username || '').replace(/[^\w \-'.@+]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!base) base = 'user'
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
  return name
}

const newPassword = () => crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)

async function setDisabled(server, accountId, jellyfinUserId, disabled) {
  const user = await adminCall(server, accountId, `/Users/${jellyfinUserId}`)
  const policy = user?.Policy
  if (!policy) throw httpError(502, 'The server did not say how this account is set up')
  if (policy.IsDisabled === disabled) return false
  await adminCall(server, accountId, `/Users/${jellyfinUserId}/Policy`, { method: 'POST', body: { ...policy, IsDisabled: disabled } })
  return true
}

/**
 * Sign in as the person on the server and keep it as their stored Jellyfin
 * sign-in, so their watching is tracked. Only when their one Jellyfin slot is
 * free (or already this server's). Returns whether they're tracked.
 */
async function keepSignIn(prisma, accountId, server, person, rec, credentials) {
  if (person.providerType === 'jellyfin') return false
  const held = credentials.find((c) => c.userId === person.id)
  if (held && held.origin !== originOf(server.id)) return false
  const url = server.url
  const deviceId = jfAuth.signInDeviceId(url, rec.userName)
  let login
  if (rec.made && rec.password) {
    login = await jfAuth.authenticateByName(url, rec.userName, decrypt(rec.password, sealFor(accountId)), { deviceId })
  } else {
    // An account that was already there: SlickSync doesn't know its password,
    // so the administrator approves a Quick Connect sign-in for it.
    const started = await jfAuth.quickConnectInitiate(url, { deviceId })
    const ok = await adminCall(server, accountId, `/QuickConnect/Authorize?code=${encodeURIComponent(started.code)}&userId=${rec.jellyfinUserId}`, { method: 'POST' })
    if (ok !== true) throw httpError(502, 'The server did not approve the sign-in')
    login = await jfAuth.quickConnectAuthenticate(url, started.secret, { deviceId })
  }
  if (normId(login.userId) !== normId(rec.jellyfinUserId)) throw httpError(502, 'The server signed in as someone else')
  await rememberSignIn(prisma, encrypt, { serverUrl: url }, login)
  const data = {
    jellyfinServerUrl: url,
    jellyfinServerId: login.serverId || server.serverId || null,
    jellyfinServerKind: 'jellyfin',
    jellyfinUserId: login.userId,
    jellyfinUserName: login.userName || rec.userName,
    jellyfinToken: encrypt(login.token, sealFor(accountId)),
    origin: originOf(server.id),
  }
  if (held) await prisma.userProviderCredential.update({ where: { id: held.id }, data })
  else await prisma.userProviderCredential.create({ data: { userId: person.id, providerType: 'jellyfin', ...data } })
  return true
}

async function dropSignIn(prisma, server, personId) {
  await prisma.userProviderCredential.deleteMany({ where: { userId: personId, providerType: 'jellyfin', origin: originOf(server.id) } })
}

/**
 * Bring one server in step with its groups. `add` false only switches
 * accounts off and back on (the background pass); true also makes and links
 * accounts for people who have none yet (a group sync). Returns what changed.
 */
// One pass per server at a time, so two groups syncing together can't both
// make an account for the same person.
const running = new Map()
function syncServer(prisma, accountId, id, opts) {
  const key = `${accountId}|${id}`
  const next = (running.get(key) || Promise.resolve()).catch(() => {}).then(() => syncServerNow(prisma, accountId, id, opts))
  running.set(key, next)
  next.finally(() => { if (running.get(key) === next) running.delete(key) }).catch(() => {})
  return next
}

async function syncServerNow(prisma, accountId, id, { add = true } = {}) {
  const server = (await readServers(prisma, accountId))[id]
  if (!server) return []
  const changes = []
  const members = await membersOf(prisma, accountId, server)
  const memberIds = new Set(members.map((m) => m.id))
  const accounts = { ...(server.accounts || {}) }

  let serverUsers
  try {
    const list = await adminCall(server, accountId, '/Users')
    serverUsers = Array.isArray(list) ? list : []
  } catch (e) {
    console.warn(`[JellyfinServers] ${server.name} can't be reached:`, e?.message)
    return [{ action: 'failed', name: server.name, detail: e?.message || 'The server can’t be reached' }]
  }
  const byId = new Map(serverUsers.map((u) => [normId(u.Id), u]))
  const taken = new Set(serverUsers.map((u) => String(u.Name || '').toLowerCase()))
  const credentials = await prisma.userProviderCredential.findMany({
    where: { userId: { in: [...new Set([...memberIds, ...Object.keys(accounts)])] }, providerType: 'jellyfin' },
    select: { id: true, userId: true, origin: true, jellyfinServerUrl: true, jellyfinServerId: true },
  })

  // Left the groups, or no longer active in SlickSync.
  for (const [personId, rec] of Object.entries(accounts)) {
    if (memberIds.has(personId)) continue
    try {
      await dropSignIn(prisma, server, personId)
      if (rec.made && byId.has(normId(rec.jellyfinUserId))) {
        if (!rec.off) {
          await setDisabled(server, accountId, rec.jellyfinUserId, true)
          changes.push({ action: 'off', personId, name: rec.userName })
        }
        accounts[personId] = { ...rec, off: true, tracked: false }
      } else {
        delete accounts[personId]
        if (!rec.made) changes.push({ action: 'unlinked', personId, name: rec.userName })
      }
    } catch (e) {
      changes.push({ action: 'failed', personId, name: rec.userName, detail: e?.message })
    }
  }

  for (const person of members) {
    let rec = accounts[person.id]
    try {
      // An account SlickSync made but someone deleted on the server: make it again.
      if (rec && !byId.has(normId(rec.jellyfinUserId)) && !rec.own) {
        await dropSignIn(prisma, server, person.id)
        delete accounts[person.id]
        rec = null
      }
      if (rec) {
        if (rec.made && rec.off) {
          await setDisabled(server, accountId, rec.jellyfinUserId, false)
          rec = { ...rec, off: false }
          rec.tracked = await keepSignIn(prisma, accountId, server, person, rec, credentials).catch(() => false)
          accounts[person.id] = rec
          changes.push({ action: 'on', personId: person.id, name: rec.userName })
        } else if (add && !rec.off && !rec.own && !rec.tracked) {
          rec = { ...rec, tracked: await keepSignIn(prisma, accountId, server, person, rec, credentials).catch(() => false) }
          accounts[person.id] = rec
        }
        continue
      }
      if (!add) continue

      // Their own SlickSync login is this server.
      if (person.providerType === 'jellyfin' && sameServer(server, person.jellyfinServerUrl, person.jellyfinServerId) && person.jellyfinUserId) {
        accounts[person.id] = { jellyfinUserId: normId(person.jellyfinUserId), userName: person.jellyfinUserName || person.username, made: false, own: true, off: false, tracked: true }
        changes.push({ action: 'linked', personId: person.id, name: person.username })
        continue
      }
      // A sign-in on this server already kept for them (a merged-in login).
      const kept = credentials.find((c) => c.userId === person.id && !c.origin && sameServer(server, c.jellyfinServerUrl, c.jellyfinServerId))
      if (kept) {
        const full = await prisma.userProviderCredential.findUnique({ where: { id: kept.id }, select: { jellyfinUserId: true, jellyfinUserName: true } })
        accounts[person.id] = { jellyfinUserId: normId(full?.jellyfinUserId), userName: full?.jellyfinUserName || person.username, made: false, own: true, off: false, tracked: true }
        changes.push({ action: 'linked', personId: person.id, name: person.username })
        continue
      }
      // An account with their name. Never an administrator's: approving
      // Quick Connect for it would hand them the server.
      const wanted = accountName(person.username, new Set()).toLowerCase()
      const numbered = (n) => n.startsWith(`${wanted} `) && /^\d+$/.test(n.slice(wanted.length + 1))
      const usable = serverUsers.filter((u) => !u.Policy?.IsAdministrator && !Object.values(accounts).some((r) => normId(r.jellyfinUserId) === normId(u.Id)))
      const named = usable.find((u) => String(u.Name || '').toLowerCase() === wanted)
        || usable.find((u) => numbered(String(u.Name || '').toLowerCase()))
      if (named) {
        rec = { jellyfinUserId: normId(named.Id), userName: named.Name, made: false, own: false, off: false, tracked: false }
        rec.tracked = await keepSignIn(prisma, accountId, server, person, rec, credentials).catch((e) => {
          console.warn(`[JellyfinServers] ${person.username} linked on ${server.name} but not tracked:`, e?.message)
          return false
        })
        accounts[person.id] = rec
        changes.push({ action: 'linked', personId: person.id, name: named.Name })
        continue
      }
      // Make one.
      const userName = accountName(person.username, taken)
      const password = newPassword()
      const created = await adminCall(server, accountId, '/Users/New', { method: 'POST', body: { Name: userName, Password: password } })
      const jellyfinUserId = normId(created?.Id)
      if (!jellyfinUserId) throw httpError(502, 'The server did not make the account')
      taken.add(userName.toLowerCase())
      rec = { jellyfinUserId, userName, made: true, own: false, off: false, tracked: false, password: encrypt(password, sealFor(accountId)), madeAt: new Date().toISOString() }
      // Saved before anything else can fail, so a retry never makes a second account.
      accounts[person.id] = rec
      await patchServer(prisma, accountId, id, (s) => (s ? { ...s, accounts: { ...(s.accounts || {}), [person.id]: rec } } : null))
      rec.tracked = await keepSignIn(prisma, accountId, server, person, rec, credentials).catch((e) => {
        console.warn(`[JellyfinServers] ${userName} made on ${server.name} but not tracked:`, e?.message)
        return false
      })
      changes.push({ action: 'made', personId: person.id, name: userName })
    } catch (e) {
      console.warn(`[JellyfinServers] ${person.username} on ${server.name}:`, e?.message)
      changes.push({ action: 'failed', personId: person.id, name: person.username, detail: e?.message })
    }
  }

  await patchServer(prisma, accountId, id, (s) => (s ? { ...s, accounts, lastSyncAt: new Date().toISOString() } : null))
  return changes
}

/** A group synced: every server given to it catches up. */
async function syncForGroup(prisma, accountId, groupId) {
  const servers = Object.values(await readServers(prisma, accountId)).filter((s) => s.groupIds?.includes(String(groupId)))
  const out = []
  for (const s of servers) {
    for (const c of await syncServer(prisma, accountId, s.id, { add: true })) out.push({ server: s.name, ...c })
  }
  return out
}

// ---------------------------------------------------------------------------
// What the pages show

async function listServers(prisma, accountId) {
  const servers = Object.values(await readServers(prisma, accountId))
  if (!servers.length) return []
  const groups = await prisma.group.findMany({ where: { accountId }, select: { id: true, name: true } })
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const out = []
  for (const s of servers) {
    const members = await membersOf(prisma, accountId, s)
    const recs = s.accounts || {}
    const withAccounts = members.filter((m) => recs[m.id] && !recs[m.id].off).length
    out.push({
      id: s.id,
      name: s.name,
      address: jfAuth.displayServer(s.url),
      groupIds: s.groupIds || [],
      groups: (s.groupIds || []).filter((g) => groupName.has(g)).map((g) => ({ id: g, name: groupName.get(g) })),
      people: members.length,
      withAccounts,
      waiting: members.length - withAccounts,
      lastSyncAt: s.lastSyncAt || null,
      createdAt: s.createdAt || null,
    })
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** The servers a person has (or will get on the next sync) an account on, for their page. */
async function personServers(prisma, accountId, personId) {
  const servers = Object.values(await readServers(prisma, accountId))
  const out = []
  for (const s of servers) {
    const rec = s.accounts?.[personId]
    const member = (await membersOf(prisma, accountId, s)).some((m) => m.id === personId)
    if (!rec && !member) continue
    if (rec?.off && !member) continue
    const groups = s.groupIds?.length ? await prisma.group.findMany({ where: { accountId, id: { in: s.groupIds } }, select: { name: true, userIds: true } }) : []
    const via = groups.filter((g) => { try { return JSON.parse(g.userIds || '[]').includes(personId) } catch { return false } }).map((g) => g.name)
    out.push({
      id: s.id,
      name: s.name,
      address: jfAuth.displayServer(s.url),
      groups: via,
      userName: rec?.userName || null,
      made: !!rec?.made,
      own: !!rec?.own,
      waiting: !rec,
      tracked: !!rec?.tracked,
      hasPassword: !!(rec?.made && rec?.password),
    })
  }
  return out
}

async function recordFor(prisma, accountId, serverId, personId) {
  const server = (await readServers(prisma, accountId))[serverId]
  const rec = server?.accounts?.[personId]
  if (!server || !rec || rec.off) throw httpError(404, 'They don’t have an account on that server yet - sync their group first')
  return { server, rec }
}

/** Approve the code a Jellyfin app shows under Quick Connect, as this person. */
async function approveCode(prisma, accountId, serverId, personId, code) {
  const clean = String(code || '').replace(/\s+/g, '')
  if (!/^\d{4,10}$/.test(clean)) throw httpError(400, 'Type the code the app shows')
  const { server, rec } = await recordFor(prisma, accountId, serverId, personId)
  let ok
  try {
    ok = await adminCall(server, accountId, `/QuickConnect/Authorize?code=${encodeURIComponent(clean)}&userId=${rec.jellyfinUserId}`, { method: 'POST' })
  } catch (e) {
    if (e?.status === 404 || e?.status === 400) throw httpError(400, 'That code wasn’t found - it may have run out. Start Quick Connect in the app again.')
    if (e?.status === 401 || e?.status === 403) throw httpError(400, 'Quick Connect is turned off on the server, or SlickSync’s access to it was removed')
    throw e
  }
  if (ok !== true) throw httpError(400, 'The server didn’t approve that code')
  return { approved: true, userName: rec.userName }
}

async function revealPassword(prisma, accountId, serverId, personId) {
  const { rec } = await recordFor(prisma, accountId, serverId, personId)
  if (!rec.made || !rec.password) throw httpError(400, 'That account was already on the server - it uses its own password')
  return { userName: rec.userName, password: decrypt(rec.password, sealFor(accountId)) }
}

// ---------------------------------------------------------------------------

async function reconcileAll(prisma) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true } })
  for (const acc of accounts) {
    let servers
    try { servers = Object.values(await readServers(prisma, acc.id)) } catch { continue }
    for (const s of servers) {
      try {
        for (const c of await syncServer(prisma, acc.id, s.id, { add: false })) {
          if (c.action === 'off' || c.action === 'on') console.log(`[JellyfinServers] ${c.name}'s account on ${s.name} switched ${c.action}`)
        }
      } catch (e) {
        console.warn(`[JellyfinServers] ${s.name}:`, e?.message)
      }
    }
  }
}

let timer = null
function scheduleHouseholdServers(prisma) {
  if (timer) clearInterval(timer)
  const run = () => reconcileAll(prisma).catch((e) => console.warn('[JellyfinServers] pass failed:', e?.message))
  setTimeout(run, 4 * 60 * 1000)
  timer = setInterval(run, RECONCILE_MS)
}

module.exports = {
  connectAdmin, addServer, updateServer, removeServer, syncServer, syncForGroup,
  listServers, personServers, approveCode, revealPassword, scheduleHouseholdServers,
  // for tests
  accountName, sameServer, originOf, readServers,
}
