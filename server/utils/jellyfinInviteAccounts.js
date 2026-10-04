// Invites that make the Jellyfin account, and those accounts following the
// person's access.
//
// An invitation can be set to make an account on one of the household's real
// Jellyfin servers (sync.jellyfinInvites[invitationId] = server key). The
// person joining picks a password on the invite page; SlickSync makes the
// account with an administrator's sign-in on that server, signs in as it,
// and switches it off until the request is accepted. Accepting switches it
// on; rejecting (or deleting the request) deletes it.
//
// From then on the account follows the person: switched off while they are
// deactivated, expired or removed in SlickSync, and on again when they are
// active. Only accounts made this way are ever touched - kept in
// sync.jellyfinInviteAccounts - never an account that existed before.
// Jellyfin lets only administrators make accounts and switch them on and off,
// so all of it goes through an administrator's sign-in on that server.

const serverCollections = require('./jellyfinServerCollections')
const jfAuth = require('../providers/jellyfinAuth')

const RECONCILE_MS = 10 * 60 * 1000
const MAX_WAITING = 10

const httpError = (status, message) => Object.assign(new Error(message), { status })
const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase()
const recordKey = (serverUrl, jellyfinUserId) => `${serverUrl}|${normId(jellyfinUserId)}`

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/** Change entries of one map in the account's settings, on a fresh read. null removes an entry. */
async function patchMap(prisma, accountId, mapName, entries) {
  const { cfg, asString } = await readSync(prisma, accountId)
  const map = { ...(cfg[mapName] && typeof cfg[mapName] === 'object' ? cfg[mapName] : {}) }
  for (const [k, v] of Object.entries(entries)) {
    if (v === null) delete map[k]
    else map[k] = v
  }
  const next = { ...cfg, [mapName]: map }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(next) : next } })
}

/** A server's administrator sign-in, or null when nobody here signs in as one. */
async function adminSession(prisma, decrypt, accountId, serverKey) {
  const server = (await serverCollections.serversFor(prisma, accountId)).find((s) => s.key === serverKey)
  if (!server) return { server: null, session: null }
  const { session, admin } = await serverCollections.findActor(server, decrypt)
  return { server, session: admin ? session : null }
}

/** The household's real Jellyfin servers, for the invitation form: which can make accounts. */
async function inviteServers(prisma, decrypt, accountId) {
  const servers = await serverCollections.serversFor(prisma, accountId)
  return Promise.all(servers.map(async (s) => {
    const { session, admin, serverName } = await serverCollections.findActor(s, decrypt)
    return { key: s.key, name: serverCollections.serverDisplayName(serverName, s.address), canCreate: !!(session && admin) }
  }))
}

async function invitationServer(prisma, accountId, invitationId) {
  const { cfg } = await readSync(prisma, accountId)
  return cfg.jellyfinInvites?.[invitationId] || null
}

async function setInvitationServer(prisma, accountId, invitationId, serverKey) {
  await patchMap(prisma, accountId, 'jellyfinInvites', { [invitationId]: serverKey ? String(serverKey) : null })
}

/** What the invite page needs to offer "make me an account": the server's name. */
async function publicOffer(prisma, invitation) {
  const key = await invitationServer(prisma, invitation.accountId, invitation.id)
  if (!key) return null
  const server = (await serverCollections.serversFor(prisma, invitation.accountId)).find((s) => s.key === key)
  return server ? { server: server.address } : null
}

async function setDisabled(session, jellyfinUserId, disabled) {
  const user = await serverCollections.call(session, `/Users/${jellyfinUserId}`)
  const policy = user?.Policy
  if (!policy) throw httpError(502, 'The server did not say how this account is set up')
  if (policy.IsDisabled === disabled) return false
  await serverCollections.call(session, `/Users/${jellyfinUserId}/Policy`, { method: 'POST', body: { ...policy, IsDisabled: disabled } })
  return true
}

/**
 * Make the account for an invite request. Returns the same { probe, login }
 * a sign-in gives, so the request is stored exactly like one made by
 * signing in with an existing account.
 */
async function createForRequest(prisma, decrypt, invitation, { username, password }) {
  const name = String(username || '').trim()
  const pw = String(password || '')
  if (!name) throw httpError(400, 'Pick a username first')
  if (pw.length < 6) throw httpError(400, 'Use a password of at least 6 characters')
  const key = await invitationServer(prisma, invitation.accountId, invitation.id)
  if (!key) throw httpError(400, 'This invitation doesn’t make accounts')
  // Anyone with the link could otherwise fill the server with accounts
  // waiting to be accepted.
  const { cfg } = await readSync(prisma, invitation.accountId)
  const waiting = Object.values(cfg.jellyfinInviteAccounts || {}).filter((r) => r?.invitationId === invitation.id && r.state === 'pending').length
  if (waiting >= MAX_WAITING) throw httpError(429, 'Too many people are already waiting to be accepted on this invitation - ask whoever invited you')
  const { server, session } = await adminSession(prisma, decrypt, invitation.accountId, key)
  if (!server || !session) throw httpError(503, 'The server can’t make accounts right now - ask whoever invited you')

  let created
  try {
    created = await serverCollections.call(session, '/Users/New', { method: 'POST', body: { Name: name, Password: pw } })
  } catch (e) {
    if (e?.status === 400) throw httpError(400, `The server already has someone called ${name} - pick another username`)
    throw e
  }
  const jellyfinUserId = normId(created?.Id)
  if (!jellyfinUserId) throw httpError(502, 'The server did not make the account')

  const probe = await jfAuth.probeServer(server.url)
  const login = await jfAuth.authenticateByName(probe.serverUrl, name, pw)
  // Off until the request is accepted.
  await setDisabled(session, jellyfinUserId, true)
  await patchMap(prisma, invitation.accountId, 'jellyfinInviteAccounts', {
    [recordKey(probe.serverUrl, jellyfinUserId)]: {
      serverKey: key, serverUrl: probe.serverUrl, jellyfinUserId, name, invitationId: invitation.id, state: 'pending', createdAt: new Date().toISOString(),
    },
  })
  return { probe, login: { ...login, serverId: login.serverId || probe.serverId } }
}

async function recordFor(prisma, accountId, serverUrl, jellyfinUserId) {
  const { cfg } = await readSync(prisma, accountId)
  const key = recordKey(serverUrl, jellyfinUserId)
  const rec = cfg.jellyfinInviteAccounts?.[key]
  return rec ? { key, rec } : null
}

/** A request with an invite-made account was accepted: switch the account on. */
async function onAccepted(prisma, decrypt, accountId, person) {
  if (!person?.jellyfinServerUrl || !person.jellyfinUserId) return
  const found = await recordFor(prisma, accountId, person.jellyfinServerUrl, person.jellyfinUserId)
  if (!found) return
  const { session } = await adminSession(prisma, decrypt, accountId, found.rec.serverKey)
  if (session) await setDisabled(session, found.rec.jellyfinUserId, false)
  await patchMap(prisma, accountId, 'jellyfinInviteAccounts', { [found.key]: { ...found.rec, state: 'accepted', acceptedAt: new Date().toISOString() } })
}

/** A request with an invite-made account was rejected or deleted: the account goes too. */
async function onRequestDropped(prisma, decrypt, accountId, request) {
  if (!request?.jellyfinServerUrl || !request.jellyfinUserId) return
  const found = await recordFor(prisma, accountId, request.jellyfinServerUrl, request.jellyfinUserId)
  if (!found || found.rec.state !== 'pending') return
  const { session } = await adminSession(prisma, decrypt, accountId, found.rec.serverKey)
  if (!session) return
  try { await serverCollections.call(session, `/Users/${found.rec.jellyfinUserId}`, { method: 'DELETE' }) }
  catch (e) { if (e?.status !== 404) throw e }
  await patchMap(prisma, accountId, 'jellyfinInviteAccounts', { [found.key]: null })
}

/**
 * Every accepted invite-made account matches its person: off while they are
 * deactivated or gone (expired, removed), on while they are active.
 */
async function reconcileAccount(prisma, decrypt, accountId) {
  const { cfg } = await readSync(prisma, accountId)
  const records = Object.entries(cfg.jellyfinInviteAccounts || {}).filter(([, r]) => r && r.state === 'accepted')
  if (!records.length) return []
  const changes = []
  const sessions = new Map()
  for (const [, rec] of records) {
    const person = await prisma.user.findFirst({
      where: { accountId, providerType: 'jellyfin', jellyfinServerUrl: rec.serverUrl, jellyfinUserId: rec.jellyfinUserId },
      select: { id: true, isActive: true, expiresAt: true },
    })
    const off = !person || !person.isActive || (person.expiresAt && new Date(person.expiresAt) <= new Date())
    if (!sessions.has(rec.serverKey)) sessions.set(rec.serverKey, (await adminSession(prisma, decrypt, accountId, rec.serverKey)).session)
    const session = sessions.get(rec.serverKey)
    if (!session) continue
    try {
      if (await setDisabled(session, rec.jellyfinUserId, !!off)) changes.push({ name: rec.name, off: !!off })
    } catch (e) {
      // An account deleted on the server is no longer ours to follow.
      if (e?.status === 404) await patchMap(prisma, accountId, 'jellyfinInviteAccounts', { [recordKey(rec.serverUrl, rec.jellyfinUserId)]: null })
      else console.warn(`[JellyfinInviteAccounts] ${rec.name}:`, e?.message)
    }
  }
  return changes
}

async function reconcileAll(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true } })
  for (const acc of accounts) {
    try {
      for (const c of await reconcileAccount(prisma, decrypt, acc.id)) {
        console.log(`[JellyfinInviteAccounts] ${c.name}'s Jellyfin account switched ${c.off ? 'off' : 'on'}`)
      }
    } catch (e) {
      console.warn('[JellyfinInviteAccounts] account failed:', e?.message)
    }
  }
}

let timer = null
function scheduleInviteAccounts(prisma, decrypt) {
  if (timer) clearInterval(timer)
  const run = () => reconcileAll(prisma, decrypt).catch((e) => console.warn('[JellyfinInviteAccounts] pass failed:', e?.message))
  setTimeout(run, 5 * 60 * 1000)
  timer = setInterval(run, RECONCILE_MS)
}

module.exports = {
  inviteServers, invitationServer, setInvitationServer, publicOffer, createForRequest,
  onAccepted, onRequestDropped, reconcileAccount, scheduleInviteAccounts, setDisabled,
}
