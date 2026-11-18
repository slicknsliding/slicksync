// "Resume in your app" on a member's Continue Watching card: the app picker's
// lookup (GET /open-targets) and Play on a device (POST /open-targets/play-on)
// on the member portal. Each has to be asked by that exact person, and only
// ever shows or acts on their own server, their own server user and their own
// devices - never another member's, another household's, or a token.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jwt = require('jsonwebtoken')

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-opentargets-'))
process.chdir(WORK_DIR)

// The servers are not reached: each person's provider is a recorder that
// answers for that person only.
const providers = require('../server/providers')
const played = []
providers.makeCreateProvider = () => (row) => ({
  findItem: async (id) => `item-${row.id}-${id}`.replace(/[^A-Za-z0-9-]/g, ''),
  controllableSessions: async () => [{ id: `session-of-${row.id}`, device: `${row.username} TV`, client: 'Swiftfin' }],
  playOn: async (sessionId, itemId) => { played.push({ by: row.id, sessionId, itemId }) },
})

const realFetch = global.fetch
global.fetch = (url, init) => (String(url).startsWith('https://v3-cinemeta.strem.io/')
  ? Promise.resolve(new Response(JSON.stringify({ meta: { moviedb_id: 603 } }), { status: 200 }))
  : realFetch(url, init))

const express = require('express')
const makePublicLibraryRouter = require('../server/routes/publicLibrary')

const SECRET = 'portal-open-targets-secret'

function match(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => match(row, w))
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return want.in.includes(row[key])
      if ('not' in want) return row[key] !== want.not
    }
    return row[key] === want
  })
}
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })
function table(rows) {
  return {
    rows,
    findFirst: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findUnique: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findMany: async ({ where, select } = {}) => rows.filter((x) => match(x, where)).map((r) => pick(r, select)),
  }
}

const member = (id, accountId, extra) => ({
  id, accountId, username: id, email: `${id}@example.com`, isActive: true, providerType: 'jellyfin', stremioAuthKey: null,
  nuvioRefreshToken: null, nuvioUserId: null, jellyfinServerUrl: null, jellyfinServerId: null, jellyfinServerKind: null,
  jellyfinUserId: null, jellyfinToken: null, ...extra,
})
const JF = { jellyfinServerUrl: 'https://jf.example.com', jellyfinServerId: 'aaaabbbbccccddddeeeeffff00001111', jellyfinServerKind: 'jellyfin', jellyfinToken: 'SECRET-TOKEN-JF' }
const AIO = { jellyfinServerUrl: 'https://aio.example.com', jellyfinServerId: '11112222333344445555666677778888', jellyfinServerKind: 'aiostreams', jellyfinToken: 'SECRET-TOKEN-AIO' }
const AIOM = { jellyfinServerUrl: 'https://meta.example.com/jellyfin/abc', jellyfinServerId: '99998888777766665555444433332222', jellyfinServerKind: 'aiometadata', jellyfinToken: 'SECRET-TOKEN-AIOM' }

let server
let base
test.before(async () => {
  const data = {
    user: table([
      member('jSarah', 'acc1', { ...JF, jellyfinUserId: 'u-sarah' }),
      member('jLiv', 'acc1', { ...JF, jellyfinUserId: 'u-liv' }),
      member('aSam', 'acc1', { ...AIO, jellyfinUserId: 'u-sam' }),
      member('mSue', 'acc1', { ...AIOM, jellyfinUserId: 'u-sue' }),
      member('mTom', 'acc1', { ...AIOM, jellyfinUserId: 'u-tom' }),
      member('jOther', 'acc2', { ...JF, jellyfinUserId: 'u-other', jellyfinServerUrl: 'https://other.example.com' }),
      member('jNone', 'acc1', {}),
      member('sStremio', 'acc1', { providerType: 'stremio', stremioAuthKey: 'key-for-s@example.com' }),
    ]),
    userProviderCredential: table([]),
  }
  const app = express()
  app.use(express.json())
  app.use('/api/public-library', makePublicLibraryRouter({
    prisma: data, DEFAULT_ACCOUNT_ID: 'default', encrypt: (v) => v, decrypt: (v) => v,
    getCachedLibrary: () => [], setCachedLibrary: () => {}, JWT_SECRET: SECRET,
  }))
  // The admin's lookup, signed in to household acc1.
  app.use('/api/jellyfin', require('../server/routes/jellyfin')({
    prisma: data, getAccountId: () => 'acc1', encrypt: (v) => v, decrypt: (v) => v, assignUserToGroup: async () => {},
  }))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}/api/public-library`
})
test.after(() => {
  server.close()
  global.fetch = realFetch
  process.chdir(os.tmpdir())
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
})

const session = (id) => jwt.sign({ sub: id, provider: 'jellyfin' }, SECRET, { expiresIn: '1h' })
async function call(method, route, { key, body, query } = {}) {
  const res = await realFetch(`${base}${route}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-stremio-auth': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}
const lookup = (key, userId, id = 'tt0133093', type = 'movie') => call('GET', '/open-targets', { key, query: { userId, id, type } })

test('both routes need the person asking: no credential, a housemate, another household, another provider', async () => {
  const play = { sessionId: 'session-of-jSarah', itemId: 'item-1234567890' }
  for (const key of [undefined, session('jLiv'), session('jOther'), session('aSam'), 'key-for-s@example.com', 'garbage']) {
    assert.equal((await lookup(key, 'jSarah')).status, 401, `lookup with ${String(key).slice(0, 12)}`)
    assert.equal((await call('POST', '/open-targets/play-on', { key, body: { userId: 'jSarah', ...play } })).status, 401, 'play-on')
  }
  assert.equal((await lookup(session('jSarah'), 'nobody')).status, 404)
  assert.deepEqual(played, [], 'nothing was started')
})

test('a Jellyfin member gets only their own server, user id, item and devices', async () => {
  const res = await lookup(session('jSarah'), 'jSarah')
  assert.equal(res.status, 200)
  assert.equal(res.body.servers.length, 1)
  const [s] = res.body.servers
  assert.equal(s.address, 'https://jf.example.com')
  assert.equal(s.kind, 'jellyfin')
  assert.equal(s.serverId, JF.jellyfinServerId)
  assert.deepEqual(s.people, [{ name: 'jSarah', userId: 'u-sarah' }], 'only the caller, not jLiv who shares the server')
  assert.equal(s.itemId, 'item-jSarah-tt0133093')
  assert.equal(res.body.tmdbId, '603')
  assert.deepEqual(res.body.devices.map((d) => [d.person, d.sessionId, d.itemId, d.kind]), [['jSarah', 'session-of-jSarah', 'item-jSarah-tt0133093', 'jellyfin']])
  const text = JSON.stringify(res.body)
  assert.ok(!/SECRET-TOKEN|jLiv|u-liv|Token/i.test(text), 'no token and nothing of the housemate')
  const liv = await lookup(session('jLiv'), 'jLiv')
  assert.deepEqual(liv.body.servers[0].people, [{ name: 'jLiv', userId: 'u-liv' }])
  assert.equal(liv.body.devices[0].sessionId, 'session-of-jLiv')
})

test('an AIOStreams member gets their own server and the packed item, and no devices', async () => {
  const res = await lookup(session('aSam'), 'aSam', 'tt0133093', 'series')
  assert.equal(res.status, 200)
  const [s] = res.body.servers
  assert.equal(s.kind, 'aiostreams')
  assert.equal(s.address, 'https://aio.example.com')
  assert.equal(s.serverId, AIO.jellyfinServerId)
  assert.deepEqual(s.people, [{ name: 'aSam', userId: 'u-sam' }])
  assert.ok(s.itemId && !s.itemId.startsWith('item-'), 'built from the title id, not looked up')
  assert.deepEqual(res.body.devices, [])
  assert.ok(!/SECRET-TOKEN/.test(JSON.stringify(res.body)))
})

test('no sign-in, or a bad title id: an empty answer', async () => {
  const empty = { servers: [], devices: [], tmdbId: null }
  assert.deepEqual((await lookup(session('jNone'), 'jNone')).body, empty)
  assert.deepEqual((await lookup(session('jSarah'), 'jSarah', '../../etc')).body, empty)
  assert.deepEqual((await lookup(session('jSarah'), 'jSarah', 'tt1; drop')).body, empty)
})

test('Play on a device: only their own device, on their own Jellyfin', async () => {
  const key = session('jSarah')
  const ok = await call('POST', '/open-targets/play-on', { key, body: { userId: 'jSarah', sessionId: 'session-of-jSarah', itemId: 'item-jSarah-tt0133093' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(played, [{ by: 'jSarah', sessionId: 'session-of-jSarah', itemId: 'item-jSarah-tt0133093' }])
  // A housemate's device and a made-up one.
  for (const sessionId of ['session-of-jLiv', 'whatever']) {
    assert.equal((await call('POST', '/open-targets/play-on', { key, body: { userId: 'jSarah', sessionId, itemId: 'item-jSarah-tt0133093' } })).status, 404)
  }
  for (const body of [{ sessionId: 'session-of-jSarah', itemId: '../x' }, { sessionId: 'session-of-jSarah' }, { itemId: 'item-1234567890' }]) {
    assert.equal((await call('POST', '/open-targets/play-on', { key, body: { userId: 'jSarah', ...body } })).status, 400)
  }
  // AIOStreams has no devices to play on; a member with no sign-in neither.
  assert.equal((await call('POST', '/open-targets/play-on', { key: session('aSam'), body: { userId: 'aSam', sessionId: 'session-of-aSam', itemId: 'item-1234567890' } })).status, 400)
  assert.equal((await call('POST', '/open-targets/play-on', { key: session('jNone'), body: { userId: 'jNone', sessionId: 'x', itemId: 'item-1234567890' } })).status, 400)
  assert.equal(played.length, 1, 'only the one valid start')
})

// The admin's Continue Watching card resumes as that card's person: with
// personId, only their own sign-ins - never a housemate's or another household's.
test('admin lookup with personId: only that person’s own server and devices', async () => {
  const admin = (query) => realFetch(`${base.replace('/public-library', '/jellyfin')}/open-targets?${new URLSearchParams({ id: 'tt0133093', type: 'movie', ...query })}`).then((r) => r.json())
  const everyone = await admin({})
  assert.deepEqual(everyone.servers.map((s) => s.address).sort(), ['https://aio.example.com', 'https://jf.example.com', 'https://meta.example.com/jellyfin/abc'])
  // Devices come from Jellyfin and AIOMetadata people, each marked with its server; none from AIOStreams.
  assert.deepEqual(everyone.devices.map((d) => [d.personId, d.kind]).sort(), [['jLiv', 'jellyfin'], ['jSarah', 'jellyfin'], ['mSue', 'aiometadata'], ['mTom', 'aiometadata']])

  const sam = await admin({ personId: 'aSam' })
  assert.deepEqual(sam.servers.map((s) => s.address), ['https://aio.example.com'])
  assert.deepEqual(sam.servers[0].people.map((p) => p.name), ['aSam'])
  assert.deepEqual(sam.devices, [])

  const liv = await admin({ personId: 'jLiv' })
  assert.deepEqual(liv.servers.map((s) => s.address), ['https://jf.example.com'])
  assert.deepEqual(liv.servers[0].people, [{ name: 'jLiv', userId: 'u-liv' }])
  assert.deepEqual(liv.devices.map((d) => d.personId), ['jLiv'])

  assert.deepEqual((await admin({ personId: 'jOther' })).servers, [], 'another household')
  assert.ok(!JSON.stringify(everyone).includes('SECRET-TOKEN'), 'no token leaves')
})

test('an AIOMetadata member gets their own devices, marked AIOMetadata, and can start a title on one', async () => {
  const before = played.length
  const res = await lookup(session('mSue'), 'mSue')
  assert.equal(res.status, 200)
  const [s] = res.body.servers
  assert.equal(s.kind, 'aiometadata')
  assert.deepEqual(s.people, [{ name: 'mSue', userId: 'u-sue' }], 'not mTom on the same server')
  assert.ok(s.itemId && !s.itemId.startsWith('item-'), 'built from the title id, not looked up')
  assert.deepEqual(res.body.devices.map((d) => [d.person, d.sessionId, d.kind, d.itemId]), [['mSue', 'session-of-mSue', 'aiometadata', s.itemId]])
  assert.ok(!/SECRET-TOKEN|mTom|u-tom/.test(JSON.stringify(res.body)), 'no token and nothing of the housemate')

  const key = session('mSue')
  const ok = await call('POST', '/open-targets/play-on', { key, body: { userId: 'mSue', sessionId: 'session-of-mSue', itemId: s.itemId } })
  assert.equal(ok.status, 200)
  assert.deepEqual(played.slice(before), [{ by: 'mSue', sessionId: 'session-of-mSue', itemId: s.itemId }])
  // A housemate's device on the same server is not hers.
  assert.equal((await call('POST', '/open-targets/play-on', { key, body: { userId: 'mSue', sessionId: 'session-of-mTom', itemId: s.itemId } })).status, 404)
  assert.equal(played.length, before + 1)
})
