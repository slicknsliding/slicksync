/**
 * Jellyfin-compatible servers - reaching one, telling which kind it is, and
 * signing in to it. Three kinds speak the same API: a real Jellyfin, the
 * media server every AIOStreams configuration runs, and AIOMetadata's.
 *
 * Used at connection time (Add User, sign-in, invitations) and by the
 * provider in ./jellyfin.js for every later request.
 */

const crypto = require('crypto')

const CLIENT_NAME = 'SlickSync'
const REQUEST_TIMEOUT_MS = 15000

let appVersion = '1.0.0'
try { appVersion = require('../../package.json').version || appVersion } catch {}

// On an instance that serves strangers, a server address is something anyone
// with an account typed in, so it may not point this server at its own
// network. A household instance has its Jellyfin on the LAN as a rule.
function restrictsPrivateAddresses() {
  try { return require('../utils/config').INSTANCE_TYPE === 'public' } catch { return false }
}

/**
 * The address as a base every API path can be appended to. People paste what
 * their browser shows - the web client's own pages, a trailing slash, the
 * hash route - and AIOStreams hands out addresses with a path of their own
 * (`/jellyfin`, `/jellyfin/u/<alias>`), which have to be kept.
 */
function normalizeServerUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url
  try { url = new URL(value) } catch { return '' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  url.hash = ''
  url.search = ''
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/web(\/index\.html)?$/i, '').replace(/\/index\.html$/i, '')
  return `${url.origin}${path}`
}

/** A device id that stays the same for one person, so a reconnect replaces their old sign-in instead of piling up new ones. */
function deviceIdFor(...parts) {
  return 'slicksync-' + crypto.createHash('sha256').update(parts.map((p) => String(p || '').toLowerCase()).join('|')).digest('hex').slice(0, 24)
}

function authorizationHeader({ token, deviceId } = {}) {
  let value = `MediaBrowser Client="${CLIENT_NAME}", Device="${CLIENT_NAME}", DeviceId="${deviceId || deviceIdFor('anonymous')}", Version="${appVersion}"`
  if (token) value += `, Token="${token}"`
  return value
}

/**
 * One request to a server. Throws an Error carrying `.status` on an HTTP
 * failure, so callers can tell a rejected sign-in from a server that is down.
 */
async function jfRequest(baseUrl, path, { method = 'GET', token, deviceId, body, timeoutMs = REQUEST_TIMEOUT_MS, checkAddress = restrictsPrivateAddresses() } = {}) {
  if (!baseUrl) throw Object.assign(new Error('No server address'), { status: 400 })
  if (checkAddress) {
    const { assertSafeUrl } = require('../utils/safeUrl')
    try { await assertSafeUrl(baseUrl) } catch (e) {
      throw Object.assign(new Error(e.message === 'blocked host' ? 'That address is on a private network, which this instance cannot reach' : `Server address not usable: ${e.message}`), { status: 400 })
    }
  }
  const headers = { Authorization: authorizationHeader({ token, deviceId }), Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw Object.assign(new Error(timedOut ? 'The server did not answer in time' : `Could not reach the server: ${e?.cause?.code || e?.message || 'network error'}`), { status: 502, unreachable: true })
  }
  const text = await res.text().catch(() => '')
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const message = (data && typeof data === 'object' && (data.Message || data.message)) || (typeof data === 'string' && data.length < 200 ? data : '') || `HTTP ${res.status}`
    throw Object.assign(new Error(message), { status: res.status })
  }
  return data
}

/**
 * Which kind of server answers here, before anyone signs in. AIOMetadata
 * names itself; AIOStreams and AIOMetadata both carry the `aiostreams`
 * extension block (AIOMetadata offers it so the AIOStreams apps work against
 * it), so the name is checked first. Only a first guess: AIOStreams already
 * names each configuration after its owner, and if AIOMetadata does the same
 * its servers would read as AIOStreams here - signing in settles it
 * (signedInKind).
 */
function serverKindOf(info) {
  if (!info || typeof info !== 'object') return 'jellyfin'
  if (String(info.ServerName || '').toLowerCase() === 'aiometadata') return 'aiometadata'
  if (info.aiostreams && typeof info.aiostreams === 'object') return 'aiostreams'
  return 'jellyfin'
}

/**
 * Which software answers, once signed in. AIOStreams and AIOMetadata each put
 * their own name in /System/Info's PackageName, which - unlike ServerName -
 * no configuration renames, and any signed-in user may read it there. A real
 * Jellyfin keeps that page for administrators, or names its own package, so
 * null means "go by the public answer".
 */
async function signedInKind(baseUrl, token, { deviceId } = {}) {
  try {
    const info = await jfRequest(baseUrl, '/System/Info', { token, deviceId })
    const pkg = String(info?.PackageName || '').toLowerCase()
    return pkg === 'aiostreams' || pkg === 'aiometadata' ? pkg : null
  } catch {
    return null
  }
}

const KIND_LABELS = { jellyfin: 'Jellyfin', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }
function serverKindLabel(kind) {
  return KIND_LABELS[kind] || 'Jellyfin'
}

/**
 * Reach the address and describe the server: its id, name and kind, who can
 * sign in from its public user list, and whether Quick Connect is on. An
 * address typed without a scheme is tried over https first, then http, since
 * a server on the LAN often has no certificate.
 */
async function probeServer(rawUrl) {
  const normalized = normalizeServerUrl(rawUrl)
  if (!normalized) throw Object.assign(new Error('That is not a server address'), { status: 400 })
  const candidates = [normalized]
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(rawUrl).trim()) && normalized.startsWith('https://')) {
    candidates.push(`http://${normalized.slice('https://'.length)}`)
  }
  let info = null
  let baseUrl = null
  let lastError = null
  for (const candidate of candidates) {
    try {
      info = await jfRequest(candidate, '/System/Info/Public')
      if (info && typeof info === 'object' && (info.Id || info.ProductName)) { baseUrl = candidate; break }
      lastError = Object.assign(new Error('That address answers, but not as a Jellyfin server'), { status: 400 })
    } catch (e) {
      lastError = e
      // A server that answered with an error is the right address; only a
      // failure to connect is worth another scheme.
      if (!e.unreachable) break
    }
  }
  if (!baseUrl) {
    if (lastError?.status === 404) throw Object.assign(new Error('That address answers, but not as a Jellyfin server'), { status: 400 })
    throw lastError || new Error('Could not reach the server')
  }

  const kind = serverKindOf(info)
  let users = []
  try {
    const list = await jfRequest(baseUrl, '/Users/Public')
    if (Array.isArray(list)) {
      users = list.map((u) => ({ id: u.Id, name: u.Name, hasPassword: u.HasPassword !== false })).filter((u) => u.id && u.name)
    }
  } catch { /* a server may hide its users */ }
  let quickConnect = false
  try { quickConnect = (await jfRequest(baseUrl, '/QuickConnect/Enabled')) === true } catch {}

  return {
    serverUrl: baseUrl,
    serverId: info.Id || null,
    serverName: info.ServerName || serverKindLabel(kind),
    version: info.Version || null,
    kind,
    kindLabel: serverKindLabel(kind),
    users,
    quickConnect,
    // AIOStreams only: lets a household user sign in with a PIN alone.
    pinSignIn: kind !== 'jellyfin' && info.aiostreams?.pinSignIn === true,
  }
}

function signInResult(baseUrl, data) {
  const token = data?.AccessToken
  const user = data?.User
  if (!token || !user?.Id) throw Object.assign(new Error('The server accepted the sign-in but sent no session'), { status: 502 })
  return {
    serverUrl: baseUrl,
    serverId: user.ServerId || data?.ServerId || null,
    token,
    userId: String(user.Id).replace(/-/g, '').toLowerCase(),
    userName: user.Name || '',
    isAdmin: user.Policy?.IsAdministrator === true,
  }
}

/** Sign in with a name and password. AIOStreams takes a PIN after the password as `password/1234`. */
async function authenticateByName(baseUrl, username, password, { deviceId } = {}) {
  try {
    const data = await jfRequest(baseUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      deviceId: deviceId || deviceIdFor(baseUrl, username),
      body: { Username: String(username || ''), Pw: String(password || '') },
    })
    return signInResult(baseUrl, data)
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      const pinNeeded = /pin required/i.test(e.message || '')
      throw Object.assign(new Error(pinNeeded ? 'This user has a PIN. Add it after the password, like password/1234.' : 'Wrong user name or password'), { status: 401, pinNeeded })
    }
    throw e
  }
}

/** Start Quick Connect: the code to approve on another signed-in device, and the secret to finish with. */
async function quickConnectInitiate(baseUrl, { deviceId } = {}) {
  const device = deviceId || deviceIdFor(baseUrl, 'quickconnect', crypto.randomBytes(6).toString('hex'))
  let data
  try {
    data = await jfRequest(baseUrl, '/QuickConnect/Initiate', { method: 'POST', deviceId: device })
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      throw Object.assign(new Error('Quick Connect is turned off on this server'), { status: 400 })
    }
    throw e
  }
  if (!data?.Code || !data?.Secret) throw Object.assign(new Error('The server did not start Quick Connect'), { status: 502 })
  return { code: String(data.Code), secret: String(data.Secret), deviceId: device }
}

/** Whether the code has been approved yet. */
async function quickConnectStatus(baseUrl, secret, { deviceId } = {}) {
  const data = await jfRequest(baseUrl, `/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`, { deviceId })
  return { authenticated: data?.Authenticated === true }
}

/** Trade an approved code for a sign-in. */
async function quickConnectAuthenticate(baseUrl, secret, { deviceId } = {}) {
  try {
    const data = await jfRequest(baseUrl, '/Users/AuthenticateWithQuickConnect', {
      method: 'POST',
      deviceId,
      body: { Secret: String(secret || '') },
    })
    return signInResult(baseUrl, data)
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 400) {
      throw Object.assign(new Error('That code has not been approved yet'), { status: 401 })
    }
    throw e
  }
}

/** Whether a stored sign-in still works, and who it belongs to. */
async function currentUser(baseUrl, token, { deviceId } = {}) {
  const me = await jfRequest(baseUrl, '/Users/Me', { token, deviceId })
  if (!me?.Id) throw Object.assign(new Error('Signed out'), { status: 401 })
  return { userId: String(me.Id).replace(/-/g, '').toLowerCase(), userName: me.Name || '' }
}

/**
 * Everyone a signed-in user can see on their server. On AIOStreams and
 * AIOMetadata that is the configuration's household: its main user (marked
 * administrator) and each user added under it. A user whose sign-in needs a
 * PIN is the one that cannot sign in automatically (EnableAutoLogin false).
 */
async function listServerUsers(baseUrl, token, { deviceId } = {}) {
  const list = await jfRequest(baseUrl, '/Users', { token, deviceId })
  if (!Array.isArray(list)) return []
  return list.filter((u) => u?.Id && u?.Name).map((u) => ({
    id: String(u.Id).replace(/-/g, '').toLowerCase(),
    name: String(u.Name),
    isMain: u.Policy?.IsAdministrator === true,
    needsPin: u.Configuration?.EnableAutoLogin === false || u.EnableAutoLogin === false,
  }))
}

/** Sign a stored session out of the server, when a person is removed. Best-effort. */
async function signOut(baseUrl, token, { deviceId } = {}) {
  try { await jfRequest(baseUrl, '/Sessions/Logout', { method: 'POST', token, deviceId, timeoutMs: 5000 }) } catch {}
}

/**
 * The address shown for a server - host, plus the path for AIOStreams and
 * AIOMetadata, where it names the configuration. Never the full address of an
 * AIOStreams picker that carries an encrypted password in its path.
 */
function displayServer(serverUrl) {
  try {
    const url = new URL(serverUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    const safe = parts.filter((p) => p.length <= 40).slice(0, 3)
    return `${url.host}${safe.length ? '/' + safe.join('/') : ''}`
  } catch {
    return String(serverUrl || '')
  }
}

/**
 * The identity a server login is stored under: SlickSync keys people by an
 * email, and a server user has none, so one is made from the user's id on
 * the server - unique, and the same every time they reconnect.
 */
function identityEmail(serverUrl, userId) {
  let host = 'jellyfin'
  try { host = new URL(serverUrl).hostname.toLowerCase() } catch {}
  return `${String(userId || '').toLowerCase()}@${host}`
}

module.exports = {
  CLIENT_NAME,
  normalizeServerUrl,
  deviceIdFor,
  authorizationHeader,
  jfRequest,
  serverKindOf,
  signedInKind,
  serverKindLabel,
  probeServer,
  authenticateByName,
  quickConnectInitiate,
  quickConnectStatus,
  quickConnectAuthenticate,
  currentUser,
  listServerUsers,
  signOut,
  displayServer,
  identityEmail,
  restrictsPrivateAddresses,
}
