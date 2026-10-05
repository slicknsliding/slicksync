// SlickTrax inside an AIOStreams configuration (server/utils/aioSlickTrax.js):
// added for the household, and watched so they hear when their AIOStreams
// watch history stops reaching SlickSync. Config shapes follow AIOStreams 2.35.
const test = require('node:test')
const assert = require('node:assert/strict')
const trax = require('../server/utils/aioSlickTrax')

const TOKEN = 'a'.repeat(48)
const BASE = 'https://slicksync.example.com'
const person = (extra = {}) => ({
  id: 'p1', username: 'Sam', accountId: 'acc', providerType: 'jellyfin', jellyfinServerKind: 'aiostreams',
  jellyfinServerUrl: 'https://aio.example.com/jellyfin/u/family', aioConfigId: 'cfg', aioConfigPassword: 'enc',
  traxToken: TOKEN, watchStateEnabled: true, watchStateViewers: null, ...extra,
})
const decrypt = () => 'secret'
const slickTrax = (extra = {}) => ({ type: 'custom', instanceId: 'st1', enabled: true, options: { name: 'SlickTrax', manifestUrl: `${BASE}/trax/${TOKEN}/aio/manifest.json` }, ...extra })

// AIOStreams' user API: GET returns the configuration, PUT saves it (or refuses).
function fakeAio(config, { refuse = null } = {}) {
  const saved = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      if (refuse) return { ok: false, status: 400, json: async () => ({ success: false, error: { message: refuse } }) }
      const body = JSON.parse(opts.body)
      saved.push(body.config)
      config = body.config
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { userData: JSON.parse(JSON.stringify(config)) } }) }
  }
  return { saved, restore: () => { global.fetch = original } }
}
const prisma = {
  user: { update: async () => ({}), findUnique: async () => ({ aioConfigStateJson: '{}' }), findMany: async () => [] },
}

test('install: adds SlickTrax as a custom addon, keeping everything else', async () => {
  const other = { type: 'torrentio', instanceId: 'tor', enabled: true, options: {} }
  const s = fakeAio({ presets: [other], services: [{ id: 'realdebrid', credentials: { apiKey: 'k' } }] })
  try {
    assert.deepEqual(await trax.installSlickTrax(prisma, decrypt, person(), BASE), { added: true })
    const cfg = s.saved[0]
    assert.equal(cfg.presets.length, 2)
    assert.deepEqual(cfg.presets[0], other, 'the other addon untouched')
    assert.equal(cfg.presets[1].type, 'custom')
    assert.equal(cfg.presets[1].options.manifestUrl, `${BASE}/trax/${TOKEN}/aio/manifest.json`)
    assert.deepEqual(cfg.services, [{ id: 'realdebrid', credentials: { apiKey: 'k' } }])
    // Already there: nothing written.
    assert.deepEqual(await trax.installSlickTrax(prisma, decrypt, person(), BASE), { already: true })
    assert.equal(s.saved.length, 1)
  } finally { s.restore() }
})

test('install: switched off in AIOStreams is switched back on, not added twice', async () => {
  const s = fakeAio({ presets: [slickTrax({ enabled: false })] })
  try {
    assert.deepEqual(await trax.installSlickTrax(prisma, decrypt, person(), BASE), { added: true })
    assert.equal(s.saved[0].presets.length, 1)
    assert.equal(s.saved[0].presets[0].enabled, true)
  } finally { s.restore() }
})

test('install: AIOStreams\' refusals in plain words', async () => {
  const full = fakeAio({ presets: [] }, { refuse: 'Your current configuration requires 16 addons, but the maximum allowed is 15. Please reduce the number of addons installed or services enabled.' })
  try {
    await assert.rejects(trax.installSlickTrax(prisma, decrypt, person(), BASE), /configuration is full - AIOStreams allows 15 addons/)
  } finally { full.restore() }
  const unreachable = fakeAio({ presets: [] }, { refuse: 'Failed to fetch manifest for SlickTrax: 404 - Not Found' })
  try {
    await assert.rejects(trax.installSlickTrax(prisma, decrypt, person(), BASE), /couldn't reach SlickSync at https:\/\/slicksync\.example\.com/)
  } finally { unreachable.restore() }
  await assert.rejects(trax.installSlickTrax(prisma, decrypt, person({ aioConfigPassword: null }), BASE), /configuration password/)
  await assert.rejects(trax.installSlickTrax(prisma, decrypt, person(), ''), /Public address of this instance/)
})

const counts = (recent, earlier) => ({
  watchStateEvent: { count: async ({ where }) => (where.createdAt.lt ? earlier : recent) },
})

test('watch: SlickTrax gone, or switched off', async () => {
  for (const cfg of [{ presets: [] }, { presets: [slickTrax({ enabled: false })] }]) {
    const problems = await trax.findProblems(counts(5, 5), person(), cfg)
    assert.deepEqual(problems.map((p) => p.kind), ['missing'])
  }
})

test('watch: a household user whose tracker list leaves SlickTrax out', async () => {
  const cfg = { presets: [slickTrax()], jellyfin: { personas: [
    { id: 'a', name: 'Mia', history: 'own', trackers: ['other'] },
    { id: 'b', name: 'Leo', history: 'own' },
    { id: 'c', name: 'Guest', history: 'shared' },
    { id: 'd', name: 'Ada', history: 'own', trackers: ['st1'] },
  ] } }
  const problems = await trax.findProblems(counts(5, 5), person(), cfg)
  assert.deepEqual(problems.map((p) => p.kind), ['trackers'])
  assert.match(problems[0].body, /^Mia:/, 'no list means every tracker; shared history uses the main user\'s')
})

test('watch: libraries at the cap without SlickSync\'s collections', async () => {
  const cfg = { presets: [slickTrax()] }
  const twenty = Array.from({ length: 20 }, (_, i) => `Catalog ${i}`)
  const at = (names) => trax.findProblems(counts(5, 5), person(), cfg, { libraries: { names, max: 20, hasCatalogs: true } })
  assert.deepEqual((await at(twenty)).map((p) => p.kind), ['libraries'])
  assert.deepEqual(await at([...twenty.slice(0, 19), 'SlickSync catalogs']), [], 'it made the cut')
  assert.deepEqual(await at(twenty.slice(0, 12)), [], 'under the cap: hidden on purpose, not cut')
})

test('watch: quiet for a week after arriving the week before - not when it never arrived', async () => {
  const cfg = { presets: [slickTrax()] }
  assert.deepEqual((await trax.findProblems(counts(0, 9), person(), cfg)).map((p) => p.kind), ['quiet'])
  assert.deepEqual(await trax.findProblems(counts(0, 0), person(), cfg), [])
  assert.deepEqual(await trax.findProblems(counts(3, 9), person(), cfg), [])
})

test('alerts: once when a problem starts, again only after it was fixed and came back', async () => {
  let sync = {}
  const db = {
    appAccount: {
      findUnique: async () => ({ sync: JSON.stringify(sync) }),
      update: async ({ data }) => { sync = JSON.parse(data.sync) },
    },
  }
  const sent = []
  const alert = async (_p, _a, n) => sent.push(n)
  const missing = [{ kind: 'missing', title: 't', body: 'b' }]
  await trax.settle(db, 'acc', person(), missing, { alert, now: 1000 })
  await trax.settle(db, 'acc', person(), missing, { alert, now: 2000 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, '/users/p1')
  await trax.settle(db, 'acc', person(), [], { alert, now: 3000 })
  assert.deepEqual(sync.aioSlickTraxIssues, {}, 'fixed: forgotten')
  await trax.settle(db, 'acc', person(), missing, { alert, now: 4000 })
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].dedupeKey, sent[1].dedupeKey)
})
