const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const { isAllowedPushEndpoint } = require('../server/utils/pushNotifications')
const makePushRouter = require('../server/routes/push')

test('only browser push services are accepted', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://eu.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://par02p.notify.windows.com/w/?token=abc',
  ]) assert.equal(isAllowedPushEndpoint(ok), true, ok)
  for (const bad of [
    'http://fcm.googleapis.com/x', 'https://push.example.com/a', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x',
    'https://notify.windows.com/x', 'https://evil.example/.notify.windows.com', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', '', null, 'nonsense',
  ]) assert.equal(isAllowedPushEndpoint(bad), false, String(bad))
})

async function start(t, rows) {
  const prisma = {
    pushSubscription: {
      findUnique: async ({ where }) => rows.find((r) => r.endpoint === where.endpoint) || null,
      upsert: async ({ where, create, update }) => {
        const r = rows.find((x) => x.endpoint === where.endpoint)
        if (r) Object.assign(r, update); else rows.push({ ...create })
      },
      deleteMany: async ({ where }) => {
        for (let i = rows.length - 1; i >= 0; i--) if (Object.entries(where).every(([k, v]) => rows[i][k] === v)) rows.splice(i, 1)
      },
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/push', makePushRouter({ prisma, getAccountId: (req) => req.get('x-account') }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/push`
  return (path, account, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-account': account }, body: JSON.stringify(body) })
}

const EP = 'https://fcm.googleapis.com/fcm/send/device-1'
const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' } })

test('subscribe refuses an unknown push host and another account\'s endpoint', async (t) => {
  const rows = [{ accountId: 'A', endpoint: EP, p256dh: 'old', auth: 'old' }]
  const post = await start(t, rows)
  assert.equal((await post('/subscribe', 'B', sub('https://push.example.com/x'))).status, 400)
  assert.equal((await post('/subscribe', 'B', sub(EP))).status, 409)
  assert.deepEqual(rows, [{ accountId: 'A', endpoint: EP, p256dh: 'old', auth: 'old' }])
  assert.equal((await post('/subscribe', 'A', sub(EP))).status, 200)
  assert.equal(rows[0].p256dh, 'k')
  assert.equal(rows[0].accountId, 'A')
})

test('unsubscribe only removes the caller\'s own endpoint', async (t) => {
  const rows = [{ accountId: 'A', endpoint: EP }]
  const post = await start(t, rows)
  await post('/unsubscribe', 'B', { endpoint: EP })
  assert.equal(rows.length, 1)
  await post('/unsubscribe', 'A', { endpoint: EP })
  assert.equal(rows.length, 0)
})
