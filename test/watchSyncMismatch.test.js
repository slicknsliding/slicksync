// The "Playback not being tracked" warning (server/utils/watchSyncMismatch.js)
// never fired from the day it was written: it asked episode history for an
// itemName field that model doesn't have (episodes are named by showName), the
// query threw, and the check gave up on every pass. The fake database here
// refuses any field the real schema lacks, so a misnamed field fails a test
// instead of a silent catch.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { checkWatchSyncMismatch } = require('../server/utils/watchSyncMismatch')

// Field names per model, read from the real schema.
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
function fieldsOf(model) {
  const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)
  assert.ok(body, `model ${model} is in the schema`)
  return new Set(body[1].split('\n').map((l) => /^\s+([A-Za-z]\w*)\s/.exec(l)?.[1]).filter(Boolean))
}

const NOW = Date.now()
const ago = (mins) => new Date(NOW - mins * 60000)

function fakePrisma(data) {
  const problems = []
  const notifications = [...(data.notifications || [])]
  const raised = []
  function table(model, rows) {
    const fields = fieldsOf(model)
    return {
      findMany: async ({ where = {}, select } = {}) => {
        for (const key of Object.keys(select || {})) {
          if (!fields.has(key)) problems.push(`${model}.${key} is not in the schema`)
        }
        return rows
          .filter((r) => Object.entries(where).every(([k, v]) => (v && v.gte ? r[k] >= v.gte : r[k] === v)))
          .map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])) : r))
      },
    }
  }
  const prisma = {
    proxyStreamSession: table('ProxyStreamSession', data.streams || []),
    movieWatchHistory: table('MovieWatchHistory', data.movies || []),
    episodeWatchHistory: table('EpisodeWatchHistory', data.episodes || []),
    watchSession: table('WatchSession', data.sessions || []),
    notification: {
      findMany: async ({ where }) => notifications.filter((n) => n.accountId === where.accountId && n.type === where.type),
      deleteMany: async ({ where }) => {
        for (const id of where.id.in) notifications.splice(notifications.findIndex((n) => n.id === id), 1)
      },
      upsert: async ({ where, create }) => {
        raised.push(create)
        const row = { id: `n${notifications.length + 1}`, ...create, dedupeKey: where.accountId_dedupeKey.dedupeKey }
        notifications.push(row)
        return row
      },
    },
  }
  return { prisma, problems, notifications, raised }
}

// A connection that carried data for an hour, ending `endedMinsAgo` ago.
const stream = (displayName, metadataItemId, endedMinsAgo = 60) => ({
  accountId: 'acc', displayName, metadataItemId,
  startTime: ago(endedMinsAgo + 60), lastSeenAt: ago(endedMinsAgo), requestCount: 4,
})

test('every field the check reads exists in the schema', async () => {
  const db = fakePrisma({
    streams: [stream('Carrie S01E05 PHYSICAL EDUCATION', 'tt11540908')],
    movies: [{ accountId: 'acc', itemName: 'Kingpin', itemId: 'tt0116778', watchedAt: ago(30) }],
    episodes: [{ accountId: 'acc', showName: 'Phony', showId: 'tt21952924:1:5', watchedAt: ago(30) }],
    sessions: [{ accountId: 'acc', itemName: 'Kingpin', itemId: 'tt0116778', startTime: ago(30) }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.deepEqual(db.problems, [])
})

test('a played show no connected account recorded raises one warning', async () => {
  const db = fakePrisma({ streams: [stream('Carrie S01E05 PHYSICAL EDUCATION', 'tt11540908'), stream('Carrie S01E06', 'tt11540908', 40)] })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 1, 'two episodes of one show are one warning')
  assert.equal(db.raised[0].type, 'mismatch')
  assert.match(db.raised[0].body, /Carrie/)
})

test('an episode recorded under the show name counts as tracked', async () => {
  const db = fakePrisma({
    streams: [stream('Carrie S01E05 PHYSICAL EDUCATION', 'tt11540908')],
    episodes: [{ accountId: 'acc', showName: 'Carrie', showId: 'tt11540908:1:5', watchedAt: ago(30) }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 0)
})

test('a title saved under its id only still counts as tracked', async () => {
  const db = fakePrisma({
    streams: [stream('Resident Evil (2026)', 'tt35538033')],
    movies: [{ accountId: 'acc', itemName: 'tt35538033', itemId: 'tt35538033', watchedAt: ago(30) }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 0)
})

test('a stream that ended within the last half hour is left to settle', async () => {
  const db = fakePrisma({ streams: [stream('Carrie S01E05', 'tt11540908', 10)] })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 0)
})

test("another account's recording does not cover this one", async () => {
  const db = fakePrisma({
    streams: [stream('Carrie S01E05', 'tt11540908')],
    episodes: [{ accountId: 'other', showName: 'Carrie', showId: 'tt11540908:1:5', watchedAt: ago(30) }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 1)
})

test('a standing warning is not raised again on the next pass', async () => {
  const db = fakePrisma({
    streams: [stream('Carrie S01E05', 'tt11540908')],
    notifications: [{ id: 'n0', accountId: 'acc', type: 'mismatch', dedupeKey: 'untracked-carrie' }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.raised.length, 0)
  assert.equal(db.notifications.length, 1, 'and it stays standing')
})

test('a warning goes away once the show is recorded', async () => {
  const db = fakePrisma({
    streams: [stream('Carrie S01E05', 'tt11540908')],
    episodes: [{ accountId: 'acc', showName: 'Carrie', showId: 'tt11540908:1:5', watchedAt: ago(5) }],
    notifications: [{ id: 'n0', accountId: 'acc', type: 'mismatch', dedupeKey: 'untracked-carrie' }],
  })
  await checkWatchSyncMismatch(db.prisma, 'acc', [])
  assert.equal(db.notifications.length, 0)
})
