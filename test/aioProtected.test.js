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
  assert.equal(await household.protectedPage(owner('aio-locked.example.invalid')), 'https://aio-locked.example.invalid/configure')
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
