// A member importing their own watch history from their Settings: a preview
// first (nothing written), then the import, through the same importer the admin
// uses. Each route has to be asked by that exact person (the rule in
// portalIdentity.test.js), only ever touches their own history inside their
// own household, is idempotent, and may only spend a few of the household's
// OMDb lookups per request.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jwt = require('jsonwebtoken')

process.env.SHARES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-shares-'))
// The OMDb meter writes under <cwd>/data: keep it out of the real one.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-histimport-'))
process.chdir(WORK_DIR)
delete process.env.OMDB_API_KEY

// A Stremio key is "key-for-<email>" here; the real call goes to Stremio.
const stremio = require('../server/utils/stremio')
stremio.validateStremioAuthKey = async (key) => {
  const m = /^key-for-(.+)$/.exec(String(key))
  if (!m) { const e = new Error('Invalid or expired Stremio auth key'); e.code = 1; throw e }
  return { user: { email: m[1] }, addons: [] }
}

const express = require('express')
const makePublicLibraryRouter = require('../server/routes/publicLibrary')

const SECRET = 'portal-history-import-secret'
const realFetch = global.fetch

// OMDb and Cinemeta are not asked: "Film N" is tt9000000+N, any other title
// is unknown, and no poster is found.
const omdbCalls = []
global.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init)
  if (u.includes('omdbapi.com')) {
    const title = new URL(u).searchParams.get('t')
    omdbCalls.push(title)
    const m = /^Film (\d+)$/.exec(title)
    const body = m ? { Response: 'True', imdbID: `tt${9000000 + Number(m[1])}`, Title: title, Year: '2001' } : { Response: 'False' }
    return { ok: true, json: async () => body }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
}

function match(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return want.in.includes(row[key])
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

const person = (id, accountId, extra) => ({
  id, accountId, username: id, email: `${id}@example.com`, isActive: true, providerType: 'stremio',
  nuvioRefreshToken: null, nuvioUserId: null, nuvioProfileId: 1, stremioAuthKey: null, ...extra,
})

let server
let base
let data
let omdbKey = 'test-omdb-key'

function makeData() {
  const history = []
  const ratings = []
  const trash = []
  return {
    user: table([
      person('sA', 'acc1', { email: 'a@example.com', stremioAuthKey: 'key-for-a@example.com' }),
      person('sB', 'acc1', { email: 'b@example.com', stremioAuthKey: 'key-for-b@example.com' }),
      person('sC', 'acc1', { email: 'c@example.com', stremioAuthKey: 'key-for-c@example.com' }),
      person('sR', 'acc1', { email: 'r@example.com', stremioAuthKey: 'key-for-r@example.com' }),
      person('nA', 'acc1', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1' }),
      person('nA2', 'acc2', { providerType: 'nuvio', nuvioUserId: 'nuvio-1', nuvioRefreshToken: 'refresh-1' }),
      person('jA', 'acc1', { providerType: 'jellyfin' }),
      person('sD', 'acc2', { email: 'd@example.com', stremioAuthKey: 'key-for-d@example.com' }),
    ]),
    group: table([
      { id: 'g1', accountId: 'acc1', isActive: true, userIds: JSON.stringify(['sA', 'sB', 'sC', 'sR', 'nA', 'jA']) },
      { id: 'g2', accountId: 'acc2', isActive: true, userIds: JSON.stringify(['sD', 'nA2']) },
    ]),
    // Only the first household has an OMDb key set up.
    appAccount: { findUnique: async ({ where }) => (where.id === 'acc1' && omdbKey ? { sync: { omdbApiKey: omdbKey } } : null) },
    movieWatchHistory: {
      rows: history,
      findMany: async ({ where }) => history.filter((r) => match(r, where)).map((r) => ({ itemId: r.itemId })),
      upsert: async ({ where, create }) => {
        const k = where.accountId_userId_itemId
        if (!history.some((r) => r.accountId === k.accountId && r.userId === k.userId && r.itemId === k.itemId)) history.push({ ...create })
      },
    },
    titleRating: {
      rows: ratings,
      findMany: async ({ where }) => ratings.filter((r) => match(r, where)).map((r) => ({ itemId: r.itemId })),
      upsert: async ({ where, create }) => {
        const k = where.accountId_itemId_season
        if (!ratings.some((r) => r.accountId === k.accountId && r.itemId === k.itemId && r.season === k.season)) ratings.push({ ...create })
      },
    },
    trashItem: { rows: trash, create: async ({ data: d }) => { trash.push(d); return d } },
  }
}

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
  global.fetch = realFetch
  fs.rmSync(process.env.SHARES_DIR, { recursive: true, force: true })
  process.chdir(os.tmpdir())
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
})

const session = (id, provider) => jwt.sign({ sub: id, provider }, SECRET, { expiresIn: '1h' })
const stremioKey = (email) => `key-for-${email}`
const KEY_A = stremioKey('a@example.com')
const histOf = (userId) => data.movieWatchHistory.rows.filter((r) => r.userId === userId)
const snapshot = () => JSON.stringify([data.movieWatchHistory.rows, data.titleRating.rows, data.trashItem.rows])

async function send(kind, { key, userId, text, name = 'history.csv', type = 'text/csv', bodyUserId } = {}) {
  const form = new FormData()
  if (text !== undefined) form.append('file', new Blob([text], { type }), name)
  if (bodyUserId) form.append('userId', bodyUserId)
  const route = kind === 'preview' ? '/history-import/preview' : '/history-import'
  const res = await realFetch(`${base}${route}${userId ? `?userId=${userId}` : ''}`, { method: 'POST', headers: key ? { 'x-stremio-auth': key } : {}, body: form })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

const CSV = [
  'imdbID,Title,Year,Watched Date,Your Rating',
  'tt0000001,Midnight Harbour,2020,2026-03-03,8',
  'tt0000002,Glass Meridian,2019,2026-02-14,',
  'tt0000003,Quiet Orchard,2018,2026-01-02,',
  'tt0000003,Quiet Orchard,2018,2026-01-05,',
  'tt0000004,Signal Fire,2017,2025-12-27,',
].join('\n')

const TRAKT = JSON.stringify([
  { watched_at: '2026-02-01T10:00:00.000Z', movie: { title: 'Tin Soldiers', year: 2016, ids: { imdb: 'tt0000010' } } },
  { watched_at: '2026-02-02T10:00:00.000Z', movie: { title: 'Harbour Lights', year: 2015, ids: { imdb: 'tt0000011' } } },
  { watched_at: '2026-02-03T10:00:00.000Z', show: { title: 'A Show', ids: { imdb: 'tt0000012' } }, episode: { season: 1, number: 1 } },
])

const filmsCsv = (from, to) => ['Title,Year,Watched Date', ...Array.from({ length: to - from + 1 }, (_, i) => `Film ${from + i},2001,2026-01-01`)].join('\n')

// ---- who may ask ----------------------------------------------------------

test('no credential: neither route accepts a file, and nothing is written', async () => {
  const before = snapshot()
  for (const kind of ['preview', 'import']) {
    assert.equal((await send(kind, { userId: 'sA', text: CSV })).status, 401, kind)
    // A user id in the body is not an identity, and the address is where it has to be.
    assert.equal((await send(kind, { key: KEY_A, text: CSV, bodyUserId: 'sA' })).status, 404, kind)
    assert.equal((await send(kind, { key: KEY_A, userId: 'nobody', text: CSV })).status, 404, kind)
  }
  assert.equal(snapshot(), before)
})

test('another person\'s key (housemate, other provider, other household) opens neither route', async () => {
  const before = snapshot()
  const wrong = [
    stremioKey('b@example.com'), // a housemate
    session('jA', 'jellyfin'), // a different provider
    session('nA2', 'nuvio'), // the same Nuvio login in another household
    stremioKey('d@example.com'), // a person in another household
  ]
  for (const key of wrong) {
    for (const kind of ['preview', 'import']) {
      assert.equal((await send(kind, { key, userId: 'sA', text: CSV })).status, 401, kind)
    }
  }
  // And the household's own person cannot be reached from the other household either.
  assert.equal((await send('import', { key: stremioKey('d@example.com'), userId: 'nA', text: CSV })).status, 401)
  assert.equal(snapshot(), before)
  assert.deepEqual(omdbCalls, [])
})

// ---- preview writes nothing -----------------------------------------------

test('preview: counts and titles for the caller, and not one row written', async () => {
  const before = snapshot()
  const res = await send('preview', { key: KEY_A, userId: 'sA', text: CSV })
  assert.equal(res.status, 200)
  assert.equal(res.body.dryRun, true)
  assert.equal(res.body.added, 4)
  assert.equal(res.body.alreadyThere, 1, 'the repeated title counts as already there')
  assert.deepEqual(res.body.ids, ['tt0000001', 'tt0000002', 'tt0000003', 'tt0000004'], 'every title that would be added, so several files can be added up exactly')
  assert.deepEqual(res.body.existingIds, [])
  assert.equal(res.body.skipped, 0)
  assert.deepEqual(res.body.titles.map((t) => t.name), ['Midnight Harbour', 'Glass Meridian', 'Quiet Orchard', 'Signal Fire'])
  assert.equal(snapshot(), before)
  assert.equal(data.trashItem.rows.length, 0, 'no undo entry for a preview')
})

test('preview: a Trakt file counts episodes as skipped, a bad one is refused', async () => {
  const res = await send('preview', { key: KEY_A, userId: 'sA', text: TRAKT, name: 'history.json', type: 'application/json' })
  assert.equal(res.status, 200)
  assert.equal(res.body.added, 2)
  assert.equal(res.body.skippedEpisodes, 1)
  assert.equal(res.body.skipped, 1)
  const wrong = await send('preview', { key: KEY_A, userId: 'sA', text: 'x', name: 'notes.txt', type: 'text/plain' })
  assert.equal(wrong.status, 400)
  assert.equal((await send('preview', { key: KEY_A, userId: 'sA' })).status, 400, 'no file')
  assert.equal((await send('preview', { key: KEY_A, userId: 'sA', text: '{"comments": []}', name: 'comments.json', type: 'application/json' })).status, 400)
  assert.equal(data.movieWatchHistory.rows.length, 0)
})

// ---- the import, idempotent, undoable --------------------------------------

test('import: lands in the caller\'s own history only, once, and is recorded to undo', async () => {
  const res = await send('import', { key: KEY_A, userId: 'sA', text: CSV })
  assert.equal(res.status, 200)
  assert.equal(res.body.added, 4)
  assert.equal(res.body.alreadyThere, 1)
  assert.deepEqual(histOf('sA').map((r) => r.itemId).sort(), ['tt0000001', 'tt0000002', 'tt0000003', 'tt0000004'])
  assert.ok(histOf('sA').every((r) => r.accountId === 'acc1' && r.profileLabel === 'Imported'))
  assert.equal(histOf('sB').length, 0, 'a housemate\'s history is untouched')
  assert.equal(data.titleRating.rows.length, 1)
  assert.equal(data.trashItem.rows.length, 1)
  const undo = JSON.parse(data.trashItem.rows[0].payload)
  assert.equal(data.trashItem.rows[0].kind, 'import')
  assert.equal(undo.userId, 'sA')
  assert.deepEqual(undo.createdItemIds.sort(), ['tt0000001', 'tt0000002', 'tt0000003', 'tt0000004'])
  assert.deepEqual(undo.createdRatingIds, ['tt0000001'])
})

test('import: again changes nothing, and the preview now says everything is there', async () => {
  const before = snapshot()
  const preview = await send('preview', { key: KEY_A, userId: 'sA', text: CSV })
  assert.equal(preview.body.added, 0)
  assert.equal(preview.body.alreadyThere, 5)
  const again = await send('import', { key: KEY_A, userId: 'sA', text: CSV })
  assert.equal(again.status, 200)
  assert.equal(again.body.added, 0)
  assert.equal(again.body.alreadyThere, 5)
  assert.equal(snapshot(), before, 'no new history, ratings or undo entry')
})

test('import: a housemate with the same file gets their own copy, in their own household only', async () => {
  const b = await send('import', { key: stremioKey('b@example.com'), userId: 'sB', text: CSV })
  assert.equal(b.body.added, 4)
  assert.equal(histOf('sB').length, 4)
  assert.equal(histOf('sA').length, 4)
  const d = await send('import', { key: stremioKey('d@example.com'), userId: 'sD', text: CSV })
  assert.equal(d.status, 200)
  assert.ok(histOf('sD').length === 4 && histOf('sD').every((r) => r.accountId === 'acc2'))
  assert.equal(data.titleRating.rows.filter((r) => r.accountId === 'acc2').length, 1, 'ratings are kept per household')
})

// ---- OMDb allowance --------------------------------------------------------

test('title-only rows: one request spends at most 50 lookups; the preview\'s are remembered', async () => {
  omdbCalls.length = 0
  const file = filmsCsv(1, 60)
  const preview = await send('preview', { key: stremioKey('c@example.com'), userId: 'sC', text: file })
  assert.equal(preview.status, 200)
  assert.equal(omdbCalls.length, 50, 'capped')
  assert.equal(preview.body.added, 50)
  assert.equal(preview.body.skipped, 10)
  assert.equal(preview.body.lookupsCapped, true)
  assert.equal(preview.body.unresolvedTitles.length, 10)
  assert.equal(histOf('sC').length, 0)

  // Importing what was previewed re-uses the 50 found; only the other 10 are looked up.
  const done = await send('import', { key: stremioKey('c@example.com'), userId: 'sC', text: file })
  assert.equal(done.body.added, 60)
  assert.equal(omdbCalls.length, 60)
  assert.equal(done.body.lookupsCapped, false)
  assert.equal(histOf('sC').length, 60)
})

test('title-only rows: rows that carry an IMDb id cost no lookup, and a missing key resolves nothing', async () => {
  omdbCalls.length = 0
  await send('preview', { key: KEY_A, userId: 'sA', text: CSV })
  assert.deepEqual(omdbCalls, [])
  // The other household has no key: titles are left unresolved, nothing is asked of OMDb.
  const res = await send('preview', { key: stremioKey('d@example.com'), userId: 'sD', text: filmsCsv(100, 103) })
  assert.equal(res.status, 200)
  assert.equal(res.body.added, 0)
  assert.equal(res.body.skipped, 4)
  assert.deepEqual(res.body.unresolvedTitles, ['Film 100', 'Film 101', 'Film 102', 'Film 103'])
  assert.deepEqual(omdbCalls, [])
})

// ---- other providers -------------------------------------------------------

test('a Jellyfin and a Nuvio member use it the same way', async () => {
  const j = await send('import', { key: session('jA', 'jellyfin'), userId: 'jA', text: CSV })
  assert.equal(j.status, 200)
  assert.equal(histOf('jA').length, 4)
  const n = await send('import', { key: session('nA', 'nuvio'), userId: 'nA', text: CSV })
  assert.equal(n.status, 200)
  assert.equal(histOf('nA').length, 4)
})

// ---- rationing -------------------------------------------------------------

test('requests are rationed per person, and one person\'s limit does not stop another', async () => {
  const key = stremioKey('r@example.com')
  let last
  for (let i = 0; i < 41; i++) last = await send('preview', { key, userId: 'sR' })
  assert.equal(last.status, 429)
  assert.equal((await send('preview', { key, userId: 'sR', text: CSV })).status, 429)
  assert.equal((await send('preview', { key: KEY_A, userId: 'sA', text: CSV })).status, 200)
})
