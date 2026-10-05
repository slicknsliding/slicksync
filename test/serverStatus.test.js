// The Health page's Servers card (server/utils/serverStatus.js): one row per
// Jellyfin-compatible server, read from each person's last connection result.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { serverStatusList } = require('../server/utils/serverStatus')

const prismaWith = (people) => ({ user: { findMany: async () => people } })
const person = (id, name, server, error = null, at = null) => ({
  id, username: name, jellyfinServerUrl: `https://${server}.example.com`, jellyfinServerId: server, jellyfinServerKind: server.startsWith('aio') ? 'aiostreams' : 'jellyfin',
  providerConnectionError: error, providerConnectionErrorAt: at,
})

test('up, down and partly failing servers, each once', async () => {
  const t1 = new Date('2026-10-05T10:00:00Z')
  const t2 = new Date('2026-10-05T10:01:00Z')
  const rows = await serverStatusList(prismaWith([
    person('a', 'Ann', 'home'),
    person('b', 'Bo', 'home'),
    person('c', 'Cy', 'cabin', 'Connection issue: timeout', t2),
    person('d', 'Dee', 'cabin', 'Connection issue: timeout', t1),
    person('e', 'Eve', 'aio1'),
    person('f', 'Fay', 'aio1', 'Reconnect needed: 401', t1),
  ]), 'acc')
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(rows.length, 3)
  assert.equal(by.home.status, 'up')
  assert.equal(by.home.people.length, 2)
  assert.equal(by.cabin.status, 'down')
  assert.equal(by.cabin.since, t1.toISOString(), 'down since the first person noticed')
  assert.equal(by.aio1.status, 'partial')
  assert.equal(by.aio1.label, 'AIOStreams')
  assert.deepEqual(by.aio1.people.map((p) => p.state), ['ok', 'reconnect'])
  assert.equal(by.aio1.people[1].error, '401')
})

test('Health sends the servers and their outage alerts, and counts a server that is not up', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/routes/health.js'), 'utf8')
  assert.match(src, /serverStatusList\(prisma, accountId\)/)
  assert.match(src, /servers\.every\(\(s\) => s\.status === 'up'\)/)
  assert.match(src, /dedupeKey: \{ startsWith: 'connection-server-' \}/)
})
