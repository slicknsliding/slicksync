// A protected AIOStreams (its own sign-in page switched on) only saves
// configuration changes made while signed in there: SlickSync sends people
// to that page instead of offering changes it would refuse.
const test = require('node:test')
const assert = require('node:assert/strict')

const safeUrl = require('../server/utils/safeUrl')
let statusBody = null
let statusCalls = 0
safeUrl.safeFetch = async (url) => {
  statusCalls += 1
  assert.match(url, /\/api\/v1\/status$/)
  return { ok: true, json: async () => statusBody }
}
const household = require('../server/utils/aioHousehold')
const config = require('../server/utils/aiostreamsConfig')

const owner = (host) => ({ jellyfinServerKind: 'aiostreams', jellyfinServerUrl: `https://${host}/jellyfin/abc` })

test('a protected AIOStreams is sent to its own configure page; an open one is not', async () => {
  statusBody = { data: { settings: { protected: true } } }
  assert.equal(await household.protectedPage(owner('aio-locked.example.invalid')), 'https://aio-locked.example.invalid/stremio/configure')
  statusBody = { data: { settings: { protected: false } } }
  assert.equal(await household.protectedPage(owner('aio-open.example.invalid')), null)
  // AIOMetadata has no such switch
  assert.equal(await household.protectedPage({ jellyfinServerKind: 'aiometadata', jellyfinServerUrl: 'https://x.example.invalid' }), null)
  // Asked again soon: the answer is remembered, not fetched every time
  const before = statusCalls
  await household.protectedPage(owner('aio-locked.example.invalid'))
  assert.equal(statusCalls, before)
})

test('a save refused for that reason says what it means', async () => {
  const realFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ success: false, error: { code: 'ADDON_PASSWORD_INVALID', message: 'Invalid addon password' } }) })
  try {
    await assert.rejects(
      config.writeConfig({ serverUrl: 'https://aio.example.invalid/jellyfin/abc', account: 'uuid', password: 'pw' }, {}),
      (e) => /only saves changes made while signed in on its own page/.test(e.message) && e.status === 409 && e.protectedInstance === true,
    )
  } finally {
    global.fetch = realFetch
  }
})

test("this install's own AIOStreams is saved to with the sign-in it already has - never another AIOStreams, never on a shared instance", async () => {
  const realFetch = global.fetch
  const sent = []
  global.fetch = async (url, init = {}) => {
    sent.push({ url, cookie: init.headers?.Cookie || null })
    if (url.endsWith('/api/v1/auth/login')) return { ok: true, headers: { getSetCookie: () => ['aiostreams.session=abc; Path=/; HttpOnly'] } }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  }
  Object.assign(process.env, { AIOSTREAMS_URL: 'https://aio-own.example.invalid', AIOSTREAMS_AUTH_USERNAME: 'owner', AIOSTREAMS_AUTH_PASSWORD: 'pw' })
  try {
    await config.writeConfig({ serverUrl: 'https://aio-own.example.invalid/jellyfin', account: 'uuid', password: 'cfg' }, {})
    assert.equal(sent.find((s) => s.url.endsWith('/api/v1/user')).cookie, 'aiostreams.session=abc')
    sent.length = 0
    await config.writeConfig({ serverUrl: 'https://someone-else.example.invalid/jellyfin', account: 'uuid', password: 'cfg' }, {})
    assert.ok(!sent.some((s) => s.url.includes('/auth/login')) && sent[0].cookie === null)
    // The card: a protected AIOStreams it can sign in to offers the normal Add
    statusBody = { data: { settings: { protected: true } } }
    assert.equal(await household.protectedPage({ jellyfinServerKind: 'aiostreams', jellyfinServerUrl: 'https://aio-own.example.invalid/jellyfin' }), null)
    // A shared instance never uses it
    const cfg = require('../server/utils/config')
    const was = cfg.INSTANCE_TYPE
    cfg.INSTANCE_TYPE = 'public'
    try { assert.equal(await config.ownInstanceSession('https://aio-own.example.invalid'), null) } finally { cfg.INSTANCE_TYPE = was }
  } finally {
    global.fetch = realFetch
    delete process.env.AIOSTREAMS_URL; delete process.env.AIOSTREAMS_AUTH_USERNAME; delete process.env.AIOSTREAMS_AUTH_PASSWORD
  }
})
