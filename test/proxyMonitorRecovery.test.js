const test = require('node:test')
const assert = require('node:assert/strict')
const monitor = require('../server/utils/proxyStreamMonitor')
const { isProxyMonitorConfirming, getProxyMonitorStatus, CHECK_INTERVAL_MS } = monitor
const { fetchLiveStreams, pollOnce, attemptPosterLookup, retryMissingPosters, reset, setMonitored, setLastOk, setRateLimitedUntil } = monitor._test

const BASE = 'http://aiostreams.example'
const CONFIG = { baseUrl: BASE, username: 'admin', password: 'pw' }

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const page = (status = 200) =>
  new Response('<!doctype html><title>Sign in</title>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const loginOk = () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc; Path=/; HttpOnly' } })
const STREAMS = { data: { streams: [{ transport: 'proxy', username: 'alice', clientIp: '203.0.113.9', targetKey: 'k1', filename: 'Film.2020.mkv', requests: 5 }] } }

const realFetch = global.fetch

// Answers each request from a script, in order, and remembers what was asked.
function scriptFetch(t, answers) {
  const calls = []
  const queue = [...answers]
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' })
    if (queue.length === 0) throw new Error(`unexpected request to ${url}`)
    const next = queue.shift()
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(url, init) : next
  }
  t.after(() => { global.fetch = realFetch })
  const logins = () => calls.filter((c) => c.url.endsWith('/api/v1/auth/login')).length
  return { calls, logins }
}

// Stands in for the database: every read finds nothing, every write is kept.
function fakePrisma({ activeRows = 0 } = {}) {
  const writes = []
  const model = (name) => new Proxy({}, {
    get: (_t, method) => async (args) => {
      if (method === 'findMany') return []
      if (method === 'updateMany') {
        writes.push({ model: name, method, args })
        return { count: args?.where?.isActive === true ? activeRows : 0 }
      }
      if (String(method).startsWith('find')) return null
      writes.push({ model: name, method, args })
      return {}
    },
  })
  const prisma = new Proxy({}, { get: (_t, name) => model(name) })
  return { prisma, writes }
}

test('fetchLiveStreams: an expired sign-in answered with the login page signs in again and carries on', async (t) => {
  reset()
  const net = scriptFetch(t, [
    loginOk(), json(STREAMS), // first poll: sign in, data
    page(), // second poll: the session has expired - a web page, status 200
    loginOk(), json(STREAMS), // signed in again, same poll gets its data
  ])
  assert.equal((await fetchLiveStreams(BASE, 'admin', 'pw')).length, 1)
  const again = await fetchLiveStreams(BASE, 'admin', 'pw')
  assert.equal(again.length, 1)
  assert.equal(again[0].username, 'alice')
  assert.equal(net.logins(), 2)
})

test('fetchLiveStreams: a 401 and an unfollowed redirect are both treated as an expired sign-in', async (t) => {
  for (const expired of [() => json({ error: 'unauthorized' }, 401), () => new Response(null, { status: 302, headers: { location: '/login' } })]) {
    reset()
    const net = scriptFetch(t, [loginOk(), expired(), loginOk(), json(STREAMS)])
    assert.equal((await fetchLiveStreams(BASE, 'admin', 'pw')).length, 1)
    assert.equal(net.logins(), 2)
  }
})

test('fetchLiveStreams: a refused sign-in is not repeated on the next poll', async (t) => {
  reset()
  const net = scriptFetch(t, [json({ error: 'bad credentials' }, 401)])
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'wrong'), (e) => e.authFailed === true)
  // Thirty seconds later: nothing is sent at all.
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'wrong'), (e) => e.authFailed === true)
  assert.equal(net.calls.length, 1)
})

test('fetchLiveStreams: a server that is not up yet is tried again on the next poll, with no back-off', async (t) => {
  reset()
  // Starting together after an update: refused connection, then a 503, then up.
  const net = scriptFetch(t, [new Error('connect ECONNREFUSED'), new Response('starting', { status: 503 }), loginOk(), json(STREAMS)])
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
  assert.equal((await fetchLiveStreams(BASE, 'admin', 'pw')).length, 1)
  assert.equal(net.calls.length, 4, 'each poll reached the network')
})

test('fetchLiveStreams: still a web page after signing in gives up and waits, rather than signing in on every poll', async (t) => {
  reset()
  const net = scriptFetch(t, [loginOk(), page(), loginOk(), page()])
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
  assert.equal(net.calls.length, 4, 'the second poll must not reach the network')
})

test('fetchLiveStreams: a 404 web page means an older AIOStreams, not an expired sign-in', async (t) => {
  reset()
  const legacy = { users: [{ username: 'alice', active: [{ ip: '203.0.113.9', url: 'https://cdn.example/f.mkv', filename: 'Film.2020.mkv', count: 3, timestamp: 1, lastSeen: 2 }] }] }
  const net = scriptFetch(t, [loginOk(), page(404), json(legacy)])
  const rows = await fetchLiveStreams(BASE, 'admin', 'pw')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].targetKey, 'https://cdn.example/f.mkv')
  assert.equal(net.logins(), 1)
})

test('fetchLiveStreams: a rate limit is reported as one, not as an expired sign-in', async (t) => {
  reset()
  const net = scriptFetch(t, [loginOk(), new Response('slow down', { status: 429, headers: { 'retry-after': '120', 'content-type': 'text/html' } })])
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.rateLimited === true && e.retryAfterSeconds === 120)
  assert.equal(net.logins(), 1)
})

test('pollOnce: live rows are closed once after six failed polls in a row, and a working poll clears the count', async (t) => {
  reset()
  const { prisma, writes } = fakePrisma({ activeRows: 1 })
  const down = new Error('connect ECONNREFUSED')
  // AIOStreams cannot be reached for eight polls running, then it is back.
  const net = scriptFetch(t, [...Array(8).fill(down), loginOk(), json({ data: { streams: [] } })])
  const closes = () => writes.filter((w) => w.model === 'proxyStreamSession' && w.method === 'updateMany' && w.args.where.isActive === true)

  for (let i = 0; i < 5; i++) await pollOnce(prisma, 'acct-1', CONFIG)
  assert.equal(closes().length, 0, 'five failures (two and a half minutes) is still within tolerance')

  await pollOnce(prisma, 'acct-1', CONFIG)
  assert.equal(closes().length, 1)
  assert.deepEqual(closes()[0].args.where, { accountId: 'acct-1', isActive: true })
  assert.equal(closes()[0].args.data.isActive, false)
  // Nothing was seen to end, so no end time: a row with one would make Now
  // Playing drop the native entry for the same title as a stale echo.
  assert.equal(closes()[0].args.data.endTime, null)
  assert.equal(getProxyMonitorStatus().consecutiveFailures, 6)
  assert.ok(getProxyMonitorStatus().failingSince instanceof Date)

  // Still failing: nothing is closed a second time.
  await pollOnce(prisma, 'acct-1', CONFIG)
  await pollOnce(prisma, 'acct-1', CONFIG)
  assert.equal(closes().length, 1)

  // Back up: the very next poll works - no waiting out a back-off first.
  await pollOnce(prisma, 'acct-1', CONFIG)
  const status = getProxyMonitorStatus()
  assert.equal(status.ok, true)
  assert.equal(status.consecutiveFailures, 0)
  assert.equal(status.failingSince, null)
  assert.ok(status.lastOkAt instanceof Date)
  assert.equal(net.calls.length, 10)
})

test('pollOnce: being told to slow down is passed up and does not close live rows', async (t) => {
  reset()
  const { prisma, writes } = fakePrisma({ activeRows: 1 })
  const limited = () => new Response('', { status: 429, headers: { 'retry-after': '60' } })
  scriptFetch(t, [loginOk(), ...Array.from({ length: 7 }, limited)])
  for (let i = 0; i < 7; i++) {
    await assert.rejects(pollOnce(prisma, 'acct-1', CONFIG), (e) => e.rateLimited === true)
  }
  assert.equal(writes.filter((w) => w.method === 'updateMany').length, 0)
})

test('fetchLiveStreams: a sign-in that is always answered with unusable data backs off after a few rounds', async (t) => {
  const text = () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } })
  const legacyExpired = () => json({ error: 'unauthorized' }, 401)
  const rounds = [
    ['live route not JSON', () => [loginOk(), text()]],
    ['legacy route expired', () => [loginOk(), page(404), legacyExpired()]],
    ['legacy route not JSON', () => [loginOk(), page(404), text()]],
  ]
  for (const [name, script] of rounds) {
    reset()
    const net = scriptFetch(t, Array.from({ length: 6 }, script).flat())
    for (let i = 0; i < 6; i++) await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
    assert.equal(net.logins(), 3, `${name}: three sign-ins, then it waits`)
  }
})

test('fetchLiveStreams: an expired legacy session signs in again on the next poll with no back-off', async (t) => {
  reset()
  const legacy = { users: [] }
  const net = scriptFetch(t, [loginOk(), page(404), json(legacy), page(404), json({ error: 'unauthorized' }, 401), loginOk(), page(404), json(legacy)])
  await fetchLiveStreams(BASE, 'admin', 'pw')
  // The cookie was not issued this poll, so its expiry is not counted.
  await assert.rejects(fetchLiveStreams(BASE, 'admin', 'pw'), (e) => e.authFailed === true)
  await fetchLiveStreams(BASE, 'admin', 'pw')
  assert.equal(net.logins(), 2)
})

test('pollOnce: a rate-limited sign-in is passed up as one, closes no rows and sends no outage push', async (t) => {
  reset()
  const { prisma, writes } = fakePrisma({ activeRows: 1 })
  const limited = () => new Response('', { status: 429, headers: { 'retry-after': '600' } })
  scriptFetch(t, [limited()])
  await assert.rejects(pollOnce(prisma, 'acct-1', CONFIG), (e) => e.rateLimited === true && e.retryAfterSeconds === 600)
  assert.equal(writes.filter((w) => w.method === 'updateMany').length, 0)
})

test('isProxyMonitorConfirming: live rows are believed only while polls keep succeeding', () => {
  const now = Date.now()
  reset()
  assert.equal(isProxyMonitorConfirming('acct-1', now), true, 'no poller in this process: rows are taken as they are')

  setMonitored('acct-1')
  assert.equal(isProxyMonitorConfirming('acct-1', now), false, 'a poller that has never succeeded confirms nothing')

  setLastOk(now - CHECK_INTERVAL_MS)
  assert.equal(isProxyMonitorConfirming('acct-1', now), true)
  assert.equal(isProxyMonitorConfirming('acct-2', now), false, 'another household is not what this poller watches')

  setLastOk(now - CHECK_INTERVAL_MS * 4 - 1000)
  assert.equal(isProxyMonitorConfirming('acct-1', now), false, 'the stuck-card case: nothing has confirmed the row for minutes')

  // Deliberately not polling because AIOStreams asked: believed a while longer...
  setRateLimitedUntil(now + 60 * 1000)
  assert.equal(isProxyMonitorConfirming('acct-1', now), true)
  // ...but not for ever.
  setLastOk(now - 21 * 60 * 1000)
  assert.equal(isProxyMonitorConfirming('acct-1', now), false)
  reset()
})

// --- poster lookup: the shortened title is only tried alongside a year -----

function posterRun(t, displayName) {
  const searched = []
  global.fetch = async (url) => {
    searched.push(decodeURIComponent(String(url).split('search=')[1].replace(/\.json$/, '')))
    return json({ metas: [] })
  }
  t.after(() => { global.fetch = realFetch })
  const prisma = { proxyStreamSession: { update: async () => ({}) }, watchSession: { updateMany: async () => ({}) } }
  return attemptPosterLookup(prisma, 'row-1', displayName).then(() => [...new Set(searched)])
}

test('attemptPosterLookup: with a year, the part before the dash is tried as well', async (t) => {
  assert.deepEqual(await posterRun(t, 'Toy Story - Il mondo dei giocattoli (1995)'), ['Toy Story - Il mondo dei giocattoli', 'Toy Story'])
})

test('attemptPosterLookup: without a year, a spin-off is never looked up under the original show', async (t) => {
  assert.deepEqual(await posterRun(t, 'Dexter - New Blood S01E03'), ['Dexter - New Blood'])
})

// --- the retry pass reads an unmatched row's file name again ----------------

test('retryMissingPosters: an unmatched row is looked up under its re-read name', async (t) => {
  const searched = []
  global.fetch = async (url) => {
    searched.push(decodeURIComponent(String(url).split('search=')[1].replace(/\.json$/, '')))
    return json({ metas: [] })
  }
  t.after(() => { global.fetch = realFetch })
  const updates = []
  const rows = [
    { id: 'old', displayName: 'Resident Evil 2026', filename: 'Resident_Evil_2026_2160p_MA_WEB-DL_H265.mkv', metadataItemId: null },
    { id: 'kept', displayName: 'Some Film (2020)', filename: 'Some.Film.2020.1080p.mkv', metadataItemId: null },
  ]
  const prisma = {
    proxyStreamSession: { findMany: async () => rows, update: async (a) => { updates.push(a); return {} } },
    watchSession: { updateMany: async () => ({}) },
  }
  await retryMissingPosters(prisma, 'acct-1')
  assert.deepEqual(updates.filter((u) => u.data.displayName).map((u) => [u.where.id, u.data.displayName]), [['old', 'Resident Evil (2026)']])
  assert.ok(searched.includes('Resident Evil'), `searched ${searched.join(' | ')}`)
  assert.ok(!searched.includes('Resident Evil 2026'))
})
