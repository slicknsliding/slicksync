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
  let deviceId
  if (body.quickConnectSecret) {
    deviceId = body.quickConnectDevice
    login = await jfAuth.quickConnectAuthenticate(probe.serverUrl, String(body.quickConnectSecret), { deviceId })
  } else {
    const username = String(body.jellyfinUsername ?? body.loginName ?? '').trim()
    if (!username) throw httpError(400, 'Enter the user name to sign in as')
    deviceId = jfAuth.signInDeviceId(probe.serverUrl, username)
    login = await jfAuth.authenticateByName(probe.serverUrl, username, String(body.password ?? ''), { deviceId })
  }
  // Before signing in, the kind is a guess from the server's name; signed in,
  // the server says which software it is, and that wins.
  const kind = await jfAuth.signedInKind(probe.serverUrl, login.token, { deviceId })
  const confirmed = kind && kind !== probe.kind ? { ...probe, kind, kindLabel: jfAuth.serverKindLabel(kind) } : probe
  return { probe: confirmed, login: { ...login, serverId: login.serverId || probe.serverId } }
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
 * Which stored sign-ins are on the server just signed in to: those stored
 * under the address signed in to, plus any `aliases` provenServerMatch has
 * proven are the same server. The id a server reports is whatever the server
 * at a typed-in address says it is, so on its own it never counts - trusting
 * it let anyone run a server that claimed a household's and sign in as its
 * people. Stored addresses are the normalised ones a probe produced, and so
 * is probe.serverUrl, so that is a comparison of normalised addresses - under
 * either scheme on an instance serving strangers, so a person who types the
 * other one is still found.
 */
function serverMatch(probe, login, aliases = []) {
  if (jfAuth.restrictsPrivateAddresses()) {
    const rest = /^https?:\/\/(.+)$/i.exec(String(probe.serverUrl || ''))?.[1]
    if (!rest) return { jellyfinServerUrl: probe.serverUrl }
    // The device a sign-in presents ignores the case of the address (see
    // jellyfinAuth.deviceIdFor), so a path typed in another case is the same
    // device, and its sign-in just retired the token stored under the
    // spelling it was added with. Those rows are the ones to refresh.
    const spellings = [...new Set([rest, rest.toLowerCase()])]
    return { OR: spellings.flatMap((r) => [{ jellyfinServerUrl: `https://${r}` }, { jellyfinServerUrl: `http://${r}` }]) }
  }
  const urls = [...new Set([probe.serverUrl, ...aliases].filter(Boolean))]
  return { OR: urls.map((u) => ({ jellyfinServerUrl: u })) }
}

/**
 * serverMatch, plus the other names a household's install reaches the same
 * server by (a LAN address, a hostname). A stored address counts only when
 * the server stored there accepts the token this sign-in just got, as the
 * same user: then it really is the server that issued it. Instances serving
 * strangers match by address alone.
 */
async function provenServerMatch(prisma, probe, login) {
  if (jfAuth.restrictsPrivateAddresses() || !login.serverId || !login.token) return serverMatch(probe, login)
  const rows = await prisma.user.findMany({
    where: { providerType: 'jellyfin', jellyfinServerId: login.serverId },
    select: { jellyfinServerUrl: true },
  }).catch(() => [])
  const aliases = []
  const others = [...new Set(rows.map((r) => r.jellyfinServerUrl).filter((u) => u && u !== probe.serverUrl))].slice(0, 10)
  for (const url of others) {
    try {
      const me = await jfAuth.currentUser(url, login.token, { timeoutMs: 5000 })
      if (me.userId === login.userId) aliases.push(url)
    } catch { /* not the server that issued it, or not reachable: not proven */ }
  }
  return serverMatch(probe, login, aliases)
}

/**
 * A server retires a user's previous token for a device the moment that
 * device signs in again, and SlickSync signs a server user in from one
 * device (see jellyfinAuth.signInDeviceId). So after any successful sign-in,
 * every SlickSync row holding the same server user - in any household, a
 * merged-in login, a pending invite request, a household profile - must take
 * the fresh token, or the one it holds has just stopped working. Found the
 * hard way: a second Add User for someone already added signed them out.
 *
 * Call it the moment the sign-in succeeds, before anything that can turn the
 * person away: the server has retired the old token whatever happens next.
 *
 * Which rows are "the same server user" is serverMatch's to say, and that is
 * what keeps this safe: the sign-in comes from a server the caller named, and
 * what it says about itself (its id, the ids in its reply) is whatever it
 * likes. Each row is sealed for its own household.
 */
async function rememberSignIn(prisma, encrypt, probe, login) {
  const sealed = (accountId) => encrypt(login.token, { appAccountId: accountId || 'default' })
  try {
    const match = await provenServerMatch(prisma, probe, login)
    // On an instance serving strangers, a row that never held a sign-in has
    // nothing the server could have retired, and nothing proves its address
    // and user id were ever signed in to - so it is not handed one.
    const held = jfAuth.restrictsPrivateAddresses() ? { jellyfinToken: { not: null } } : {}
    const where = { jellyfinUserId: login.userId, ...match, ...held }
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
    // A stored credential has no household column; whose it is follows from
    // the person it belongs to.
    const credentials = await prisma.userProviderCredential.findMany({ where: { providerType: 'jellyfin', ...where }, select: { id: true, userId: true } })
    if (credentials.length) {
      const owners = await prisma.user.findMany({ where: { id: { in: credentials.map((c) => c.userId) } }, select: { id: true, accountId: true } })
      const household = new Map(owners.map((o) => [o.id, o.accountId]))
      for (const c of credentials) {
        await prisma.userProviderCredential.update({ where: { id: c.id }, data: { jellyfinToken: sealed(household.get(c.userId)) } })
      }
    }
    const requests = await prisma.inviteRequest.findMany({ where: { providerType: 'jellyfin', status: 'pending', ...where }, select: { id: true, accountId: true } })
    for (const r of requests) {
      await prisma.inviteRequest.update({ where: { id: r.id }, data: { jellyfinToken: sealed(r.accountId) } })
    }
    // A household profile of someone on the same server (utils/jellyfinProfiles.js).
    const owners = await prisma.user.findMany({ where: { providerType: 'jellyfin', ...match, ...held }, select: { id: true } })
    if (owners.length) {
      const profiles = await prisma.jellyfinProfile.findMany({
        where: { ownerUserId: { in: owners.map((o) => o.id) }, jellyfinUserId: login.userId, ...(jfAuth.restrictsPrivateAddresses() ? { token: { not: null } } : {}) },
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

/**
 * Whether a token really is this server user's on this server: the server
 * itself, reached the way any address on an instance serving strangers is
 * (public addresses only, redirects included), says whose it is.
 */
async function signInProven(serverUrl, token, userId, { timeoutMs = 8000 } = {}) {
  const url = jfAuth.normalizeServerUrl(serverUrl)
  if (!url || typeof token !== 'string' || !token || !userId) return false
  try {
    const me = await jfAuth.currentUser(url, token, { timeoutMs, checkAddress: true })
    return me.userId === String(userId).replace(/-/g, '').toLowerCase()
  } catch {
    return false
  }
}

/**
 * What an imported file says about Jellyfin sign-ins is only kept once the
 * server vouches for it (an import onto an instance serving strangers). A
 * file can claim any address and user id; a token that the server at that
 * address says belongs to that user is the one thing it cannot make up.
 *
 * `users` are the file's people, as decrypted by the export. Returns, per
 * person, the normalised address when the person's sign-in is proven (else
 * null), and per household profile whether its own token is proven against
 * its owner's address. At most `max` servers are asked, `limit` at a time;
 * anything past that counts as unproven and the person reconnects.
 */
async function proveImportedSignIns(users, { limit = 4, max = 200 } = {}) {
  const list = Array.isArray(users) ? users : []
  const personUrl = new Map()
  const profileProven = new Map()
  let budget = max
  const jobs = []
  const queue = (job) => {
    if (budget <= 0) return
    budget -= 1
    jobs.push(job)
  }
  for (const u of list) {
    if (!u || typeof u !== 'object') continue
    personUrl.set(u, null)
    queue(async () => {
      if (await signInProven(u.jellyfinServerUrl, u.jellyfinToken, u.jellyfinUserId)) {
        personUrl.set(u, jfAuth.normalizeServerUrl(u.jellyfinServerUrl))
      }
    })
  }
  const run = async () => {
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try { await job() } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
    jobs.length = 0
    next = 0
  }
  await run()
  for (const u of list) {
    const profiles = u && typeof u === 'object' && u.jellyfinHousehold && Array.isArray(u.jellyfinHousehold.profiles) ? u.jellyfinHousehold.profiles : []
    const ownerUrl = personUrl.get(u)
    for (const p of profiles) {
      if (!p || typeof p !== 'object') continue
      profileProven.set(p, false)
      if (!ownerUrl || !p.token) continue
      queue(async () => {
        if (await signInProven(ownerUrl, String(p.token), p.jellyfinUserId)) profileProven.set(p, true)
      })
    }
  }
  await run()
  return { personUrl, profileProven }
}

/** The SlickSync user already holding this server user, in one account. */
async function findJellyfinUser(prisma, accountId, login, probe) {
  return prisma.user.findFirst({
    where: { accountId, providerType: 'jellyfin', jellyfinUserId: login.userId, ...(await provenServerMatch(prisma, probe, login)) },
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

module.exports = { signInFromBody, rememberSignIn, serverMatch, provenServerMatch, signInProven, proveImportedSignIns, jellyfinFields, findJellyfinUser, describeProbe, mountSignInSteps, sendError, httpError }
