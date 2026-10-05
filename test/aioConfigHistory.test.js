// AIOStreams configuration history (server/utils/aioConfigHistory.js):
// versions kept encrypted, compared, and put back without bringing back old
// debrid keys, household users or API keys unless asked.
const test = require('node:test')
const assert = require('node:assert/strict')
const history = require('../server/utils/aioConfigHistory')

const person = { id: 'p1', username: 'Sam', accountId: 'acc', jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio.example.com/jellyfin', aioConfigId: 'cfg', aioConfigPassword: 'enc' }

function store() {
  const rows = []
  let n = 0
  return {
    rows,
    aioConfigSnapshot: {
      findFirst: async ({ where, orderBy }) => {
        const hits = rows.filter((r) => r.accountId === where.accountId && r.configKey === where.configKey && (!where.id || r.id === where.id))
        return (orderBy ? hits.slice().reverse() : hits)[0] || null
      },
      findMany: async ({ where, skip = 0 }) => rows.filter((r) => r.accountId === where.accountId && r.configKey === where.configKey).slice().reverse().slice(skip),
      create: async ({ data }) => { rows.push({ id: `s${++n}`, createdAt: new Date(Date.now() + n * 1000), ...data }); return data },
      deleteMany: async ({ where }) => { for (const id of where.id.in) rows.splice(rows.findIndex((r) => r.id === id), 1) },
    },
    user: { findFirst: async () => person },
  }
}

const cfg = (extra = {}) => ({ uuid: 'cfg', presets: [{ instanceId: 'a', type: 'torrentio', enabled: true, options: { name: 'Torrentio' } }], services: [{ id: 'realdebrid', credentials: { apiKey: 'OLDKEY' } }], ...extra })

test('a version is kept once, encrypted, and the oldest go past the limit', async () => {
  const db = store()
  assert.equal(await history.remember(db, person, cfg(), 'seen'), true)
  assert.equal(await history.remember(db, person, cfg(), 'seen'), false, 'the same version again: nothing new')
  assert.equal(db.rows[0].config.includes('OLDKEY'), false, 'the debrid key is never stored readable')
  assert.equal(db.rows[0].summary.includes('OLDKEY'), false)
  for (let i = 0; i < history.KEEP_PER_CONFIG + 3; i++) await history.remember(db, person, cfg({ formatter: { id: `f${i}` } }), 'seen')
  assert.equal(db.rows.length, history.KEEP_PER_CONFIG)
})

test('the list says what changed between versions, newest first', async () => {
  const db = store()
  await history.remember(db, person, cfg(), 'seen')
  await history.remember(db, person, cfg({ presets: [] }), 'seen')
  const h = await history.historyFor(db, 'acc', 'p1')
  assert.equal(h.available, true)
  assert.equal(h.versions[0].current, true)
  assert.deepEqual(h.versions[0].changes, ['removed Torrentio'])
  assert.deepEqual(h.versions[1].changes, [], 'the first one kept has nothing before it')
})

test('putting a version back keeps today\'s services, household users and API keys by default', () => {
  const old = cfg({ presets: [{ instanceId: 'b', type: 'comet', options: { name: 'Comet' } }], jellyfin: { personas: [{ id: 'gone', name: 'Gone' }], apiKeys: [{ id: 'old' }], maxVersions: 5 }, encryptedPassword: 'OLD' })
  const now = cfg({ services: [{ id: 'realdebrid', credentials: { apiKey: 'NEWKEY' } }], jellyfin: { personas: [{ id: 'mia', name: 'Mia', lock: '$2b$10$x' }], apiKeys: [{ id: 'new' }] }, encryptedPassword: 'NOW' })
  const merged = history.merge(old, now)
  assert.deepEqual(merged.presets, old.presets, 'the old addons come back')
  assert.equal(merged.services[0].credentials.apiKey, 'NEWKEY', 'not the dead key')
  assert.deepEqual(merged.jellyfin.personas, now.jellyfin.personas, 'not a removed user or an old PIN')
  assert.deepEqual(merged.jellyfin.apiKeys, now.jellyfin.apiKeys)
  assert.equal(merged.jellyfin.maxVersions, 5, 'its own Jellyfin settings come back')
  assert.equal(merged.encryptedPassword, 'NOW', 'AIOStreams\' own values are today\'s')
  const everything = history.merge(old, now, { keepServices: false, keepPersonas: false, keepApiKeys: false })
  assert.equal(everything.services[0].credentials.apiKey, 'OLDKEY')
  assert.deepEqual(everything.jellyfin.personas, old.jellyfin.personas)
})

test('restore: refused over the instance\'s limits, and an old version it no longer keeps', async () => {
  const db = store()
  const { encrypt } = require('../server/utils/encryption')
  await history.remember(db, person, cfg({ variants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), 'seen')
  const original = global.fetch
  global.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/api/v1/status') return { ok: true, json: async () => ({ data: { settings: { variants: { max: 2 }, jellyfin: { maxPersonas: 20 } } } }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { userData: cfg() } }) }
  }
  try {
    const real = require('../server/utils/encryption').decrypt
    // The stored configuration is really encrypted; the password here is a stand-in.
    const decrypt = (t, req) => (t === 'enc' ? 'secret' : real(t, req))
    await assert.rejects(history.restore(db, decrypt, 'acc', 'p1', db.rows[0].id), /3 variants, and this AIOStreams allows 2/)
    await assert.rejects(history.restore(db, decrypt, 'acc', 'p1', 'nope'), /no longer kept/)
  } finally {
    global.fetch = original
  }
  assert.ok(encrypt)
})
