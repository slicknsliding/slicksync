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
  ]), 'acc', { versions: async (rows) => rows })
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

test('each server’s version, and whether a newer stable one is out', async () => {
  const sv = require('../server/utils/serverVersions')
  sv.forgetForTests()
  const realFetch = global.fetch
  global.fetch = async (url) => {
    const u = String(url)
    const json = u.includes('api.github.com/repos/jellyfin/') ? [{ tag_name: 'v12.3-rc1', prerelease: true }, { tag_name: 'v12.2', prerelease: false }]
      : u.includes('api.github.com/repos/Viren070/') ? [{ tag_name: 'desktop-v0.10.1', prerelease: false }, { tag_name: 'v2.36.0', prerelease: false }]
      : u.startsWith('https://home.') ? { ServerName: 'home', Version: '12.2.0' }
      : u.startsWith('https://old.') ? { ServerName: 'old', Version: '10.10.7' }
      : { ServerName: 'AIOStreams', aiostreams: { version: { tag: 'v2.35.9', channel: 'nightly', commit: 'abc1234' } } }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => json, text: async () => JSON.stringify(json) }
  }
  try {
    const rows = await serverStatusList(prismaWith([person('a', 'Ann', 'home'), person('b', 'Bo', 'old'), person('c', 'Cy', 'aio1')]), 'acc')
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(by.home.version, '12.2.0')
    assert.equal(by.home.updateAvailable, false, 'on the newest stable')
    assert.equal(by.old.updateAvailable, true)
    assert.equal(by.old.latest, 'v12.2', 'a release candidate is not offered')
    assert.equal(by.aio1.channel, 'nightly')
    assert.equal(by.aio1.updateAvailable, false, 'a nightly is never called behind')
    assert.equal(by.aio1.latest, 'v2.36.0', 'the desktop app’s releases are skipped')
    assert.equal(rows.some((r) => 'url' in r), false, 'addresses stay on the server')
  } finally {
    global.fetch = realFetch
  }
})
