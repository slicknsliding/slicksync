// Debrid checks read the end date from the service itself, name it the same
// way everywhere ("expires Dec 31, 2026"), and TorBox names its plan.
const test = require('node:test')
const assert = require('node:assert/strict')
const { runCheck, TORBOX_PLANS } = require('../server/utils/vaultCheckers')

// Answers each service's own account call with a canned body.
function fakeFetch(t, answer) {
  const real = global.fetch
  const seen = []
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), auth: opts.headers?.Authorization })
    const { status = 200, body } = answer(String(url))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { global.fetch = real })
  return seen
}
const END = '2026-12-31T07:43:00Z'
const END_SECS = Date.parse(END) / 1000

test('TorBox: names the plan and the end date', async (t) => {
  fakeFetch(t, () => ({ body: { data: { plan: 1, premium_expires_at: END } } }))
  const r = await runCheck('torbox', 'key', {})
  assert.equal(r.ok, true)
  assert.equal(r.message, 'Essential plan, expires Dec 31, 2026')
  assert.equal(r.expiresAt.toISOString(), new Date(END).toISOString())
  assert.deepEqual(TORBOX_PLANS[3], { name: 'Standard', monthlyUsd: 5 })
})

test('TorBox: the free plan is not active', async (t) => {
  fakeFetch(t, () => ({ body: { data: { plan: 0 } } }))
  const r = await runCheck('torbox', 'key', {})
  assert.equal(r.ok, false)
})

test('Real-Debrid: premium with its end date', async (t) => {
  fakeFetch(t, () => ({ body: { type: 'premium', expiration: END } }))
  const r = await runCheck('real_debrid', 'key', {})
  assert.equal(r.ok, true)
  assert.equal(r.message, 'Premium, expires Dec 31, 2026')
})

test('AllDebrid: premiumUntil becomes the end date; no premium fails', async (t) => {
  const seen = fakeFetch(t, (url) => url.includes('bad')
    ? { body: { status: 'error', error: { message: 'The auth apikey is invalid' } } }
    : { body: { status: 'success', data: { user: { isPremium: !url.includes('free'), premiumUntil: END_SECS } } } })
  const r = await runCheck('alldebrid', 'key', {})
  assert.equal(r.ok, true)
  assert.equal(r.message, 'Premium, expires Dec 31, 2026')
  assert.equal(r.expiresAt.getTime(), END_SECS * 1000)
  assert.equal(seen[0].auth, 'Bearer key')
  assert.match(seen[0].url, /^https:\/\/api\.alldebrid\.com\/v4\/user\?agent=/)
})

test('Premiumize: premium_until becomes the end date; false or past fails', async (t) => {
  let until = END_SECS
  const seen = fakeFetch(t, () => ({ body: { status: 'success', premium_until: until } }))
  const r = await runCheck('premiumize', 'a key/with?odd', {})
  assert.equal(r.ok, true)
  assert.equal(r.message, 'Premium, expires Dec 31, 2026')
  assert.match(seen[0].url, /apikey=a%20key%2Fwith%3Fodd$/)
  until = false
  assert.equal((await runCheck('premiumize', 'k', {})).ok, false)
  until = 1700000000
  assert.equal((await runCheck('premiumize', 'k', {})).ok, false)
})

test('Debrid-Link: premiumLeft seconds count forward from now', async (t) => {
  fakeFetch(t, () => ({ body: { success: true, value: { premiumLeft: 86400 * 10 } } }))
  const before = Date.now()
  const r = await runCheck('debrid_link', 'key', {})
  assert.equal(r.ok, true)
  assert.ok(Math.abs(r.expiresAt.getTime() - (before + 864e6)) < 5000)
  assert.match(r.message, /^Premium, expires [A-Z][a-z]{2} \d{1,2}, \d{4}$/)
})

test('TorBox usage carries the plan and its price for the cost offer', async (t) => {
  const { fetchDebridUsage } = require('../server/utils/debridUsage')
  fakeFetch(t, (url) => url.includes('/user/me')
    ? { body: { data: { plan: 2, premium_expires_at: END } } }
    : { body: { data: [{ download_finished: false }, { download_finished: true }] } })
  const u = await fetchDebridUsage('torbox', 'key')
  assert.deepEqual(u.plan, { name: 'Pro', monthlyUsd: 10 })
  assert.equal(u.activeDownloads, 1)
})

test('a rejected key fails plainly on each new service', async (t) => {
  fakeFetch(t, () => ({ status: 401, body: {} }))
  for (const type of ['alldebrid', 'premiumize', 'debrid_link']) {
    const r = await runCheck(type, 'key', {})
    assert.equal(r.ok, false)
    assert.match(r.message, /returned 401/)
  }
})
