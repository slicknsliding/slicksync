// A person's own Activity: watch time is stored a minute or two at a time, so
// one sitting is many rows. It shows as one viewing per title (episode, for a
// show) per day, its time added up - not a card and a "play" per slice.
const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const day = (d) => new Date(Date.UTC(2026, 7, d))
let n = 0
const slice = (d, itemId, secs, itemType = 'movie', videoId = null) => ({ id: 'wa' + (++n), accountId: 'acc1', userId: 'sA', itemId, date: day(d), watchTimeSeconds: secs, itemType, videoId, profileLabel: null, createdAt: day(d) })
const SLICES = [
  ...Array.from({ length: 27 }, () => slice(3, 'tt35587659', 90)),
  ...Array.from({ length: 8 }, () => slice(4, 'tt35587659', 90)),
  slice(4, 'tt0096697', 600, 'series', 'tt0096697:1:1'), slice(4, 'tt0096697', 300, 'series', 'tt0096697:1:1'),
  slice(4, 'tt0096697', 400, 'series', 'tt0096697:1:2'),
]


// A Stremio key is "key-for-<email>" here; the real call goes to Stremio.
const stremio = require('../server/utils/stremio')
stremio.validateStremioAuthKey = async (key) => {
  const m = /^key-for-(.+)$/.exec(String(key))
  if (!m) { const e = new Error('Invalid or expired Stremio auth key'); e.code = 1; throw e }
  return { user: { email: m[1] }, addons: [] }
}

const express = require('express')
const config = require('../server/utils/config')
const makePublicLibraryRouter = require('../server/routes/publicLibrary')

const SECRET = 'portal-identity-test-secret'
const realFetch = global.fetch
const configuredType = config.INSTANCE_TYPE

function match(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => match(row, w))
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return want.in.includes(row[key])
      if ('contains' in want) return String(row[key] ?? '').includes(want.contains)
    }
    return row[key] === want
  })
}
// Like Prisma: only the selected columns come back.
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })
function table(rows) {
  return {
    rows,
    findFirst: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findUnique: async ({ where, select } = {}) => { const r = rows.find((x) => match(x, where)); return r ? pick(r, select) : null },
    findMany: async ({ where, select } = {}) => rows.filter((x) => match(x, where)).map((r) => pick(r, select)),
    update: async ({ where, data, select }) => { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return pick(r, select) },
  }
}

const person = (id, accountId, extra) => ({
  id, accountId, username: id, email: `${id}@example.com`, isActive: true, providerType: 'stremio', colorIndex: 0,
  activityVisibility: 'private', createdAt: new Date('2026-01-01'), expiresAt: null, apiKey: null, stremioAuthKey: null,
  nuvioRefreshToken: null, nuvioUserId: null, protectedAddons: null, discordWebhookUrl: null, notifyOnWatch: true,
  publicStatsEnabled: false, publicStatsSlug: null, providerConnectionErrorAt: null, ...extra,
})

function makeData() {
  return {
    user: table([
      // Household 1: two Stremio people and a Nuvio and two Jellyfin ones.
      person('sA', 'acc1', { email: 'a@example.com', stremioAuthKey: 'key-for-a@example.com' }),
      person('sB', 'acc1', { email: 'b@example.com', stremioAuthKey: 'key-for-b@example.com', apiKey: 'sealed-key-of-b', discordWebhookUrl: 'https://discord.example.com/api/webhooks/1/secret' }),
      person('nA', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1' }),
      person('jA', 'acc1', { providerType: 'jellyfin' }),
      person('jB', 'acc1', { providerType: 'jellyfin' }),
      // Household 2 holds the same Stremio account and the same Nuvio account as sA and nA.
      person('sA2', 'acc2', { email: 'a@example.com', stremioAuthKey: 'key-for-a@example.com' }),
      person('sC', 'acc2', { email: 'c@example.com' }),
      person('nA2', 'acc2', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1' }),
    ]),
    group: table([
      { id: 'g1', accountId: 'acc1', isActive: true, userIds: JSON.stringify(['sA', 'sB', 'nA', 'jA', 'jB']) },
      { id: 'g2', accountId: 'acc2', isActive: true, userIds: JSON.stringify(['sA2', 'sC', 'nA2']) },
    ]),
    movieWatchHistory: table([]),
    episodeWatchHistory: table([]),
    watchlistItem: table([]),
    watchActivity: table(SLICES),
    watchSession: table([]),
  }
}

let server
let base
let data
let originalFetch = realFetch

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
})

const session = (id, provider) => jwt.sign({ sub: id, provider }, SECRET, { expiresIn: '1h' })
const stremioKey = (email) => `key-for-${email}`

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


test('slices of one sitting are one viewing, and one play', async () => {
  const r = await call('GET', '/activity', { key: stremioKey('a@example.com'), query: { userId: 'sA', limit: '200' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const film = r.body.sessions.filter((s) => s.itemId === 'tt35587659')
  assert.equal(film.length, 2, 'one a day, two days')
  assert.deepEqual(film.map((s) => s.durationSeconds).sort((a, b) => a - b), [720, 2430])
  const eps = r.body.sessions.filter((s) => s.itemId === 'tt0096697')
  assert.equal(eps.length, 2, 'two episodes stay two')
  assert.equal(eps.reduce((a, s) => a + s.durationSeconds, 0), 1300)
  const top = r.body.mostWatchedList.find((m) => m.id === 'tt35587659')
  assert.equal(top.count, 2)
  assert.equal(r.body.stats.totalWatchTimeSeconds, 35 * 90 + 1300, 'the total is unchanged')
})
