// Signing someone in to a Jellyfin-compatible server, shared by every place a
// person can connect one: Add User, the user portal's sign-in, the admin
// sign-in on a public instance, and invitations.
//
// The browser never holds the server's access token. It sends what the person
// typed (or a Quick Connect secret), the server signs in here, and only the
// SlickSync user that results goes back.

const jfAuth = require('../providers/jellyfinAuth')

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra })
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500
  const message = status === 500 ? fallback : (error?.message || fallback)
  // A rejected server sign-in is the server saying no, not this session
  // ending - and the admin pages treat any 401 as "signed out of SlickSync".
  const sent = status === 401 || status === 403 || status === 502 ? 400 : status
  return res.status(sent).json({
    error: message,
    message,
    ...(error?.pinNeeded ? { pinNeeded: true } : {}),
  })
}

/**
 * Sign in with what the person gave: an address plus a user name and
 * password, or an address plus an approved Quick Connect secret. Returns the
 * server's description and the sign-in.
 */
async function signInFromBody(body = {}) {
  const serverUrl = String(body.serverUrl || '').trim()
  if (!serverUrl) throw httpError(400, 'Enter the server address')
  const probe = await jfAuth.probeServer(serverUrl)
  let login
  if (body.quickConnectSecret) {
    login = await jfAuth.quickConnectAuthenticate(probe.serverUrl, String(body.quickConnectSecret), { deviceId: body.quickConnectDevice })
  } else {
    const username = String(body.jellyfinUsername ?? body.loginName ?? '').trim()
    if (!username) throw httpError(400, 'Enter the user name to sign in as')
    login = await jfAuth.authenticateByName(probe.serverUrl, username, String(body.password ?? ''))
  }
  return { probe, login: { ...login, serverId: login.serverId || probe.serverId } }
}

/** The columns a User (or an invite request) stores for this sign-in. */
function jellyfinFields(probe, login, encrypt, req) {
  return {
    providerType: 'jellyfin',
    jellyfinServerUrl: probe.serverUrl,
    jellyfinServerId: login.serverId || probe.serverId || null,
    jellyfinServerKind: probe.kind,
    jellyfinUserId: login.userId,
    jellyfinUserName: login.userName || null,
    jellyfinToken: encrypt(login.token, req),
  }
}

/**
 * A server retires a user's previous token for a device the moment that
 * device signs in again, and SlickSync signs a server user in from one
 * device (see jellyfinAuth.deviceIdFor). So after any successful sign-in,
 * every SlickSync row holding that same server user - in any account, a
 * merged-in login, a pending invite request - must take the fresh token, or
 * the one it holds has just stopped working. Found the hard way: a second
 * Add User for someone already added signed them out.
 */
async function rememberSignIn(prisma, encrypt, probe, login) {
  const servers = [{ jellyfinServerUrl: probe.serverUrl }]
  if (login.serverId) servers.unshift({ jellyfinServerId: login.serverId })
  const where = { jellyfinUserId: login.userId, OR: servers }
  const sealed = (accountId) => encrypt(login.token, { appAccountId: accountId || 'default' })
  try {
    const users = await prisma.user.findMany({
      where: { providerType: 'jellyfin', ...where },
      select: { id: true, accountId: true, username: true, providerType: true, jellyfinServerUrl: true, jellyfinServerKind: true, providerConnectionError: true, providerConnectionErrorAt: true },
    })
    for (const u of users) {
      await prisma.user.update({
        where: { id: u.id },
        data: { jellyfinToken: sealed(u.accountId), providerConnectionError: null, providerConnectionErrorAt: null },
      })
      // A sign-in that had stopped working is fixed by this one - from a
      // Reconnect, or the person signing in on their own page. Say so, as
      // the activity monitor would once it read them again.
      if (u.providerConnectionErrorAt) {
        await require('./connectionAlerts').onConnectionRecovered(prisma, u.accountId || 'default', u).catch(() => {})
      }
    }
    const credentials = await prisma.userProviderCredential.findMany({ where: { providerType: 'jellyfin', ...where }, select: { id: true, userId: true } })
    for (const c of credentials) {
      const owner = await prisma.user.findUnique({ where: { id: c.userId }, select: { accountId: true } })
      await prisma.userProviderCredential.update({ where: { id: c.id }, data: { jellyfinToken: sealed(owner?.accountId) } })
    }
    const requests = await prisma.inviteRequest.findMany({ where: { providerType: 'jellyfin', status: 'pending', ...where }, select: { id: true, accountId: true } })
    for (const r of requests) {
      await prisma.inviteRequest.update({ where: { id: r.id }, data: { jellyfinToken: sealed(r.accountId) } })
    }
    // A household profile of someone on the same server (utils/jellyfinProfiles.js).
    const owners = await prisma.user.findMany({ where: { providerType: 'jellyfin', OR: servers }, select: { id: true } })
    if (owners.length) {
      const profiles = await prisma.jellyfinProfile.findMany({
        where: { ownerUserId: { in: owners.map((o) => o.id) }, jellyfinUserId: login.userId },
        select: { id: true, accountId: true },
      })
      for (const p of profiles) {
        await prisma.jellyfinProfile.update({ where: { id: p.id }, data: { token: sealed(p.accountId), needsPin: false } })
      }
    }
  } catch (e) {
    console.warn('[Jellyfin] Could not hand the fresh sign-in to everyone holding it:', e?.message)
  }
}

/** The SlickSync user already holding this server user, in one account. */
async function findJellyfinUser(prisma, accountId, login, probe) {
  const ors = []
  if (login.serverId) ors.push({ jellyfinServerId: login.serverId })
  ors.push({ jellyfinServerUrl: probe.serverUrl })
  return prisma.user.findFirst({
    where: { accountId, providerType: 'jellyfin', jellyfinUserId: login.userId, OR: ors },
  })
}

/** What a picker shows for a server, without anything secret. */
function describeProbe(probe) {
  return {
    serverUrl: probe.serverUrl,
    serverName: probe.serverName,
    kind: probe.kind,
    kindLabel: probe.kindLabel,
    version: probe.version,
    users: probe.users,
    quickConnect: probe.quickConnect,
    pinSignIn: probe.pinSignIn,
    display: jfAuth.displayServer(probe.serverUrl),
  }
}

/**
 * The steps that come before signing in - checking an address and running
 * Quick Connect - which touch no SlickSync data. Mounted on each router that
 * signs people in, under `prefix`.
 */
function mountSignInSteps(router, prefix = '') {
  router.post(`/${prefix}probe`, async (req, res) => {
    try {
      const probe = await jfAuth.probeServer(req.body?.serverUrl)
      res.json(describeProbe(probe))
    } catch (error) {
      sendError(res, error, 'Could not reach the server')
    }
  })

  router.post(`/${prefix}quick-connect`, async (req, res) => {
    try {
      const probe = await jfAuth.probeServer(req.body?.serverUrl)
      if (!probe.quickConnect) throw httpError(400, 'Quick Connect is turned off on this server')
      const started = await jfAuth.quickConnectInitiate(probe.serverUrl)
      res.json({ code: started.code, secret: started.secret, device: started.deviceId, serverUrl: probe.serverUrl })
    } catch (error) {
      sendError(res, error, 'Could not start Quick Connect')
    }
  })

  router.post(`/${prefix}quick-connect-status`, async (req, res) => {
    try {
      const serverUrl = jfAuth.normalizeServerUrl(req.body?.serverUrl)
      if (!serverUrl || !req.body?.secret) throw httpError(400, 'serverUrl and secret are required')
      const status = await jfAuth.quickConnectStatus(serverUrl, String(req.body.secret), { deviceId: req.body?.device })
      res.json(status)
    } catch (error) {
      if (error?.status === 404) return res.json({ authenticated: false, expired: true })
      sendError(res, error, 'Could not check Quick Connect')
    }
  })
}

module.exports = { signInFromBody, rememberSignIn, jellyfinFields, findJellyfinUser, describeProbe, mountSignInSteps, sendError, httpError }
