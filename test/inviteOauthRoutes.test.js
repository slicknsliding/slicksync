// The two older invite routes that make a Stremio link code are for a signed-in
// admin of the household that owns the invitation. An invite code plus an
// accepted request's email and username used to be enough for a stranger to
// replace the stored link code.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const makeInvitationsRouter = require('../server/routes/invitations')

const realFetch = global.fetch

function fakePrisma() {
  const invitations = [{ id: 'inv1', accountId: 'acc1', inviteCode: 'CODE1', isActive: true }]
  const requests = [{ id: 'req1', invitationId: 'inv1', email: 'a@example.com', username: 'alice', status: 'accepted', oauthCode: 'OLD', oauthLink: null, oauthExpiresAt: null, createdAt: new Date() }]
  return {
    requests,
    invitation: { findUnique: async ({ where }) => invitations.find((i) => i.inviteCode === where.inviteCode) || null },
    inviteRequest: {
      findFirst: async ({ where }) => requests.find((r) => r.invitationId === where.invitationId && r.email === where.email && r.username === where.username && r.status === where.status) || null,
      update: async ({ where, data }) => { Object.assign(requests.find((r) => r.id === where.id), data); return {} },
      create: async ({ data }) => { const row = { id: 'new-request', ...data }; requests.push(row); return row },
    },
    user: { findFirst: async () => null },
  }
}

// `session` is what the request gate would have put on req.appAccountId.
async function serve(t, { session, ...options }) {
  const prisma = fakePrisma()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { if (session) req.appAccountId = session; next() })
  app.use('/invite', makeInvitationsRouter.createPublicRouter({ prisma, encrypt: (v) => v, decrypt: (v) => v, assignUserToGroup: async () => {}, ...options }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })

  let stremioCalls = 0
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://link.stremio.com/')) {
      stremioCalls++
      return { ok: true, status: 200, json: async () => ({ result: { success: true, code: 'NEWCODE', link: 'https://link.example.com/NEWCODE' } }) }
    }
    return realFetch(url, init)
  }
  t.after(() => { global.fetch = realFetch; server.close() })

  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (route, body) => {
    const res = await realFetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, body: json }
  }
  return { post, prisma, stremioCalls: () => stremioCalls }
}

const publicInstance = { INSTANCE_TYPE: 'public', PRIVATE_AUTH_ENABLED: false }
const accepted = { email: 'a@example.com', username: 'alice' }

test('a signed-out caller cannot make a link code for an invitation', async (t) => {
  const { post, prisma, stremioCalls } = await serve(t, { ...publicInstance })
  const res = await post('/invite/CODE1/generate-oauth', accepted)
  assert.equal(res.status, 401)
  assert.equal(stremioCalls(), 0)
  assert.equal(prisma.requests[0].oauthCode, 'OLD', 'the stored code is untouched')
})

test('a signed-out caller cannot make a bare link code either', async (t) => {
  const { post, stremioCalls } = await serve(t, { ...publicInstance })
  const res = await post('/invite/generate-oauth')
  assert.equal(res.status, 401)
  assert.equal(stremioCalls(), 0)
})

test('another household gets the same answer as for an invitation that does not exist', async (t) => {
  const { post, prisma, stremioCalls } = await serve(t, { ...publicInstance, session: 'acc2' })
  const other = await post('/invite/CODE1/generate-oauth', accepted)
  const missing = await post('/invite/NOPE/generate-oauth', accepted)
  assert.equal(other.status, 404)
  assert.deepEqual(other, missing)
  assert.equal(stremioCalls(), 0)
  assert.equal(prisma.requests[0].oauthCode, 'OLD')
})

test('the household that owns the invitation can make and store a link code', async (t) => {
  const { post, prisma } = await serve(t, { ...publicInstance, session: 'acc1' })
  const res = await post('/invite/CODE1/generate-oauth', accepted)
  assert.equal(res.status, 200)
  assert.equal(res.body.oauthCode, 'NEWCODE')
  assert.equal(prisma.requests[0].oauthCode, 'NEWCODE')

  const bare = await post('/invite/generate-oauth')
  assert.equal(bare.status, 200)
  assert.equal(bare.body.oauthCode, 'NEWCODE')
})

test('a household install with no login always counts as the owning household', async (t) => {
  const { post, prisma } = await serve(t, { INSTANCE_TYPE: 'private', PRIVATE_AUTH_ENABLED: false, DEFAULT_ACCOUNT_ID: 'acc1' })
  const res = await post('/invite/CODE1/generate-oauth', accepted)
  assert.equal(res.status, 200)
  assert.equal(prisma.requests[0].oauthCode, 'NEWCODE')
  assert.equal((await post('/invite/generate-oauth')).status, 200)
})

test('a household install that has a login still refuses a signed-out caller', async (t) => {
  const { post } = await serve(t, { INSTANCE_TYPE: 'private', PRIVATE_AUTH_ENABLED: true, DEFAULT_ACCOUNT_ID: 'acc1' })
  assert.equal((await post('/invite/CODE1/generate-oauth', accepted)).status, 401)
  assert.equal((await post('/invite/generate-oauth')).status, 401)
})

// Nuvio's poll status is opaque, as at sign-in: anything but 'pending' goes to
// the exchange, which is what proves approval. Only the upstream answers are
// faked, so the real Nuvio adapter maps the status and makes the exchange.
for (const providerStatus of ['pending', 'approved', 'authorized', 'expired']) {
  test(`a Nuvio invite sign-in that reports '${providerStatus}'`, async (t) => {
    const { post, prisma } = await serve(t, { ...publicInstance })
    let exchanges = 0
    const payload = Buffer.from(JSON.stringify({ email: 'viewer@example.com', sub: 'viewer' })).toString('base64url')
    global.fetch = async (url) => {
      if (String(url).endsWith('/rest/v1/rpc/poll_tv_login_session')) return Response.json([{ status: providerStatus }])
      if (String(url).endsWith('/functions/v1/tv-logins-exchange')) {
        exchanges++
        return Response.json({ access_token: `header.${payload}.signature`, refresh_token: 'test-refresh-token' })
      }
      throw new Error(`unexpected request to ${url}`)
    }
    const res = await post('/invite/CODE1/nuvio/poll', { anonToken: 'test-anon', code: 'test-code', deviceNonce: 'test-nonce' })
    assert.ok(!JSON.stringify(res.body).includes('test-refresh-token'))
    if (providerStatus === 'pending' || providerStatus === 'expired') {
      assert.deepEqual(res, { status: 200, body: { status: providerStatus } })
      assert.equal(exchanges, 0)
      return
    }
    assert.deepEqual(res, { status: 200, body: { status: 'authorized', email: 'viewer@example.com' } })
    assert.equal(exchanges, 1)
    const submitted = await post('/invite/CODE1/request', { nuvioCode: 'test-code', username: 'viewer' })
    assert.equal(submitted.status, 200)
    assert.equal(submitted.body.providerType, 'nuvio')
    assert.equal(submitted.body.email, 'viewer@example.com')
    assert.equal(submitted.body.nuvioRefreshToken, undefined)
    assert.equal(prisma.requests.at(-1).nuvioRefreshToken, 'test-refresh-token')
  })
}
