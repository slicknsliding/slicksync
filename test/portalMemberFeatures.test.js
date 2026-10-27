// What a member can do for themselves on their own portal: change their
// picture, switch between their own Nuvio profiles, see and clear their own
// Continue Watching, and name or remove their own notification devices. Each
// route has to be asked by that exact person (the same rule as
// portalIdentity.test.js), and may only ever touch their own row, their own
// household and their own history.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jwt = require('jsonwebtoken')

process.env.SHARES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-shares-'))
// Uploaded pictures go to <cwd>/data/avatars: keep them out of the real one.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-portal-'))
process.chdir(WORK_DIR)
const AVATAR_DIR = path.join(WORK_DIR, 'data', 'avatars')

// A Stremio key is "key-for-<email>" here; the real call goes to Stremio.
const stremio = require('../server/utils/stremio')
stremio.validateStremioAuthKey = async (key) => {
  const m = /^key-for-(.+)$/.exec(String(key))
  if (!m) { const e = new Error('Invalid or expired Stremio auth key'); e.code = 1; throw e }
  return { user: { email: m[1] }, addons: [] }
}

// Cinemeta is not asked: every show has three episodes.
const notify = require('../server/utils/notify')
notify.fetchMetadata = async (itemId, itemType) => ({
  title: `Title ${itemId}`,
  poster: null,
  background: null,
  imdb_id: itemId,
  allEpisodes: itemType === 'series' ? [1, 2, 3].map((episode) => ({ season: 1, episode, title: `Ep ${episode}`, thumbnail: null })) : [],
})

const express = require('express')
const makePublicLibraryRouter = require('../server/routes/publicLibrary')

const SECRET = 'portal-member-features-secret'
const realFetch = global.fetch

function match(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => match(row, w))
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return want.in.includes(row[key])
      if ('not' in want) return row[key] !== want.not
      if ('gte' in want) return row[key] >= want.gte
      if ('contains' in want) return String(row[key] ?? '').includes(want.contains)
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
    update: async ({ where, data, select }) => { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return pick(r, select) },
    updateMany: async ({ where, data }) => { const hit = rows.filter((x) => match(x, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length } },
    deleteMany: async ({ where }) => { const hit = rows.filter((x) => match(x, where)); hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { count: hit.length } },
  }
}

const person = (id, accountId, extra) => ({
  id, accountId, username: id, email: `${id}@example.com`, isActive: true, providerType: 'stremio', colorIndex: 0, avatarUrl: null,
  activityVisibility: 'private', createdAt: new Date('2026-01-01'), expiresAt: null, apiKey: null, stremioAuthKey: null,
  nuvioRefreshToken: null, nuvioUserId: null, nuvioProfileId: 1, protectedAddons: null, discordWebhookUrl: null, notifyOnWatch: true,
  publicStatsEnabled: false, publicStatsSlug: null, providerConnectionErrorAt: null, ...extra,
})

const NOW = Date.now()
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000)

function makeData() {
  const dismissals = []
  return {
    user: table([
      person('sA', 'acc1', { email: 'a@example.com', stremioAuthKey: 'key-for-a@example.com' }),
      person('sB', 'acc1', { email: 'b@example.com', stremioAuthKey: 'key-for-b@example.com' }),
      // A Nuvio login with three profiles, one more in an inactive group, one
      // with no kept login, and another household holding the same login.
      person('nA', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1', nuvioProfileId: 1 }),
      person('nP2', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1', nuvioProfileId: 2 }),
      person('nP3', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: null, nuvioProfileId: 3 }),
      person('nP4', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1', nuvioProfileId: 4 }),
      person('nP5', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1', nuvioProfileId: 5, isActive: false }),
      person('nOther', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-other', nuvioRefreshToken: 'refresh-other' }),
      person('nNull', 'acc1', { providerType: 'nuvio', nuvioUserId: null, nuvioRefreshToken: 'refresh-null' }),
      person('nNull2', 'acc1', { providerType: 'nuvio', nuvioUserId: null, nuvioRefreshToken: 'refresh-null-2' }),
      person('jA', 'acc1', { providerType: 'jellyfin' }),
      person('jB', 'acc1', { providerType: 'jellyfin' }),
      person('sA2', 'acc2', { email: 'a@example.com', stremioAuthKey: 'key-for-a@example.com' }),
      person('nA2', 'acc2', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1' }),
    ]),
    group: table([
      { id: 'g1', accountId: 'acc1', isActive: true, userIds: JSON.stringify(['sA', 'sB', 'nA', 'nP2', 'nP3', 'nP5', 'nOther', 'nNull', 'nNull2', 'jA', 'jB']) },
      { id: 'g3', accountId: 'acc1', isActive: false, userIds: JSON.stringify(['nP4']) },
      { id: 'g2', accountId: 'acc2', isActive: true, userIds: JSON.stringify(['sA2', 'nA2']) },
    ]),
    episodeWatchHistory: table([
      // sB watched the newest thing; sA's shows are older.
      { id: 'e1', accountId: 'acc1', userId: 'sB', showId: 'tt0000003', season: 1, episode: 1, videoId: 'tt0000003:1:1', showName: 'Three', poster: null, watchedAt: hoursAgo(1) },
      { id: 'e2', accountId: 'acc1', userId: 'sA', showId: 'tt0000001', season: 1, episode: 1, videoId: 'tt0000001:1:1', showName: 'One', poster: null, watchedAt: hoursAgo(5) },
      { id: 'e3', accountId: 'acc1', userId: 'sA', showId: 'tt0000002', season: 1, episode: 2, videoId: 'tt0000002:1:2', showName: 'Two', poster: null, watchedAt: hoursAgo(9) },
    ]),
    movieWatchHistory: table([]),
    watchSession: { findUnique: async () => null },
    appAccount: { findUnique: async () => null },
    dismissedContinueWatching: {
      rows: dismissals,
      findMany: async ({ where }) => dismissals.filter((d) => match(d, where)),
      upsert: async ({ where, create }) => {
        const k = where.accountId_userId_showId
        if (!dismissals.some((d) => d.accountId === k.accountId && d.userId === k.userId && d.showId === k.showId)) dismissals.push({ ...create })
      },
    },
    personPushSubscription: table([
      { id: 'd1', accountId: 'acc1', userId: 'sA', endpoint: 'https://push.example.com/a1', p256dh: 'x', auth: 'y', userAgent: 'Mozilla/5.0 (iPhone) Safari', label: null, lastSeenAt: null, createdAt: hoursAgo(30) },
      { id: 'd2', accountId: 'acc1', userId: 'sA', endpoint: 'https://push.example.com/a2', p256dh: 'x', auth: 'y', userAgent: 'Mozilla/5.0 (Windows) Chrome', label: 'Work laptop', lastSeenAt: hoursAgo(2), createdAt: hoursAgo(20) },
      { id: 'd3', accountId: 'acc1', userId: 'sB', endpoint: 'https://push.example.com/b1', p256dh: 'x', auth: 'y', userAgent: 'Mozilla/5.0 (Android) Chrome', label: 'Kitchen tablet', lastSeenAt: null, createdAt: hoursAgo(10) },
      { id: 'd4', accountId: 'acc2', userId: 'sA2', endpoint: 'https://push.example.com/a1', p256dh: 'x', auth: 'y', userAgent: null, label: null, lastSeenAt: null, createdAt: hoursAgo(10) },
    ]),
  }
}

let server
let base
let data

test.before(async () => {
  data = makeData()
  const app = express()
  app.use(express.json())
  app.use('/api/public-library', makePublicLibraryRouter({
    prisma: data, DEFAULT_ACCOUNT_ID: 'default', encrypt: (v) => v, decrypt: (v) => v,
    getCachedLibrary: () => [], setCachedLibrary: () => {}, JWT_SECRET: SECRET,
  }))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}/api/public-library`
})
test.after(() => {
  server.close()
  fs.rmSync(process.env.SHARES_DIR, { recursive: true, force: true })
  process.chdir(os.tmpdir())
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
})

const session = (id, provider) => jwt.sign({ sub: id, provider }, SECRET, { expiresIn: '1h' })
const stremioKey = (email) => `key-for-${email}`
const row = (id) => data.user.rows.find((u) => u.id === id)

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

// ---- every new route needs the person asking -----------------------------

const NEW_ROUTES = [
  ['PATCH', '/avatar', 'body', { colorIndex: 1 }],
  ['GET', '/nuvio-covers', 'query'],
  ['GET', '/nuvio-profiles', 'query'],
  ['POST', '/switch-nuvio-profile', 'body', { targetId: 'nP2' }],
  ['GET', '/continue-watching', 'query'],
  ['POST', '/continue-watching/dismiss', 'body', { showId: 'tt0000001' }],
  ['POST', '/push/devices', 'body'],
  ['PATCH', '/push/devices/d1', 'body', { label: 'Taken over' }],
  ['DELETE', '/push/devices/d1', 'body'],
]
const asPerson = (kind, userId, extra = {}) => (kind === 'query' ? { query: { userId, ...extra } } : { body: { userId, ...extra } })

test('no route here answers a request with no credential', async () => {
  for (const [method, route, kind, extra] of NEW_ROUTES) {
    assert.equal((await call(method, route, asPerson(kind, 'sA', extra))).status, 401, `${method} ${route}`)
  }
  // The upload too - and nothing was written.
  const form = new FormData()
  form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png')
  const res = await realFetch(`${base}/avatar/upload?userId=sA`, { method: 'POST', body: form })
  assert.equal(res.status, 401)
  assert.equal(fs.existsSync(AVATAR_DIR) ? fs.readdirSync(AVATAR_DIR).length : 0, 0)
})

test('another person\'s key (same household, other household, other provider) opens none of them', async () => {
  const before = JSON.stringify([data.user.rows, data.personPushSubscription.rows, data.dismissedContinueWatching.rows])
  const wrong = [
    stremioKey('b@example.com'), // a housemate
    session('jA', 'jellyfin'), // a different provider
    session('nA2', 'nuvio'), // the same Nuvio login in another household
    session('nOther', 'nuvio'), // another Nuvio login
  ]
  for (const key of wrong) {
    for (const [method, route, kind, extra] of NEW_ROUTES) {
      const res = await call(method, route, { key, ...asPerson(kind, 'sA', extra) })
      assert.equal(res.status, 401, `${method} ${route}`)
    }
  }
  // The other household's person, asked for by a key that is only good for the first one.
  assert.equal((await call('POST', '/push/devices', { key: stremioKey('a@example.com'), body: { userId: 'sA2' } })).status, 200, 'sA2 holds the same Stremio account, so its own key opens it')
  assert.equal((await call('POST', '/push/devices', { key: session('nA', 'nuvio'), body: { userId: 'sA2' } })).status, 401)
  assert.equal(JSON.stringify([data.user.rows, data.personPushSubscription.rows, data.dismissedContinueWatching.rows]), before, 'nothing was changed')
})

// ---- the person's own picture ---------------------------------------------

// 1x1 png and a small gif, with the real signatures.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const files = () => (fs.existsSync(AVATAR_DIR) ? fs.readdirSync(AVATAR_DIR) : [])
async function upload(key, userId, bytes, type = 'image/png', name = 'pic.png') {
  const form = new FormData()
  form.append('avatar', new Blob([bytes], { type }), name)
  const res = await realFetch(`${base}/avatar/upload?userId=${userId}`, { method: 'POST', headers: key ? { 'x-stremio-auth': key } : {}, body: form })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

test('picture: a colour or an image link is saved for the caller only', async () => {
  const key = stremioKey('a@example.com')
  const colour = await call('PATCH', '/avatar', { key, body: { userId: 'sA', colorIndex: 103, avatarUrl: null } })
  assert.equal(colour.status, 200)
  assert.equal(row('sA').colorIndex, 103)
  const link = await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl: 'https://img.example.com/sarah.gif' } })
  assert.equal(link.status, 200)
  assert.equal(row('sA').avatarUrl, 'https://img.example.com/sarah.gif')
  assert.equal(row('sA2').avatarUrl, null, 'the same Stremio account in another household is a different person')
  assert.equal(row('sB').avatarUrl, null)
  const info = await call('GET', '/user-info', { key, query: { userId: 'sA' } })
  assert.equal(info.body.avatarUrl, 'https://img.example.com/sarah.gif')
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl: null } })).status, 200)
  assert.equal(row('sA').avatarUrl, null)
})

test('picture: only http(s) links, the offered colours, and nothing else get saved', async () => {
  const key = stremioKey('a@example.com')
  for (const avatarUrl of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://example.com/a.png', 'https://user:pw@example.com/a.png',
    '/uploads/avatars/../../etc/passwd', '/uploads/avatars/not-a-uuid.png', '/uploads/avatars/11111111-2222-3333-4444-555555555555.png', 'x'.repeat(3000), 42, {}]) {
    const res = await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl } })
    assert.equal(res.status, 400, String(avatarUrl).slice(0, 40))
  }
  for (const colorIndex of [-1, 8, 99, 112, 1.5, '3', null]) {
    assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', colorIndex } })).status, 400, String(colorIndex))
  }
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA' } })).status, 400)
  assert.equal(row('sA').avatarUrl, null)
  assert.equal(row('sA').colorIndex, 103)
})

test('picture: an upload is the caller\'s, one file at a time, and the old file goes', async () => {
  const key = stremioKey('a@example.com')
  const first = await upload(key, 'sA', PNG)
  assert.equal(first.status, 201)
  assert.match(first.body.avatarUrl, /^\/uploads\/avatars\/[0-9a-f-]{36}\.png$/)
  assert.equal(row('sA').avatarUrl, first.body.avatarUrl)
  assert.deepEqual(files(), [path.basename(first.body.avatarUrl)])

  // An animated one keeps its type, and replaces the first file.
  const second = await upload(key, 'sA', GIF, 'image/gif', 'dance.gif')
  assert.equal(second.status, 201)
  assert.match(second.body.avatarUrl, /\.gif$/)
  assert.deepEqual(files(), [path.basename(second.body.avatarUrl)], 'the first picture was removed')

  // Their current file can be saved again, someone else's cannot be pointed at.
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl: second.body.avatarUrl } })).status, 200)
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl: '/uploads/avatars/11111111-2222-3333-4444-555555555555.png' } })).status, 400)

  // Going back to a colour removes the file too.
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', colorIndex: 4, avatarUrl: null } })).status, 200)
  assert.deepEqual(files(), [])
  assert.equal(row('sA').avatarUrl, null)
})

test('picture: a file another row still shows is left alone', async () => {
  const key = stremioKey('a@example.com')
  const up = await upload(key, 'sA', PNG)
  assert.equal(up.status, 201)
  row('sB').avatarUrl = up.body.avatarUrl // an admin pointed someone else at the same file
  assert.equal((await call('PATCH', '/avatar', { key, body: { userId: 'sA', avatarUrl: null } })).status, 200)
  assert.deepEqual(files(), [path.basename(up.body.avatarUrl)])
  row('sB').avatarUrl = null
  fs.rmSync(path.join(AVATAR_DIR, path.basename(up.body.avatarUrl)))
})

test('picture: an upload must be a real picture, signed in as the person it is for', async () => {
  const key = stremioKey('a@example.com')
  assert.equal((await upload(key, 'sA', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).status, 400, 'the type says png, the bytes say otherwise')
  assert.equal((await upload(key, 'sA', PNG, 'image/svg+xml', 'a.svg')).status, 400)
  assert.equal((await upload(key, 'sA', Buffer.alloc(6 * 1024 * 1024, 1), 'image/png')).status, 400, 'over 5 MB')
  assert.equal((await upload(stremioKey('b@example.com'), 'sA', PNG)).status, 401, 'a housemate\'s key')
  assert.equal((await upload(session('jA', 'jellyfin'), 'sA', PNG)).status, 401)
  assert.deepEqual(files(), [])
  assert.equal(row('sA').avatarUrl, null)
  // A Jellyfin person's own session works for their own page.
  const own = await upload(session('jA', 'jellyfin'), 'jA', PNG)
  assert.equal(own.status, 201)
  assert.equal(row('jA').avatarUrl, own.body.avatarUrl)
  assert.equal(row('jB').avatarUrl, null)
})

test('picture: uploads are rationed per person', async () => {
  const key = session('jB', 'jellyfin')
  let last
  for (let i = 0; i < 12; i++) last = await upload(key, 'jB', PNG)
  assert.equal(last.status, 429)
  assert.equal(files().filter((f) => f === path.basename(row('jB').avatarUrl)).length, 1)
  assert.equal(files().length, 2, 'one file for each person who uploaded (jA and jB), never a pile')
  // A different person is not held up by it.
  assert.equal((await upload(stremioKey('a@example.com'), 'sA', PNG)).status, 201)
})

test('covers: only for a Nuvio sign-in', async () => {
  assert.equal((await call('GET', '/nuvio-covers', { key: stremioKey('a@example.com'), query: { userId: 'sA' } })).status, 400)
  assert.equal((await call('GET', '/nuvio-covers', { key: session('jA', 'jellyfin'), query: { userId: 'jA' } })).status, 400)
})

// ---- switching Nuvio profiles ---------------------------------------------

test('profiles: a Nuvio member sees their own login\'s profiles, and only those', async () => {
  const res = await call('GET', '/nuvio-profiles', { key: session('nA', 'nuvio'), query: { userId: 'nA' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.profiles.map((p) => p.id), ['nA', 'nP2', 'nP3'], 'not nP4 (inactive group), nP5 (inactive), the other household or other login')
  assert.deepEqual(res.body.profiles.map((p) => p.current), [true, false, false])
  assert.deepEqual(res.body.profiles.map((p) => p.needsReconnect), [false, false, true])
  assert.equal(JSON.stringify(res.body).includes('refresh'), false, 'no login material in the answer')
})

test('profiles: nothing for a Stremio or Jellyfin member', async () => {
  assert.equal((await call('GET', '/nuvio-profiles', { key: stremioKey('a@example.com'), query: { userId: 'sA' } })).status, 400)
  assert.equal((await call('POST', '/switch-nuvio-profile', { key: session('jA', 'jellyfin'), body: { userId: 'jA', targetId: 'jB' } })).status, 400)
})

test('profiles: switching hands out a session for a sibling profile only', async () => {
  const key = session('nA', 'nuvio')
  const switched = await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA', targetId: 'nP2' } })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.userId, 'nP2')
  const decoded = jwt.verify(switched.body.sessionToken, SECRET)
  assert.equal(decoded.sub, 'nP2')
  assert.equal(decoded.provider, 'nuvio')
  assert.equal(JSON.stringify(switched.body).includes('refresh'), false)
  // The new token is the new profile's - and only theirs.
  assert.equal((await call('GET', '/user-info', { key: switched.body.sessionToken, query: { userId: 'nP2' } })).status, 200)
  assert.equal((await call('GET', '/user-info', { key: switched.body.sessionToken, query: { userId: 'nA' } })).status, 401)

  // Not: another household's profile on the same login, another login's, a Stremio person, a stranger's id,
  // a profile that is switched off or in no active group, yourself.
  for (const targetId of ['nA2', 'nOther', 'sA', 'jA', 'nope', 'nP4', 'nP5']) {
    const res = await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA', targetId } })
    assert.equal(res.status, 404, targetId)
    assert.equal(res.body.sessionToken, undefined, targetId)
  }
  assert.equal((await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA', targetId: 'nA' } })).status, 400)
  assert.equal((await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA' } })).status, 400)
  assert.equal((await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA', targetId: { id: 'nP2' } } })).status, 400)
  // A profile whose login is gone is refused with a reason.
  const lost = await call('POST', '/switch-nuvio-profile', { key, body: { userId: 'nA', targetId: 'nP3' } })
  assert.equal(lost.status, 409)
  assert.equal(lost.body.sessionToken, undefined)
})

test('profiles: a Nuvio row with no Nuvio login id switches to nothing, even to another such row', async () => {
  // Two rows that both have no nuvioUserId would match each other on a query
  // for it. Neither can list, switch, or be switched to.
  const key = session('nNull', 'nuvio')
  for (const [method, route, kind, extra] of [['GET', '/nuvio-profiles', 'query'], ['POST', '/switch-nuvio-profile', 'body', { targetId: 'nNull2' }]]) {
    const res = await call(method, route, { key, ...asPerson(kind, 'nNull', extra) })
    assert.ok([400, 401].includes(res.status), `${method} ${route} -> ${res.status}`)
    assert.equal(res.body.sessionToken, undefined)
    assert.equal(res.body.profiles, undefined)
  }
  // And nobody can switch onto them.
  const toNull = await call('POST', '/switch-nuvio-profile', { key: session('nA', 'nuvio'), body: { userId: 'nA', targetId: 'nNull' } })
  assert.equal(toNull.status, 404)
})

// ---- Continue Watching ------------------------------------------------------

test('continue watching: a person\'s row holds only their own shows, even when a housemate watched more recently', async () => {
  const mine = await call('GET', '/continue-watching', { key: stremioKey('a@example.com'), query: { userId: 'sA' } })
  assert.equal(mine.status, 200)
  assert.deepEqual(mine.body.items.map((i) => i.showId).sort(), ['tt0000001', 'tt0000002'])
  assert.equal(mine.body.items[0].providerType, 'stremio')
  assert.match(mine.body.items.find((i) => i.showId === 'tt0000001').appUrl, /^stremio:\/\/\/detail\/series\/tt0000001\/tt0000001:1:2$/)
  const theirs = await call('GET', '/continue-watching', { key: stremioKey('b@example.com'), query: { userId: 'sB' } })
  assert.deepEqual(theirs.body.items.map((i) => i.showId), ['tt0000003'], 'asked second, so a shared cache would have shown sA\'s row')
})

test('continue watching: the person filter comes before the limit, and each person has their own cache', async () => {
  const { getContinueWatching } = require('../server/utils/continueWatching')
  // The household's newest show is sB's. With a limit of one, a row capped
  // afterwards would be empty for sA.
  const whole = await getContinueWatching(data, 'acc1', 1)
  assert.deepEqual(whole.map((e) => e.userId), ['sB'])
  const onlyA = await getContinueWatching(data, 'acc1', 1, { userId: 'sA' })
  assert.deepEqual(onlyA.map((e) => e.userId), ['sA'])
  assert.equal(onlyA[0].showId, 'tt0000001')
  assert.deepEqual((await getContinueWatching(data, 'acc1', 1)).map((e) => e.userId), ['sB'], 'the household\'s own row is unchanged')
})

test('continue watching: only a title from their own history can be removed, and only from their own row', async () => {
  const key = stremioKey('a@example.com')
  // Someone else's show, and one nobody watched.
  assert.equal((await call('POST', '/continue-watching/dismiss', { key, body: { userId: 'sA', showId: 'tt0000003' } })).status, 404)
  assert.equal((await call('POST', '/continue-watching/dismiss', { key, body: { userId: 'sA', showId: 'tt9999999' } })).status, 404)
  assert.equal((await call('POST', '/continue-watching/dismiss', { key, body: { userId: 'sA', showId: 7 } })).status, 400)
  assert.equal(data.dismissedContinueWatching.rows.length, 0)

  const ok = await call('POST', '/continue-watching/dismiss', { key, body: { userId: 'sA', showId: 'tt0000001' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(data.dismissedContinueWatching.rows.map((d) => [d.accountId, d.userId, d.showId]), [['acc1', 'sA', 'tt0000001']])
  const after = await call('GET', '/continue-watching', { key, query: { userId: 'sA' } })
  assert.deepEqual(after.body.items.map((i) => i.showId), ['tt0000002'], 'gone at once - the cache was dropped')
  // A housemate's row is unaffected (the same show, if they had it, stays).
  const theirs = await call('GET', '/continue-watching', { key: stremioKey('b@example.com'), query: { userId: 'sB' } })
  assert.deepEqual(theirs.body.items.map((i) => i.showId), ['tt0000003'])
})

// ---- notification devices ---------------------------------------------------

test('devices: a person lists only their own, and this one is marked', async () => {
  const key = stremioKey('a@example.com')
  const res = await call('POST', '/push/devices', { key, body: { userId: 'sA', endpoint: 'https://push.example.com/a2' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.devices.map((d) => d.id), ['d2', 'd1'], 'newest first; not sB\'s tablet or the other household\'s device')
  assert.deepEqual(res.body.devices.map((d) => d.current), [true, false])
  assert.equal(JSON.stringify(res.body).includes('push.example.com'), false, 'a device\'s address is never sent back')
  assert.equal(res.body.devices[0].label, 'Work laptop')
  // The same endpoint string held by another household's person is not "this device".
  const other = await call('POST', '/push/devices', { key, body: { userId: 'sA2', endpoint: 'https://push.example.com/a1' } })
  assert.deepEqual(other.body.devices.map((d) => d.id), ['d4'])
})

test('devices: renaming and removing reach only the caller\'s own devices', async () => {
  const key = stremioKey('a@example.com')
  const snapshot = () => JSON.stringify(data.personPushSubscription.rows)
  const before = snapshot()
  // sB's tablet and the other household's device, by id, with sA's own key.
  for (const id of ['d3', 'd4', 'nope']) {
    assert.equal((await call('PATCH', `/push/devices/${id}`, { key, body: { userId: 'sA', label: 'Mine now' } })).status, 404, id)
    assert.equal((await call('DELETE', `/push/devices/${id}`, { key, body: { userId: 'sA' } })).status, 404, id)
  }
  assert.equal(snapshot(), before)

  for (const label of [7, 'x'.repeat(61), null]) {
    assert.equal((await call('PATCH', '/push/devices/d1', { key, body: { userId: 'sA', label } })).status, 400)
  }
  assert.equal((await call('PATCH', '/push/devices/d1', { key, body: { userId: 'sA', label: '  Sarah\'s iPhone ' } })).status, 200)
  assert.equal(data.personPushSubscription.rows.find((d) => d.id === 'd1').label, 'Sarah\'s iPhone')
  assert.equal((await call('PATCH', '/push/devices/d1', { key, body: { userId: 'sA', label: '   ' } })).status, 200)
  assert.equal(data.personPushSubscription.rows.find((d) => d.id === 'd1').label, null, 'an empty name goes back to the default')

  assert.equal((await call('DELETE', '/push/devices/d1', { key, body: { userId: 'sA' } })).status, 200)
  assert.deepEqual(data.personPushSubscription.rows.map((d) => d.id), ['d2', 'd3', 'd4'])
})
