// A device someone else has the household's AIOStreams link on (real case,
// Nov 2026: a home connection in another state, for weeks). Its streams were
// shown as the login's own person - "NuvioSLICK started watching" - and each
// raised "streamed but not recorded, add the sign-in", for viewings no sign-in
// of theirs could ever record. An address is the household's once a stream
// from it lines up with one of their records (same title AND same time), or
// someone claimed it; otherwise, once it has streamed for a while, it is an
// unknown device. Addresses here are documentation ranges, people stand-ins.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const unknownDevices = require('../server/utils/unknownDevices')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')
const { checkWatchSyncMismatch } = require('../server/utils/watchSyncMismatch')

// Real field names only (both schemas): a misnamed field fails here, not in a silent catch.
const SCHEMAS = ['schema.sqlite.prisma', 'schema.postgres.prisma']
  .map((file) => fs.readFileSync(path.join(__dirname, '..', 'prisma', file), 'utf8'))
function fieldsOf(model) {
  const sets = SCHEMAS.map((schema) => {
    const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)
    assert.ok(body, `model ${model} is in every schema`)
    return new Set(body[1].split('\n').map((l) => /^\s+([A-Za-z]\w*)\s/.exec(l)?.[1]).filter(Boolean))
  })
  return new Set([...sets[0]].filter((f) => sets.every((s) => s.has(f))))
}

const NOW = Date.now()
const MIN = 60 * 1000
const ago = (m) => new Date(NOW - m * MIN)
const HOME = '198.51.100.10'
const STRANGER = '203.0.113.30'
const FRESH = '192.0.2.99'

const nuvio = { id: 'nuvio-1', username: 'Nuvio person', providerType: 'nuvio', email: 'household@example.com', colorIndex: 1 }
const stremio = { id: 'stremio-1', username: 'Stremio person', providerType: 'stremio', email: 'household@example.com', colorIndex: 2 }
const USERS = [nuvio, stremio]

const stream = (id, ip, name, itemId, startMinsAgo, lengthMins, extra = {}) => ({
  id, accountId: 'acc', aiostreamsUser: 'household', clientIp: ip, url: `https://debrid.example/${id}`,
  filename: `${name}.mkv`, displayName: name, metadataName: name, metadataItemId: itemId, metadataItemType: 'movie', posterUrl: null,
  startTime: ago(startMinsAgo), lastSeenAt: ago(startMinsAgo - lengthMins), updatedAt: ago(startMinsAgo - lengthMins),
  endTime: ago(startMinsAgo - lengthMins), isActive: false, requestCount: 40, ...extra,
})
const record = (userId, itemId, itemName, atMinsAgo) => ({
  accountId: 'acc', userId, itemId, itemName, itemType: 'movie', videoId: itemId,
  startTime: ago(atMinsAgo), endTime: ago(atMinsAgo), updatedAt: ago(atMinsAgo), isActive: false, lastPosition: 600000, totalDuration: 6000000,
})

// Home watched Film A three days ago and the Nuvio profile recorded it then.
// The stranger played Film B two days ago - the Nuvio profile watched the same
// film 40 minutes after the stranger's stream ended, which is NOT that stream.
function household(overrides = {}) {
  return {
    streams: [
      stream('h1', HOME, 'Film A', 'tt0000001', 3 * 1440, 60),
      stream('s1', STRANGER, 'Film B', 'tt0000002', 2 * 1440, 30),
      ...(overrides.extraStreams || []),
    ],
    sessions: [
      record(nuvio.id, 'tt0000001', 'Film A', 3 * 1440 - 30),
      record(nuvio.id, 'tt0000002', 'Film B', 2 * 1440 - 70),
      ...(overrides.extraSessions || []),
    ],
    claims: overrides.claims || [],
  }
}

function matches(row, where) {
  for (const [k, v] of Object.entries(where || {})) {
    if (k === 'OR') { if (!v.some((w) => matches(row, w))) return false; continue }
    if (k === 'NOT') { if (matches(row, v)) return false; continue }
    const x = row[k]
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !v.in.includes(x)) return false
      if ('gte' in v && !(x != null && x >= v.gte)) return false
      if ('lte' in v && !(x != null && x <= v.lte)) return false
      if ('not' in v && x === v.not) return false
      continue
    }
    if (x !== v) return false
  }
  return true
}

function fakePrisma(data) {
  const problems = []
  const raised = []
  const notifications = []
  function table(model, rows) {
    const fields = fieldsOf(model)
    const check = (where, select) => {
      const keys = [...Object.keys(select || {}), ...Object.keys(where || {}).filter((k) => k !== 'OR' && k !== 'NOT'),
        ...((where && where.OR) || []).flatMap((w) => Object.keys(w))]
      for (const key of keys) if (!fields.has(key)) problems.push(`${model}.${key} is not in the schema`)
    }
    const pick = (select) => (r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])) : r)
    const sorted = (list, orderBy) => {
      if (!orderBy) return list
      const [[k, dir]] = Object.entries(orderBy)
      return [...list].sort((a, b) => (dir === 'asc' ? a[k] - b[k] : b[k] - a[k]))
    }
    return {
      findMany: async ({ where = {}, select, orderBy, take } = {}) => {
        check(where, select)
        const out = sorted(rows.filter((r) => matches(r, where)), orderBy).map(pick(select))
        return typeof take === 'number' ? out.slice(0, take) : out
      },
      findFirst: async ({ where = {}, select, orderBy } = {}) => {
        check(where, select)
        const out = sorted(rows.filter((r) => matches(r, where)), orderBy).map(pick(select))
        return out[0] || null
      },
      findUnique: async ({ where, select }) => pick(select)(rows.find((r) => r.id === where.id)) || null,
    }
  }
  const prisma = {
    proxyStreamSession: table('ProxyStreamSession', data.streams),
    watchSession: table('WatchSession', data.sessions),
    movieWatchHistory: table('MovieWatchHistory', []),
    episodeWatchHistory: table('EpisodeWatchHistory', []),
    proxyDeviceClaim: table('ProxyDeviceClaim', data.claims),
    proxyUserIpAffinity: { findMany: async () => [], upsert: async () => ({}) },
    dismissedContinueWatching: { findFirst: async () => null },
    notification: {
      findMany: async ({ where }) => notifications.filter((n) => n.accountId === where.accountId && n.type === where.type),
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ create }) => { raised.push(create); notifications.push(create); return create },
    },
  }
  return { prisma, problems, raised }
}

test.beforeEach(() => unknownDevices._resetForTests())

test('a stream that lined up with their own record makes an address theirs; a title watched later the same day does not', async () => {
  const db = fakePrisma(household())
  const found = await unknownDevices.unknownAddresses(db.prisma, 'acc', [HOME, STRANGER])
  assert.deepEqual([...found.keys()], [STRANGER])
  const info = found.get(STRANGER)
  assert.equal(info.address, STRANGER)
  assert.equal(info.titles, 1)
  assert.equal(info.firstSeen, ago(2 * 1440).toISOString())
  assert.deepEqual(db.problems, [])
})

test('a record that lands at the stream\'s pause, just after its last request, counts', async () => {
  const db = fakePrisma(household({ extraSessions: [record(nuvio.id, 'tt0000002', 'Film B', 2 * 1440 - 40)] }))
  const found = await unknownDevices.unknownAddresses(db.prisma, 'acc', [STRANGER])
  assert.equal(found.size, 0, 'recorded 10 minutes after its last request: that stream was theirs')
})

test('a new address is given time before it can be called unknown (a home whose address changed)', async () => {
  const db = fakePrisma(household({ extraStreams: [stream('n1', FRESH, 'Film D', 'tt0000004', 60, 30)] }))
  const found = await unknownDevices.unknownAddresses(db.prisma, 'acc', [FRESH, STRANGER])
  assert.deepEqual([...found.keys()], [STRANGER])
})

test('a claim for a person, or "It\'s fine, don\'t ask again" (a claim with no one), makes it known', async () => {
  for (const userId of [nuvio.id, '']) {
    unknownDevices._resetForTests()
    const db = fakePrisma(household({ claims: [{ accountId: 'acc', clientIp: STRANGER, userId }] }))
    const found = await unknownDevices.unknownAddresses(db.prisma, 'acc', [STRANGER])
    assert.equal(found.size, 0, `claimed for "${userId}"`)
  }
})

test('the server itself, the home network and a private tunnel are never an unknown device', async () => {
  const internal = ['127.0.0.1', '192.168.1.20', '10.0.0.5', '172.18.0.3', '100.100.1.2', '::1', 'fd12:3456::1']
  // Home streams most, as a real home does (the household check starts from the busiest addresses).
  const moreHome = [1, 2, 3].map((n) => stream(`hm${n}`, HOME, `Home ${n}`, `tt20000${n}`, n * 1440, 30))
  const db = fakePrisma(household({ extraStreams: [...moreHome, ...internal.map((ip, i) => stream(`i${i}`, ip, `Inside ${i}`, `tt10000${i}`, 2 * 1440, 30))] }))
  const found = await unknownDevices.unknownAddresses(db.prisma, 'acc', [...internal, STRANGER])
  assert.deepEqual([...found.keys()], [STRANGER])
})

test('with nothing of theirs known yet (a new install), no address is called unknown', async () => {
  const data = household()
  data.sessions = data.sessions.filter((s) => s.itemId !== 'tt0000001')
  const found = await unknownDevices.unknownAddresses(fakePrisma(data).prisma, 'acc', [STRANGER])
  assert.equal(found.size, 0)
})

test('Now Playing: the stranger\'s stream is its own "Unknown device" card, not the login\'s person', async () => {
  const live = stream('s2', STRANGER, 'Film C', 'tt0000003', 10, 0, { isActive: true, endTime: null, lastSeenAt: ago(0.2), updatedAt: ago(0.1) })
  const home = stream('h2', HOME, 'Film E', 'tt0000005', 20, 0, { isActive: true, endTime: null, lastSeenAt: ago(0.2), updatedAt: ago(0.1) })
  const db = fakePrisma(household({ extraStreams: [live, home] }))
  const result = await mergeProxyNowPlaying(db.prisma, 'acc', USERS, [], { isConfirming: () => true })
  const stranger = result.find((r) => r.item.id === 'tt0000003')
  assert.ok(stranger, 'the stranger\'s stream has a card')
  assert.equal(stranger.user.username, 'Unknown device')
  assert.equal(stranger.user.id, `unknown-device:${STRANGER}`)
  assert.equal(stranger.unknownDevice.address, STRANGER)
  assert.equal(stranger.unknownDevice.titles, 2)
  const own = result.find((r) => r.item.id === 'tt0000005')
  assert.ok(own && [nuvio.id, stremio.id].includes(own.user.id), 'the home stream still goes to one of their people')
  assert.equal(own.unknownDevice, undefined)
  assert.deepEqual(db.problems, [])
})

test('Now Playing: a stranger\'s connection beside a home one for the same viewing is not unknown', async () => {
  const a = stream('h3', HOME, 'Film F', 'tt0000006', 15, 0, { isActive: true, endTime: null, lastSeenAt: ago(5), updatedAt: ago(0.1) })
  const b = stream('s3', STRANGER, 'Film F', 'tt0000006', 15, 0, { isActive: true, endTime: null, lastSeenAt: ago(0.2), updatedAt: ago(0.1) })
  const db = fakePrisma(household({ extraStreams: [a, b] }))
  const result = await mergeProxyNowPlaying(db.prisma, 'acc', USERS, [], { isConfirming: () => true })
  const card = result.find((r) => r.item.id === 'tt0000006')
  assert.ok(card)
  assert.equal(card.unknownDevice, undefined)
})

test('not-recorded alerts: none for a title only the stranger streamed, still one for the household\'s own', async () => {
  const strangers = stream('s4', STRANGER, 'Film G', 'tt0000007', 300, 60)
  const ours = stream('h4', HOME, 'Film H', 'tt0000008', 300, 60)
  const db = fakePrisma(household({ extraStreams: [strangers, ours] }))
  await checkWatchSyncMismatch(db.prisma, 'acc', USERS)
  assert.deepEqual(db.raised.map((n) => n.title), ['Film H was streamed but not recorded'])
  assert.deepEqual(db.problems, [])
})
