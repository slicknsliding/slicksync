// The library buttons (add/remove, delete, backup, view) used to ask "Stremio
// auth key, or a Nuvio sign-in?" by hand and selected only those columns, so
// they told every Jellyfin, AIOStreams and AIOMetadata person "User not
// connected to a provider". They now select PROVIDER_SELECT and ask
// isProviderConnected() (server/utils/providerInfo.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicksync-libcache-'))
process.env.LIBRARIES_CACHE_DIR = cacheDir
const express = require('express')
const makeUsersRouter = require('../server/routes/users')

const ROWS = {
  jf: { id: 'jf', accountId: 'acc', isActive: true, email: 'someone@example.com', username: 'someone', providerType: 'jellyfin', jellyfinServerKind: 'jellyfin', jellyfinServerUrl: 'https://jellyfin.example.com', jellyfinUserId: 'u1', jellyfinToken: 'enc-token' },
  aio: { id: 'aio', accountId: 'acc', isActive: true, email: 'aio@example.com', username: 'aio', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio.example.com', jellyfinUserId: 'u2', jellyfinToken: 'enc-token' },
  gone: { id: 'gone', accountId: 'acc', isActive: true, email: 'gone@example.com', username: 'gone', providerType: 'jellyfin', jellyfinServerKind: 'jellyfin', jellyfinServerUrl: 'https://jellyfin.example.com', jellyfinUserId: null, jellyfinToken: null },
}

// Returns only the selected columns, like Prisma - a route that forgets the
// Jellyfin columns gets a row without them, which is what the bug was.
const prisma = {
  user: {
    findFirst: async ({ where, select }) => {
      const row = ROWS[where.id]
      if (!row || where.accountId !== row.accountId) return null
      if (!select) return { ...row }
      return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
    },
  },
}

const calls = []
const library = [{ _id: 'tt0000001', name: 'A Film', type: 'movie', removed: false }]
// Stands in for providers/index.js: a Jellyfin provider needs the sign-in columns.
function createProvider(user) {
  if (user.providerType !== 'jellyfin' || !user.jellyfinToken) return null
  return {
    type: 'jellyfin',
    supportsLibraryWrite: true,
    getLibrary: async () => library.map((i) => ({ ...i })),
    addLibraryItem: async (changes) => { calls.push(['add', user.id, changes.map((c) => c._id)]); return {} },
    removeLibraryItem: async (changes) => { calls.push(['remove', user.id, changes.map((c) => c._id)]); return {} },
  }
}

let base
let server
test.before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/users', makeUsersRouter({ prisma, getAccountId: () => 'acc', decrypt: (v) => v, createProvider }))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}/users`
})
test.after(() => {
  server.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

for (const id of ['jf', 'aio']) {
  test(`${id}: add to library goes through the Jellyfin provider`, async () => {
    const res = await fetch(`${base}/${id}/library/toggle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ itemId: 'tt0000002', itemType: 'movie', itemName: 'Another Film', addToLibrary: true }] }),
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.successCount, 1)
    assert.deepEqual(calls.at(-1), ['add', id, ['tt0000002']])
  })

  test(`${id}: delete from library goes through the Jellyfin provider`, async () => {
    const res = await fetch(`${base}/${id}/library/tt0000001`, { method: 'DELETE' })
    assert.equal(res.status, 200, await res.text())
    assert.deepEqual(calls.at(-1), ['remove', id, ['tt0000001']])
  })

  test(`${id}: library backup downloads the Jellyfin library`, async () => {
    const res = await fetch(`${base}/${id}/library/backup`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition'), id === 'aio' ? /AIOStreams-Library-/ : /Jellyfin-Library-/)
    assert.equal((await res.json())[0]._id, 'tt0000001')
  })

  test(`${id}: library view loads`, async () => {
    const res = await fetch(`${base}/${id}/library`)
    assert.equal(res.status, 200, await res.text())
  })
}

test('a Jellyfin person with no sign-in is still told they are not connected', async () => {
  const toggle = await fetch(`${base}/gone/library/toggle`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ itemId: 'tt0000002', itemType: 'movie', addToLibrary: true }] }),
  })
  assert.equal(toggle.status, 400)
  assert.equal((await toggle.json()).message, 'User not connected to a provider')
  for (const url of [`${base}/gone/library/tt0000001`, `${base}/gone/library/backup`]) {
    const res = await fetch(url, { method: url.endsWith('backup') ? 'GET' : 'DELETE' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'User not connected to a provider')
  }
})
