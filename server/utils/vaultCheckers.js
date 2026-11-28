// Vault entry "active" checkers. Each returns { ok: boolean, message: string, expiresAt?: Date }
// testConfig is a parsed JSON object stored per-entry; shape varies by testType.

const { readBounded } = require('./boundedBody')

// A check only needs the start of a response; reading it whole would let a
// hostile or broken endpoint hold the process's memory or the check open.
async function readText(res, maxBytes = 1024 * 1024) {
  try { return (await readBounded(res, { maxBytes, timeoutMs: 15000 })).toString('utf8') } catch { return '' }
}

const net = require('net')
const tls = require('tls')
const dns = require('dns').promises
const { assertSafeUrl, safeFetch, instancePolicy, isPrivateIp, isLinkLocalIp } = require('./safeUrl')

// A check that reaches out to an address the account typed in goes through the
// same rule as every other such address (utils/safeUrl.js): an instance
// serving strangers may not point it at its own network, a household's own
// install may, and nobody may point it at link-local. A refusal is a plain
// "could not reach it" result for that entry - never a thrown error, and it is
// not retried.
const REFUSALS = new Set(['blocked host', 'unsupported protocol', 'invalid url', 'too many redirects'])

function timeoutSignal(ms) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
}

// fetch() with a per-attempt timeout, retried only on timeout/network
// failure - never on an HTTP response, however bad its status.
//
// Why this exists: several of these providers sit behind Cloudflare and
// intermittently stall. Measured live against TorBox from the production
// host: five consecutive requests returned in 187ms, 632ms, 210ms, 21265ms
// and 625ms. One unlucky request in five blew straight past the 10s abort,
// and a single slow response was enough to mark a perfectly valid
// credential as failing and fire a Vault alert for it.
//
// A retry is the right fix rather than simply a longer timeout: the normal
// case is sub-second, so waiting 30s for every check to accommodate a rare
// stall would slow every healthy check down. Retrying only the timeout path
// keeps the common case fast and makes the rare stall a non-event.
//
// Deliberately does NOT retry on a returned status. A 401 is a real answer
// about the credential and must surface immediately; retrying it would just
// hammer the provider and delay a genuine failure.
//
// `checked` is for an address the account chose (an HTTP check, an indexer):
// it is fetched through safeFetch, which also holds every redirect to the
// same rule. The providers' own fixed hosts are fetched as they always were.
async function fetchWithRetry(url, options = {}, { timeoutMs = 10000, attempts = 3, backoffMs = 750, checked = false } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { signal, cancel } = timeoutSignal(timeoutMs)
    try {
      const res = checked
        ? await safeFetch(url, { ...options, signal }, instancePolicy())
        : await fetch(url, { ...options, signal })
      cancel()
      return res
    } catch (err) {
      cancel()
      lastErr = err
      // Asking again would only be refused again.
      if (REFUSALS.has(err?.message)) throw err
      if (attempt < attempts) {
        // Linear backoff - these stalls look like transient upstream
        // congestion, so a short pause before retrying is enough.
        await new Promise((r) => setTimeout(r, backoffMs * attempt))
      }
    }
  }
  throw lastErr
}

// Shared shape for the catch block of every checker below, so a timeout
// reads the same way everywhere.
function describeRequestError(err) {
  if (err?.name === 'AbortError') return 'Timed out'
  switch (err?.message) {
    case 'invalid url':
      return 'That is not a valid web address'
    case 'unsupported protocol':
      return 'The test address must start with http:// or https://'
    case 'blocked host':
      return instancePolicy().allowPrivate
        ? 'That address is a link-local one (such as 169.254.x.x), which this server never connects to'
        : 'That address is on a private or internal network, which this server does not connect to'
    case 'unresolvable host':
      return 'That address could not be found'
    case 'too many redirects':
      return 'That address redirected too many times'
    default:
      return err?.message || 'Request failed'
  }
}

// Generic HTTP check: hits a URL, optionally injecting the secret as a bearer token,
// api-key header, or query param. Expects a status code and (optionally) a body substring.
async function checkGenericHttp(secret, config = {}) {
  const {
    url,
    method = 'GET',
    authMode = 'bearer', // 'bearer' | 'header' | 'query' | 'none'
    headerName = 'Authorization',
    queryParam = 'apikey',
    expectStatus = 200,
    bodyContains
  } = config

  if (!url) return { ok: false, message: 'No test URL configured' }

  let finalUrl = url
  const headers = {}
  if (authMode === 'bearer') headers['Authorization'] = `Bearer ${secret}`
  else if (authMode === 'header') headers[headerName] = secret
  else if (authMode === 'query') {
    const sep = url.includes('?') ? '&' : '?'
    finalUrl = `${url}${sep}${encodeURIComponent(queryParam)}=${encodeURIComponent(secret)}`
  }

  try {
    const res = await fetchWithRetry(finalUrl, { method, headers }, { checked: true })
    const text = await readText(res)
    const statusOk = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === expectStatus
    if (!statusOk) return { ok: false, message: `Unexpected status ${res.status}` }
    if (bodyContains && !text.includes(bodyContains)) return { ok: false, message: 'Response did not match expected content' }
    return { ok: true, message: `OK (${res.status})` }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// "Dec 31, 2026" - read in UTC so a midnight-UTC date never shows as the day
// before. Built by hand, not toLocaleDateString, so it reads the same under
// any runtime locale.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDay(d) {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}
function unixDate(secs) {
  const n = Number(secs)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : undefined
}
const expiresText = (expiresAt) => (expiresAt ? `, expires ${formatDay(expiresAt)}` : '')

// Real-Debrid: /user also reports premium expiration, which we surface back
// so the vault entry's expiresAt can auto-update from the source of truth.
async function checkRealDebrid(secret) {
  try {
    const res = await fetchWithRetry('https://api.real-debrid.com/rest/1.0/user', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `Real-Debrid returned ${res.status}` }
    const data = await res.json()
    const expiresAt = data?.expiration ? new Date(data.expiration) : undefined
    const type = data?.type || 'unknown'
    if (type !== 'premium') {
      return { ok: false, message: `Account type is "${type}", not premium`, expiresAt }
    }
    return { ok: true, message: `Premium${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// TorBox's /user/me `plan` number. The prices are TorBox's monthly list
// prices in US dollars, only ever offered as a one-tap suggestion for an
// empty Cost field - never written on their own.
const TORBOX_PLANS = {
  1: { name: 'Essential', monthlyUsd: 3 },
  2: { name: 'Pro', monthlyUsd: 10 },
  3: { name: 'Standard', monthlyUsd: 5 },
}

// TorBox: /user/me reports plan and premium_expires_at
async function checkTorBox(secret) {
  try {
    const res = await fetchWithRetry('https://api.torbox.app/v1/api/user/me', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `TorBox returned ${res.status}` }
    const data = await res.json()
    const d = data?.data || data
    const expiresAt = d?.premium_expires_at ? new Date(d.premium_expires_at) : undefined
    const plan = d?.plan
    if (plan === 0 || plan === undefined) {
      return { ok: false, message: 'No active TorBox plan', expiresAt }
    }
    const name = TORBOX_PLANS[plan]?.name
    return { ok: true, message: `${name ? `${name} plan` : 'Plan active'}${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// AllDebrid: /v4/user -> data.user.isPremium + premiumUntil (unix seconds).
async function checkAllDebrid(secret) {
  try {
    const res = await fetchWithRetry('https://api.alldebrid.com/v4/user?agent=slicksync', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `AllDebrid returned ${res.status}` }
    const data = await res.json()
    if (data?.status !== 'success') return { ok: false, message: data?.error?.message || 'AllDebrid turned the key down' }
    const user = data?.data?.user || {}
    const expiresAt = unixDate(user.premiumUntil)
    if (!user.isPremium) return { ok: false, message: 'No active AllDebrid premium', expiresAt }
    return { ok: true, message: `Premium${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Premiumize: /api/account/info -> premium_until (unix seconds, or false).
async function checkPremiumize(secret) {
  try {
    const res = await fetchWithRetry(`https://www.premiumize.me/api/account/info?apikey=${encodeURIComponent(secret)}`, {})
    if (!res.ok) return { ok: false, message: `Premiumize returned ${res.status}` }
    const data = await res.json()
    if (data?.status !== 'success') return { ok: false, message: data?.message || 'Premiumize turned the key down' }
    const expiresAt = unixDate(data.premium_until)
    if (!expiresAt || expiresAt.getTime() <= Date.now()) return { ok: false, message: 'No active Premiumize premium', expiresAt }
    return { ok: true, message: `Premium${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Debrid-Link: /api/v2/account/infos -> value.premiumLeft (seconds left).
async function checkDebridLink(secret) {
  try {
    const res = await fetchWithRetry('https://debrid-link.com/api/v2/account/infos', {
      headers: { Authorization: `Bearer ${secret}` }
    })
    if (!res.ok) return { ok: false, message: `Debrid-Link returned ${res.status}` }
    const data = await res.json()
    if (data?.success !== true) return { ok: false, message: 'Debrid-Link turned the key down' }
    const left = Number(data?.value?.premiumLeft)
    const expiresAt = Number.isFinite(left) && left > 0 ? new Date(Date.now() + left * 1000) : undefined
    if (!expiresAt) return { ok: false, message: 'No active Debrid-Link premium' }
    return { ok: true, message: `Premium${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Newznab-compatible indexers (NZBGeek, NinjaCentral, UsenetCrawler, DrunkenSlug, etc.)
// t=caps doesn't require a valid key on some indexers, so we also try t=search with
// a tiny result limit to actually exercise the key.
// Newznab's optional <newznab:apilimits apiCurrent="X" apiMax="Y"
// grabCurrent="Z" grabMax="W" /> element - per the spec, "clients should not
// assume the apilimits element or any of its attributes to be present" (it's
// entirely up to the indexer software whether to include it), and its shape
// is only ever documented for XML, not o=json - so this check now requests
// XML specifically and regex-extracts the element if present, rather than
// pulling in a full XML parser dependency for one self-closing tag. Absent
// on indexers that don't support it is expected, not an error.
function parseNewznabApiLimits(xmlText) {
  const m = xmlText.match(/<newznab:apilimits\b([^/>]*)\/?>/i)
  if (!m) return null
  const attrs = {}
  const attrRegex = /(\w+)="([^"]*)"/g
  let attrMatch
  while ((attrMatch = attrRegex.exec(m[1]))) {
    attrs[attrMatch[1]] = attrMatch[2]
  }
  const apiCurrent = Number(attrs.apiCurrent)
  const apiMax = Number(attrs.apiMax)
  if (Number.isNaN(apiCurrent) || Number.isNaN(apiMax)) return null
  return { apiCurrent, apiMax }
}

async function checkNewznabCaps(secret, config = {}) {
  const { url } = config
  if (!url) return { ok: false, message: 'No indexer base URL configured' }
  const base = url.replace(/\/+$/, '')
  try {
    const testUrl = `${base}/api?t=caps&apikey=${encodeURIComponent(secret)}`
    // Node's fetch sends no User-Agent at all by default, which reads as a
    // bare script to a lot of indexers' own bot-protection (Cloudflare, etc.)
    // and can produce a 403 that has nothing to do with the API key itself.
    // A normal browser UA costs nothing and rules that out as a cause.
    const res = await fetchWithRetry(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } }, { checked: true })
    if (res.status === 403) {
      return { ok: false, message: 'Indexer returned 403 - likely blocking this server\'s IP (common for private indexers/Usenet providers toward cloud/VPS hosting ranges), not necessarily the API key' }
    }
    if (!res.ok) return { ok: false, message: `Indexer returned ${res.status}` }
    const text = await readText(res)
    if (/error/i.test(text) && /apikey|api key|invalid/i.test(text)) {
      return { ok: false, message: 'API key rejected' }
    }
    const limits = parseNewznabApiLimits(text)
    if (limits) {
      const quotaSuffix = ` (${limits.apiCurrent}/${limits.apiMax} API calls used today)`
      if (limits.apiCurrent >= limits.apiMax) {
        return { ok: false, message: `Daily API quota exhausted${quotaSuffix}` }
      }
      return { ok: true, message: `Indexer reachable, key accepted${quotaSuffix}` }
    }
    return { ok: true, message: 'Indexer reachable, key accepted' }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Raw TCP reachability — for things like Usenet NNTP servers where a full protocol
// login check isn't implemented. Confirms the host:port accepts a connection, nothing more.
//
// The host is held to the same rule as an HTTP address, and the connection is
// made to an address that was vetted rather than to the name again - a name
// that answers differently the second time cannot steer it somewhere else.
// IPv4 addresses come first: a container that has no IPv6 route would
// otherwise stall on a host's AAAA record, which dialling the name itself
// never did.
async function vettedTcpAddresses(host) {
  const policy = instancePolicy()
  const bare = String(host).trim().replace(/^\[|\]$/g, '')
  const url = await assertSafeUrl(`http://${net.isIP(bare) === 6 ? `[${bare}]` : bare}`, policy)
  // A bare host only: a port or path glued on would be read by the URL parser
  // but not by the socket, which would then dial something else.
  if (url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid url')
  const name = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(name)) return [name]
  const refused = policy.allowPrivate ? isLinkLocalIp : isPrivateIp
  let addresses
  try { addresses = await dns.lookup(name, { all: true }) } catch { throw new Error('unresolvable host') }
  if (!addresses.length) throw new Error('unresolvable host')
  if (addresses.some((a) => refused(a.address))) throw new Error('blocked host')
  return [...addresses].sort((a, b) => a.family - b.family).map((a) => a.address)
}

function dialOnce(address, port, label) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port: Number(port), timeout: 8000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve({ ok: true, message: `${label} reachable (connectivity only, not a login check)` })
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve({ ok: false, message: 'Connection timed out' })
    })
    socket.once('error', (err) => {
      resolve({ ok: false, message: err?.message || 'Connection failed' })
    })
  })
}

async function checkTcpReachability(secret, config = {}) {
  const { host, port } = config
  if (!host || !port) return { ok: false, message: 'No host/port configured' }
  let addresses
  try {
    addresses = await vettedTcpAddresses(host)
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
  let result
  for (const address of addresses) {
    result = await dialOnce(address, port, `${host}:${port}`)
    if (result.ok) break
  }
  return result
}

// ---------------------------------------------------------------------------
// Usenet provider sign-in (NNTP). The conversation itself is a pure function
// over a line-based connection ({ readLine(): Promise<string>, writeLine(s) }),
// so a test can drive it with no network; checkNntpAuth below wires it to a
// real socket. Neither the user name nor the password ever appears in a
// message the check returns.
const NNTP_DEADLINE_MS = 10000
const NNTP_BUSY_RE = /too many|max(imum)? (number of )?connections|connection limit|limit (reached|exceeded)|try again|busy|temporar|overload/i

const nntpCode = (line) => {
  const m = /^(\d{3})\b/.exec(String(line || ''))
  return m ? Number(m[1]) : 0
}
const NNTP_REFUSED = { ok: false, message: 'The server turned the username or password down' }
const NNTP_BUSY = { ok: null, transient: true, message: 'The server is busy; try again later' }

// What a non-success reply means: busy (400, or 502 that talks about
// connections), turned down (481, 482, any other 502), or unexpected.
function nntpTroubleOf(line) {
  const code = nntpCode(line)
  if (code === 400) return { ...NNTP_BUSY }
  if (code === 502) return NNTP_BUSY_RE.test(String(line)) ? { ...NNTP_BUSY } : { ...NNTP_REFUSED }
  if (code === 481 || code === 482) return { ...NNTP_REFUSED }
  return { ok: false, message: 'The server did not answer like a Usenet server' }
}

async function nntpConversation(conn, { host, username, password }) {
  try {
    const greeting = await conn.readLine()
    const greetCode = nntpCode(greeting)
    if (greetCode !== 200 && greetCode !== 201) {
      if (greetCode === 400 || greetCode === 502) return nntpTroubleOf(greeting)
      return { ok: false, message: 'The server did not answer like a Usenet server' }
    }
    await conn.writeLine(`AUTHINFO USER ${username}`)
    const userReply = await conn.readLine()
    const userCode = nntpCode(userReply)
    if (userCode === 281) return { ok: true, message: `Signed in to ${host}` }
    if (userCode !== 381) return nntpTroubleOf(userReply)
    await conn.writeLine(`AUTHINFO PASS ${password}`)
    const passReply = await conn.readLine()
    if (nntpCode(passReply) === 281) return { ok: true, message: `Signed in to ${host}` }
    return nntpTroubleOf(passReply)
  } finally {
    try { await conn.writeLine('QUIT') } catch { /* the connection may already be gone */ }
  }
}

// The login a Usenet provider entry stores: a JSON { username, password }.
function nntpLogin(secret) {
  try {
    const parsed = JSON.parse(String(secret || ''))
    if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string' && parsed.username && parsed.password) {
      return { username: parsed.username, password: parsed.password }
    }
  } catch { /* not a login */ }
  return null
}

function openNntpSocket(address, port, tlsOn, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tlsOn
      ? tls.connect({ host: address, port: Number(port), servername: net.isIP(servername) ? undefined : servername })
      : net.createConnection({ host: address, port: Number(port) })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Connection timed out')) }, Math.max(1, timeoutMs))
    const onError = (err) => { clearTimeout(timer); socket.destroy(); reject(new Error(err?.message || 'Connection failed')) }
    socket.once('error', onError)
    socket.once(tlsOn ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

// Lines in, lines out, over a connected socket; a read fails when the
// connection ends or the shared deadline passes.
function nntpLineConnection(socket, deadlineMs) {
  let buffer = ''
  let failure = null
  const lines = []
  const waiting = []
  const fail = (err) => {
    if (failure) return
    failure = err
    while (waiting.length) waiting.shift().reject(err)
  }
  const timer = setTimeout(() => { fail(new Error('Connection timed out')); socket.destroy() }, Math.max(1, deadlineMs))
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '')
      buffer = buffer.slice(i + 1)
      if (waiting.length) waiting.shift().resolve(line)
      else lines.push(line)
    }
  })
  socket.on('error', (err) => fail(new Error(err?.message || 'Connection failed')))
  socket.on('close', () => fail(new Error('The server closed the connection')))
  return {
    readLine: () => {
      if (lines.length) return Promise.resolve(lines.shift())
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    },
    writeLine: (text) => new Promise((resolve, reject) => {
      if (failure || socket.destroyed) return reject(failure || new Error('Connection closed'))
      socket.write(`${text}\r\n`, (err) => (err ? reject(err) : resolve()))
    }),
    done: () => clearTimeout(timer),
  }
}

async function checkNntpAuth(secret, config = {}) {
  const login = nntpLogin(secret)
  // No login on file: all that can be said is whether the server answers.
  if (!login) return checkTcpReachability(secret, config)
  const { host, port } = config
  if (!host || !port) return { ok: false, message: 'No host/port configured' }
  let addresses
  try {
    addresses = await vettedTcpAddresses(host)
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
  const deadline = Date.now() + NNTP_DEADLINE_MS
  const tlsOn = config.ssl !== false
  let socket = null
  let lastError = null
  for (const address of addresses) {
    const left = deadline - Date.now()
    if (left <= 0) break
    try {
      socket = await openNntpSocket(address, port, tlsOn, String(host).trim(), Math.min(left, 8000))
      break
    } catch (err) { lastError = err }
  }
  if (!socket) return { ok: false, message: lastError?.message || 'Connection timed out' }
  const conn = nntpLineConnection(socket, deadline - Date.now())
  try {
    return await nntpConversation(conn, { host, ...login })
  } catch (err) {
    return { ok: false, message: err?.message === 'Connection timed out' ? 'Connection timed out' : 'The server stopped answering' }
  } finally {
    conn.done()
    socket.destroy()
  }
}

// Jellyfin (or the Jellyfin side of an AIOStreams setup): sign in with the
// user name and password. The sign-in uses a device of its own - a server
// retires a user's earlier session for the same device, and SlickSync's own
// stored session must not be the one that gets retired.
async function checkJellyfinAuth(secret, config = {}) {
  const jf = require('../providers/jellyfinAuth')
  const base = jf.normalizeServerUrl(config.url)
  if (!base) return { ok: false, message: 'No server address on file for this entry' }
  const username = config.identifier
  if (!username) return { ok: false, message: 'No user name on file for this entry' }
  if (!secret) return { ok: false, message: 'No password on file for this entry' }
  try {
    const res = await safeFetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        Authorization: jf.authorizationHeader({ deviceId: jf.deviceIdFor('vault-check', base, username), deviceName: 'SlickSync Vault check' }),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Username: String(username), Pw: String(secret) }),
      signal: AbortSignal.timeout(10000),
    }, instancePolicy())
    let token = null
    if (res.ok) {
      try { token = JSON.parse(await readText(res))?.AccessToken || null } catch { token = null }
    } else {
      try { res.body?.cancel?.() } catch { /* nothing to drop */ }
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The server turned the username or password down' }
    if (res.status === 429 || res.status >= 500) return { ok: null, transient: true, message: 'The server is busy; try again later' }
    if (!res.ok) return { ok: false, message: `The server returned ${res.status}` }
    if (!token) return { ok: false, message: 'That address did not answer like a Jellyfin server' }
    // Leave no extra sign-in behind on the server's device list.
    await jf.signOut(base, token, { deviceId: jf.deviceIdFor('vault-check', base, username) }).catch(() => {})
    return { ok: true, message: 'Signed in' }
  } catch (err) {
    if (err?.name === 'TimeoutError') return { ok: false, message: 'Timed out' }
    return { ok: false, message: describeRequestError(err) }
  }
}

// An AIOStreams configuration: its UUID and password open the configuration
// the same way SlickSync reads a person's setup (utils/aiostreamsConfig.js).
async function checkAiostreamsConfig(secret, config = {}) {
  if (!config.url) return { ok: false, message: 'No AIOStreams address on file for this entry' }
  if (!config.uuid) return { ok: false, message: 'No configuration UUID on file for this entry' }
  if (!secret) return { ok: false, message: 'No configuration password on file for this entry' }
  try {
    const { readConfig } = require('./aiostreamsConfig')
    await readConfig({ serverUrl: config.url, account: String(config.uuid).trim(), password: secret })
    return { ok: true, message: 'Configuration opens with this password' }
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) return { ok: false, message: 'AIOStreams turned the UUID or password down' }
    if (err?.status === 429 || err?.status >= 500) return { ok: null, transient: true, message: 'AIOStreams is busy; try again later' }
    return { ok: false, message: err?.message || 'Could not open the configuration' }
  }
}

// TMDb / OMDb / MDBList / RPDB keys: the checks Settings already runs
// (metadataKeyHealth.js), mapped to this shape. A rate limit says nothing
// about the key itself, so it is left as "unknown" and not raised.
function metadataKeyChecker(name) {
  return async (secret) => {
    if (!secret) return { ok: false, message: 'No API key on file for this entry' }
    const r = await require('./metadataKeyHealth')[name](String(secret).trim())
    if (r.rateLimited) return { ok: null, transient: true, message: r.message }
    return { ok: !!r.ok, message: r.message }
  }
}

// Stremio account credentials: config.identifier is the email/username (stored in
// the entry's `provider` field), secret is the password. Confirms Stremio actually
// accepts the login, not just that some server responded.
async function checkStremioAuth(secret, config = {}) {
  const identifier = config.identifier
  if (!identifier) return { ok: false, message: 'No email/username on file for this entry' }
  if (!secret) return { ok: false, message: 'No password on file for this entry' }

  // Write diagnostics directly to a file on the persisted data volume,
  // bypassing stdout/stderr entirely. console.warn output has not reliably
  // shown up in `docker logs` for this backend process even with stdbuf
  // line-buffering applied (see v1.9.2/v1.9.22) - bun's own I/O internals
  // may not route through the glibc buffered-stdio calls stdbuf intercepts,
  // so a direct synchronous file write is the more reliable diagnostic path
  // until that's confirmed one way or the other.
  // Owner-read-write only — this log can carry auth-adjacent Stremio API
  // details, so it should never be world-readable even on lax deploys.
  // appendFileSync doesn't accept a mode, so we ensure the file exists with
  // 0o600 the first time we're about to write to it.
  const LOG_PATH = '/app/data/vault-debug.log'
  function logDebug(entry) {
    try {
      const fs = require('fs')
      if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '', { mode: 0o600 })
      // Redact `authKey` from any nested Stremio API response before writing.
      // Stremio's successful-login response includes a live authKey which,
      // if this log ever leaked, would grant full account access — we don't
      // need it for the "did login succeed" question the diagnostic answers.
      const redacted = JSON.parse(JSON.stringify(entry, (k, v) => k === 'authKey' && v ? '[redacted]' : v))
      const line = `[${new Date().toISOString()}] ${JSON.stringify(redacted)}\n`
      require('./debugLogFile').appendCapped(LOG_PATH, line)
    } catch (e) {
      console.warn('[VaultCheck] Failed to write debug log:', e?.message)
    }
  }

  try {
    const { StremioAPIUtils } = require('./handlers')
    const { store } = StremioAPIUtils.createAPIStore()

    // Bypass store.login()'s wrapper (which discards the raw API response -
    // see v1.9.24) and call the underlying request directly, so we can see
    // exactly what Stremio's API actually returned rather than inferring it
    // from side-effects. This is ground truth: if result.authKey is present,
    // the login genuinely succeeded at the API level, full stop.
    let rawResult
    let rawErr
    try {
      rawResult = await store.request('login', { email: identifier, password: secret })
    } catch (e) {
      rawErr = e
    }

    logDebug({
      event: 'stremio_raw_login_response',
      // Never the response itself: a successful one carries the sign-in key.
      gotAuthKey: !!rawResult?.authKey,
      rawError: rawResult?.error || rawResult?.message,
      rawErrMessage: rawErr?.message,
      rawErrStatus: rawErr?.status || rawErr?.statusCode,
      rawErrBody: rawErr?.body || rawErr?.response
    })

    if (rawErr) throw rawErr

    if (rawResult && rawResult.authKey) {
      return { ok: true, message: 'Stremio login succeeded' }
    }

    const detail = rawResult && typeof rawResult === 'object'
      ? (rawResult.error || rawResult.message || JSON.stringify(rawResult).slice(0, 200))
      : null
    return { ok: false, message: detail ? `Stremio rejected these credentials: ${detail}` : 'Stremio rejected these credentials (no further detail returned - check /app/data/vault-debug.log)' }
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase()
    if (msg.includes('passphrase') || msg.includes('wrong password')) return { ok: false, message: 'Invalid password' }
    if (msg.includes('no such user') || msg.includes('invalid email')) return { ok: false, message: 'Invalid email' }
    if (msg.includes('rate') || msg.includes('too many') || msg.includes('429')) return { ok: null, transient: true, message: 'Stremio rate-limited this login attempt - try again later, not necessarily a bad password' }
    logDebug({ event: 'stremio_auth_threw', message: err?.message, stack: err?.stack })
    console.warn('[VaultCheck] Stremio auth threw:', err?.message)
    return { ok: false, message: err?.message || 'Stremio login failed' }
  }
}

// Nuvio account credentials: same shape as Stremio's checker above.
async function checkNuvioAuth(secret, config = {}) {
  const identifier = config.identifier
  if (!identifier) return { ok: false, message: 'No email/username on file for this entry' }
  if (!secret) return { ok: false, message: 'No password on file for this entry' }

  try {
    const { validateNuvioCredentials } = require('../providers/nuvioAuth')
    await validateNuvioCredentials(identifier, secret)
    return { ok: true, message: 'Nuvio login succeeded' }
  } catch (err) {
    // Turned away for being busy (rate limit) or down: no answer about the
    // password, so not a failure (transient: the monitor keeps the last one).
    if (err?.status === 429 || err?.status >= 500) return { ok: null, transient: true, message: 'Nuvio was too busy to check this login - try again later, not necessarily a bad password' }
    return { ok: false, message: err?.message || 'Nuvio login failed' }
  }
}

// GET /models on an AI Services address. The address is whatever the account
// entered (any OpenAI-compatible endpoint), so it is fetched the way the chat
// calls fetch it (postChat in nlCatalog.js): a household's install may point it
// at a model on its own network, an instance serving strangers may not be
// pointed at its own. A refusal reads the same wherever it surfaces - the
// Vault check below and Settings' model list.
async function fetchAiModels(base, apiKey, signal) {
  try {
    return await safeFetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }, instancePolicy())
  } catch (err) {
    if (/^(blocked host|unsupported protocol|invalid url|unresolvable host|too many redirects)$/.test(err?.message || '')) {
      throw new Error('The AI Services address cannot be used from this server - check it under Settings -> External API Keys')
    }
    throw err
  }
}

// AI Services entries (category 'ai', created by Settings' AI front door).
// GET /models against the entry's own configured base URL - the cheapest
// call every OpenAI-compatible provider implements, and the same endpoint
// Settings' model dropdown already relies on. These entries used to be
// testType 'manual', which disabled the Vault card's check button entirely -
// the one credential with a rich live API was the one you couldn't test.
async function checkOpenAiCompatible(secret, config = {}) {
  if (!secret) return { ok: false, message: 'No API key on file for this entry' }
  const base = (typeof config.baseUrl === 'string' && config.baseUrl.trim())
    ? config.baseUrl.trim().replace(/\/+$/, '')
    : 'https://api.openai.com/v1'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let res
    try {
      res = await fetchAiModels(base, secret, controller.signal)
    } finally { clearTimeout(timer) }
    if (res.ok) return { ok: true, message: 'Provider accepted the key' }
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Provider rejected the key (${res.status})` }
    if (res.status === 429) return { ok: false, message: 'Provider is rate-limiting this key (429)' }
    return { ok: false, message: `Provider returned ${res.status}` }
  } catch (err) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Provider did not respond within 10s' : (err?.message || 'Request failed') }
  }
}

// IPTV (Xtream) login: the server's own player_api answers with the account,
// its status and when it runs out - the same sign-in AIOStreams' IPTV
// option makes. The address is one the account chose, so it is fetched
// through the safe-address rule like any other check address.
function xtreamBase(server) {
  const trimmed = String(server || '').trim()
  if (!trimmed) return null
  let url
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/\/(player_api|get|xmltv)\.php$/i, '').replace(/\/+$/, '')
  return `${url.origin}${path}`
}

async function checkXtreamAuth(secret, config = {}) {
  const base = xtreamBase(config.url)
  if (!base) return { ok: false, message: 'No IPTV server address on file for this entry' }
  const username = config.identifier
  if (!username) return { ok: false, message: 'No IPTV username on file for this entry' }
  if (!secret) return { ok: false, message: 'No IPTV password on file for this entry' }
  try {
    const url = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(secret)}`
    const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } }, { checked: true })
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The IPTV server turned the login down' }
    if (!res.ok) return { ok: false, message: `The IPTV server returned ${res.status}` }
    let data
    try { data = JSON.parse(await readText(res)) } catch { return { ok: false, message: 'That address did not answer like an IPTV server' } }
    const info = data && typeof data === 'object' ? data.user_info : null
    if (!info || typeof info !== 'object') return { ok: false, message: 'That address did not answer like an IPTV server' }
    if (Number(info.auth) !== 1) return { ok: false, message: 'The IPTV server turned the login down' }
    const expiresAt = unixDate(info.exp_date)
    const status = String(info.status || '').trim()
    if (status && status.toLowerCase() !== 'active') {
      return { ok: false, message: `Login works, but the account is ${status.toLowerCase()}`, expiresAt }
    }
    return { ok: true, message: `Login works${expiresText(expiresAt)}`, expiresAt }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

// Live TV playlist (M3U), the kind AIOStreams' M3U option takes. The address
// is the secret: it usually carries the login. A playlist can be many
// megabytes, so only its start is read - enough to see that it is a playlist
// and that it lists channels - and the rest is dropped. An address in the
// Xtream shape (get.php with a username and password) also says when the
// login runs out, through the same server's player_api.
const M3U_PEEK_BYTES = 256 * 1024
async function readStart(res, maxBytes) {
  const reader = res?.body?.getReader?.()
  if (!reader) return ''
  const chunks = []
  let total = 0
  let timer
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ done: true, late: true }), 15000) })
  try {
    while (total < maxBytes) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      total += value.byteLength
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch { /* what arrived is what is judged */ }
  clearTimeout(timer)
  reader.cancel().catch(() => {})
  return Buffer.concat(chunks).toString('utf8')
}

function m3uXtreamLogin(address) {
  let url
  try { url = new URL(address) } catch { return null }
  const username = url.searchParams.get('username')
  const password = url.searchParams.get('password')
  if (!/\/get\.php$/i.test(url.pathname) || !username || !password) return null
  return { server: `${url.origin}${url.pathname.replace(/\/get\.php$/i, '')}`, username, password }
}

async function checkM3uPlaylist(secret, config = {}) {
  const address = String(secret || config.url || '').trim()
  if (!address) return { ok: false, message: 'No playlist address on file for this entry' }
  let parsed
  try { parsed = new URL(address) } catch { return { ok: false, message: 'That is not a web address' } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: 'That is not a web address' }
  try {
    const res = await fetchWithRetry(address, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } }, { checked: true, timeoutMs: 15000 })
    if (res.status === 401 || res.status === 403) { try { res.body?.cancel?.() } catch {} return { ok: false, message: 'The server turned the playlist address down' } }
    if (!res.ok) { try { res.body?.cancel?.() } catch {} return { ok: false, message: `The playlist server returned ${res.status}` } }
    const start = (await readStart(res, M3U_PEEK_BYTES)).replace(/^\uFEFF/, '')
    if (!/^\s*#EXTM3U/i.test(start)) return { ok: false, message: 'That address did not answer with a playlist' }
    const channels = (start.match(/^#EXTINF/gim) || []).length
    if (!channels) return { ok: false, message: 'The playlist loads, but lists no channels' }
    // Its end date, when the address is an Xtream one. Not knowing it is no failure.
    let expiresAt
    const login = m3uXtreamLogin(address)
    if (login) {
      try {
        const r = await checkXtreamAuth(login.password, { url: login.server, identifier: login.username })
        expiresAt = r.expiresAt
        if (!r.ok && /account is/.test(r.message)) return { ok: false, message: r.message.replace('Login works', 'The playlist loads'), expiresAt }
      } catch { /* the playlist itself loaded */ }
    }
    return { ok: true, message: `Playlist loads${expiresText(expiresAt)}`, ...(expiresAt ? { expiresAt } : {}) }
  } catch (err) {
    return { ok: false, message: describeRequestError(err) }
  }
}

const CHECKERS = {
  xtream_auth: checkXtreamAuth,
  m3u_playlist: checkM3uPlaylist,
  openai_compatible: checkOpenAiCompatible,
  generic_http: checkGenericHttp,
  real_debrid: checkRealDebrid,
  torbox: checkTorBox,
  alldebrid: checkAllDebrid,
  premiumize: checkPremiumize,
  debrid_link: checkDebridLink,
  newznab_caps: checkNewznabCaps,
  tcp_reachability: checkTcpReachability,
  nntp_auth: checkNntpAuth,
  jellyfin_auth: checkJellyfinAuth,
  aiostreams_config: checkAiostreamsConfig,
  tmdb_key: metadataKeyChecker('checkTmdb'),
  omdb_key: metadataKeyChecker('checkOmdb'),
  mdblist_key: metadataKeyChecker('checkMdblist'),
  rpdb_key: metadataKeyChecker('checkRpdb'),
  stremio_auth: checkStremioAuth,
  nuvio_auth: checkNuvioAuth
}

// Checks that read the end date from the service itself: what the service says
// is the truth, so a hand-moved date is overwritten by the next check, and
// "I renewed it" has nothing to move.
const END_DATE_FROM_SERVICE = new Set(['real_debrid', 'torbox', 'alldebrid', 'premiumize', 'debrid_link', 'xtream_auth', 'm3u_playlist'])

// The check an entry is really run with - one rule for the Test button and the
// scheduled monitor. Entries made before a check existed carry 'manual' (AI
// Services) or the connectivity-only 'tcp_reachability' (Usenet providers); both
// now get the real check without anyone re-saving the key.
function effectiveTestType(entry) {
  const { category, testType } = entry || {}
  if (category === 'note') return 'manual'
  if (category === 'ai' && testType === 'manual') return 'openai_compatible'
  if (category === 'usenet_provider' && testType === 'tcp_reachability') return 'nntp_auth'
  return testType
}

// The end date a check found, if it may be stored: an entry paid once or free
// has no end date, whatever a service says.
function storableExpiry(entry, result) {
  if (entry?.costCycle === 'once' || entry?.costCycle === 'free') return undefined
  return result?.expiresAt instanceof Date && !isNaN(result.expiresAt) ? result.expiresAt : undefined
}

async function runCheck(testType, secret, config) {
  if (!testType || testType === 'manual') {
    return { ok: null, message: 'Manual entry — no automated check configured' }
  }
  // Own keys only: CHECKERS['constructor'] is Object itself.
  const checker = Object.prototype.hasOwnProperty.call(CHECKERS, testType) ? CHECKERS[testType] : null
  if (!checker) return { ok: false, message: `Unknown test type: ${testType}` }
  try {
    return await checker(secret, config || {})
  } catch (err) {
    return { ok: false, message: err?.message || 'Check failed unexpectedly' }
  }
}

module.exports = { runCheck, CHECKERS, effectiveTestType, storableExpiry, END_DATE_FROM_SERVICE, nntpConversation, nntpLogin, fetchAiModels, xtreamBase, m3uXtreamLogin, TORBOX_PLANS }
