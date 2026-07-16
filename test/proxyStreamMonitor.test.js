const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDisplayName, writeCompletedWatchSessions } = require('../server/utils/proxyStreamMonitor')

test('parseDisplayName: null/empty input returns null', () => {
  assert.equal(parseDisplayName(null), null)
  assert.equal(parseDisplayName(''), null)
})

test('parseDisplayName: parenthesized year with trailing release tags (the "Send Help" regression)', () => {
  // Was previously mismatched to a different, wrong "Send Help" movie
  // because the parenthesized year broke title extraction, which then
  // broke year-based disambiguation downstream in attemptPosterLookup.
  assert.equal(parseDisplayName('Send.Help.(2026).VU.Blu-ray.mkv'), 'Send Help (2026)')
})

test('parseDisplayName: non-parenthesized year with trailing release tags', () => {
  assert.equal(parseDisplayName('Send.Help.2026.WEB-DL.mkv'), 'Send Help (2026)')
})

test('parseDisplayName: parenthesized year with nothing after it', () => {
  assert.equal(parseDisplayName('Movie.Title.(2020).mkv'), 'Movie Title (2020)')
})

test('parseDisplayName: strips a numeric-junk parenthetical that is not a year', () => {
  assert.equal(parseDisplayName('Some.Show.(1.23.45).2019.mkv'), 'Some Show (2019)')
})

test('parseDisplayName: no year present falls back to quality-tag stripping', () => {
  assert.equal(
    parseDisplayName('Show.Name.S01E01.1080p.WEBRip.x264.mkv'),
    'Show Name S01E01'
  )
})

test('parseDisplayName: no year and no recognized quality tag returns the cleaned filename', () => {
  assert.equal(parseDisplayName('Just.A.Title.mkv'), 'Just A Title')
})

// --- writeCompletedWatchSessions: proxy is a presence signal, never a duration source ---

function makeClosedRow(overrides = {}) {
  const start = new Date('2026-07-16T10:00:00Z')
  return {
    id: 'proxy-row-1',
    aiostreamsUser: 'alice',
    clientIp: '1.2.3.4',
    url: 'https://example.com/stream',
    displayName: 'The Rock (1996)',
    filename: 'The.Rock.1996.mkv',
    posterUrl: 'https://posters/rock.jpg',
    metadataItemId: 'tt0117500',
    metadataItemType: 'movie',
    startTime: start,
    requestCount: 8,
    ...overrides,
  }
}

// Records every write the function attempts, so we can assert what it did
// (and, crucially, did NOT do) without a real DB.
function makeMockPrisma() {
  const calls = { watchActivityCreate: 0, watchSessionUpsert: [], updateMany: 0 }
  return {
    calls,
    appAccount: { findFirst: async () => ({ sync: { accountTimezone: 'America/Los_Angeles' } }) },
    user: { findMany: async () => [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }] },
    watchSession: {
      findUnique: async () => null,
      upsert: async (args) => { calls.watchSessionUpsert.push(args); return { id: 'ws-1' } },
    },
    watchActivity: {
      create: async () => { calls.watchActivityCreate++; return {} },
    },
    proxyStreamSession: {
      updateMany: async () => { calls.updateMany++; return { count: 1 } },
    },
  }
}

test('writeCompletedWatchSessions: never writes WatchActivity (proxy time must not reach Watch Time Today)', async () => {
  const prisma = makeMockPrisma()
  // A connection that lingered "active" for 22 hours - the old bug would
  // have recorded 22h of watch time from this.
  const closed = [makeClosedRow()]
  const endTime = new Date('2026-07-17T08:00:00Z') // 22h after startTime

  await writeCompletedWatchSessions(prisma, 'acct-1', closed, endTime)

  assert.equal(prisma.calls.watchActivityCreate, 0, 'proxy pipeline must not write WatchActivity at all')
})

test('writeCompletedWatchSessions: stores the WatchSession with zero duration, not connection lifetime', async () => {
  const prisma = makeMockPrisma()
  const closed = [makeClosedRow()]
  const endTime = new Date('2026-07-17T08:00:00Z') // 22h lifetime

  await writeCompletedWatchSessions(prisma, 'acct-1', closed, endTime)

  assert.equal(prisma.calls.watchSessionUpsert.length, 1)
  const args = prisma.calls.watchSessionUpsert[0]
  assert.equal(args.create.durationSeconds, 0, 'created row must have zero duration')
  assert.equal(args.update.durationSeconds, undefined, 'update must not touch durationSeconds (never clobber a real native duration)')
})

test('writeCompletedWatchSessions: skips near-instant probe blips (<10s connection lifetime)', async () => {
  const prisma = makeMockPrisma()
  const start = new Date('2026-07-16T10:00:00Z')
  const closed = [makeClosedRow({ startTime: start })]
  const endTime = new Date(start.getTime() + 5 * 1000) // 5s lifetime

  await writeCompletedWatchSessions(prisma, 'acct-1', closed, endTime)

  assert.equal(prisma.calls.watchSessionUpsert.length, 0, 'a 5-second blip should not be recorded as history')
})
