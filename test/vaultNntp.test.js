'use strict'
// The Usenet sign-in conversation (NNTP), driven with a scripted connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const { nntpConversation, nntpLogin } = require('../server/utils/vaultCheckers')

// A connection that answers each read with the next scripted line and records what was sent.
function scripted(replies) {
  const sent = []
  const queue = [...replies]
  return {
    sent,
    readLine: async () => { if (!queue.length) throw new Error('The server closed the connection'); return queue.shift() },
    writeLine: async (line) => { sent.push(line) },
  }
}

const creds = { host: 'news.example.com', username: 'sam-the-user', password: 'hunter2-secret' }
const noSecretsIn = (result) => {
  const text = JSON.stringify(result)
  assert.ok(!text.includes(creds.username) && !text.includes(creds.password), 'the result never carries the login')
}

test('accepted: greeting, user, password, then 281', async () => {
  const conn = scripted(['200 Welcome', '381 Password required', '281 Authentication accepted'])
  const r = await nntpConversation(conn, creds)
  assert.deepEqual(r, { ok: true, message: 'Signed in to news.example.com' })
  assert.deepEqual(conn.sent, ['AUTHINFO USER sam-the-user', 'AUTHINFO PASS hunter2-secret', 'QUIT'])
  noSecretsIn({ ...r, message: r.message })
})

test('a posting-allowed greeting (201) and an answer to the user name alone (281) also work', async () => {
  const conn = scripted(['201 No posting', '281 Welcome'])
  const r = await nntpConversation(conn, creds)
  assert.equal(r.ok, true)
  assert.deepEqual(conn.sent, ['AUTHINFO USER sam-the-user', 'QUIT'])
})

test('refused: 481, 482 and 502 after the password all read as a turned-down login', async () => {
  for (const code of ['481 Authentication failed', '482 Authentication rejected', '502 Access denied']) {
    const conn = scripted(['200 hi', '381 pw', code])
    const r = await nntpConversation(conn, creds)
    assert.deepEqual(r, { ok: false, message: 'The server turned the username or password down' }, code)
    assert.equal(conn.sent.at(-1), 'QUIT')
    noSecretsIn(r)
  }
})

test('a refused user name stops before the password is sent', async () => {
  const conn = scripted(['200 hi', '481 Unknown user'])
  const r = await nntpConversation(conn, creds)
  assert.equal(r.ok, false)
  assert.deepEqual(conn.sent, ['AUTHINFO USER sam-the-user', 'QUIT'])
})

test('busy: 400, or 502 talking about connections, is not a verdict on the login', async () => {
  const cases = [['400 Service temporarily unavailable'], ['502 Too many connections from your account'], ['200 hi', '381 pw', '502 Maximum connections reached']]
  for (const replies of cases) {
    const r = await nntpConversation(scripted(replies), creds)
    assert.deepEqual(r, { ok: null, transient: true, message: 'The server is busy; try again later' }, replies.join(' | '))
  }
})

test('something that is not a Usenet server, and a dropped connection', async () => {
  const r = await nntpConversation(scripted(['HTTP/1.1 400 Bad Request']), creds)
  assert.equal(r.ok, false)
  noSecretsIn(r)
  await assert.rejects(nntpConversation(scripted(['200 hi']), creds), /closed the connection/)
})

test('no username or password on file: there is no login to try', () => {
  assert.equal(nntpLogin('{"username":"","password":"x"}'), null)
  assert.equal(nntpLogin('just-a-key'), null)
  assert.equal(nntpLogin(''), null)
  assert.deepEqual(nntpLogin('{"username":"u","password":"p"}'), { username: 'u', password: 'p' })
})
