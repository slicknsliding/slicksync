// A stream named only by an opaque id, before the app has said what it is:
// the same file as an earlier named stream is that title for certain, and
// otherwise the person's latest unfinished title is shown as a guess until
// the app's first checkpoint.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeProxyNowPlaying, guessResumedTitle } = require('../server/utils/proxyNowPlaying')
const { TITLE_PENDING_NAME } = require('../server/utils/proxyTitle')

const START = new Date('2026-11-08T03:01:33Z')
const MIN = 60 * 1000
const opaque = (overrides = {}) => ({
  id: 'live', aiostreamsUser: 'alice', url: 'usenet:929e9b3388ffb48a0a9cd27843d713d0b5a1fcb8:1:',
  filename: '375b77f941fe3f914778fade39533f27.mkv', displayName: '375b77f941fe3f914778fade39533f27',
  posterUrl: null, metadataName: null, metadataItemId: null, metadataItemType: null, isActive: true,
  startTime: START, lastSeenAt: new Date(START.getTime() + 10 * MIN), updatedAt: new Date(START.getTime() + 10 * MIN),
  ...overrides,
})
const session = (overrides = {}) => ({
  accountId: 'acct', userId: 'user-1', itemId: 'tt32358390', itemName: 'The Cycle', itemType: 'movie',
  videoId: null, season: null, episode: null, poster: 'https://posters/the-cycle.jpg',
  lastPosition: 30 * MIN, totalDuration: 112 * MIN, updatedAt: new Date(START.getTime() - 26 * 60 * MIN),
  ...overrides,
})

// Enough of Prisma for these paths: active rows, recently closed rows, the
// same-file lookup, checkpoints and dismissals.
function fakePrisma({ earlierRows = [], sessions = [], dismissed = [] } = {}, active = [opaque()]) {
  let calls = 0
  return {
    proxyStreamSession: {
      findMany: async ({ where }) => {
        if (where.url) return earlierRows.filter((r) => where.url.in.includes(r.url))
        return calls++ === 0 ? active : []
      },
    },
    watchSession: {
      findMany: async ({ where }) => sessions
        .filter((s) => s.userId === where.userId && s.lastPosition >= where.lastPosition.gte && s.totalDuration != null &&
          s.updatedAt >= where.updatedAt.gte && (!where.updatedAt.lte || s.updatedAt <= where.updatedAt.lte))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    },
    dismissedContinueWatching: { findFirst: async ({ where }) => dismissed.find((d) => d.userId === where.userId && d.showId === where.showId) || null },
  }
}
const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
const merge = (db, natives = [], active) => mergeProxyNowPlaying(fakePrisma(db, active), 'acct', users, natives, { isConfirming: () => true })

test('while it plays, the unfinished title from before the stream is shown as a guess, its position counted on', async () => {
  const [card] = await merge({ sessions: [session()] })
  assert.equal(card.item.name, 'The Cycle')
  assert.equal(card.item.guessed, true)
  assert.equal(card.item.poster, 'https://posters/the-cycle.jpg')
  assert.equal(card.item.titlePending, undefined)
  assert.equal(card.lastPosition, 30 * MIN)
  assert.equal(card.totalDuration, 112 * MIN)
  assert.equal(card.positionAt, START.getTime(), 'counts on from when this stream began')
  assert.equal(card.positionEstimated, true)
})

test('the app\'s own checkpoint, once it comes, replaces the guess', async () => {
  const fromApp = {
    user: { id: 'user-1', username: 'alice' }, item: { id: 'tt32358390', name: 'The Cycle', type: 'movie' },
    videoId: null, watchedAtTimestamp: START.getTime() + 14 * MIN, reportedAtTimestamp: START.getTime() + 14 * MIN,
    lastPosition: 44 * MIN, totalDuration: 112 * MIN,
  }
  const [card] = await merge({ sessions: [session()] }, [fromApp])
  assert.equal(card.item.guessed, undefined)
  assert.equal(card.lastPosition, 44 * MIN)
})

test('no guess: nothing unfinished, finished titles, too old, or someone else\'s', async () => {
  const none = await merge({ sessions: [] })
  assert.equal(none[0].item.name, TITLE_PENDING_NAME)
  const finished = await merge({ sessions: [session({ lastPosition: 110 * MIN })] })
  assert.equal(finished[0].item.titlePending, true)
  const barelyStarted = await merge({ sessions: [session({ lastPosition: 1 * MIN })] })
  assert.equal(barelyStarted[0].item.titlePending, true)
  const old = await merge({ sessions: [session({ updatedAt: new Date(START.getTime() - 15 * 24 * 60 * MIN) })] })
  assert.equal(old[0].item.titlePending, true)
  const someoneElse = await merge({ sessions: [session({ userId: 'user-2' })] })
  assert.equal(someoneElse[0].item.titlePending, true)
})

test('no guess when two unfinished titles were left within minutes of each other, or it was dismissed', async () => {
  const tie = await merge({ sessions: [session(), session({ itemId: 'tt1', itemName: 'Other Film', updatedAt: new Date(START.getTime() - 26 * 60 * MIN - 5 * MIN) })] })
  assert.equal(tie[0].item.titlePending, true)
  const apart = await merge({ sessions: [session(), session({ itemId: 'tt1', itemName: 'Other Film', updatedAt: new Date(START.getTime() - 9 * 24 * 60 * MIN) })] })
  assert.equal(apart[0].item.name, 'The Cycle')
  const dismissed = await merge({ sessions: [session()], dismissed: [{ userId: 'user-1', showId: 'tt32358390' }] })
  assert.equal(dismissed[0].item.titlePending, true)
})

test('a series guess carries its episode', async () => {
  const g = await guessResumedTitle(fakePrisma({ sessions: [session({ itemId: 'tt39469996', itemName: 'Newlyweds', itemType: 'series', videoId: 'tt39469996:1:3', season: 1, episode: 3, lastPosition: 8 * MIN, totalDuration: 22 * MIN })] }), 'acct', 'user-1', START)
  assert.equal(g.item.season, 1)
  assert.equal(g.item.episode, 3)
  assert.equal(g.videoId, 'tt39469996:1:3')
})

test('the same file as an earlier named stream is that title, for certain', async () => {
  const earlier = { id: 'old', url: opaque().url, filename: 'The Cycle 2026 1080p AMZN WEB-DL.mkv', displayName: 'The Cycle (2026)', posterUrl: 'https://posters/proxy.jpg', metadataItemId: 'tt32358390', metadataItemType: 'movie', metadataName: 'The Cycle' }
  const [card] = await merge({ earlierRows: [earlier], sessions: [session({ itemId: 'tt1', itemName: 'Other Film' })] })
  assert.equal(card.item.id, 'tt32358390')
  assert.match(card.item.name, /The Cycle/)
  assert.equal(card.item.guessed, undefined, 'certain, not a guess')
  assert.equal(card.item.titlePending, undefined)
})

test('an earlier row of the same file that was also unnamed gives nothing', async () => {
  const earlierOpaque = { id: 'old', url: opaque().url, filename: '375b77f941fe3f914778fade39533f27.mkv', displayName: '375b77f941fe3f914778fade39533f27', posterUrl: null, metadataItemId: null, metadataItemType: null, metadataName: null }
  const [card] = await merge({ earlierRows: [earlierOpaque] })
  assert.equal(card.item.titlePending, true)
})

// A real case: the stream was resumed, paused on the TV, and Nuvio saved the
// spot. That save is after the stream began; the title must stay, not turn
// into "Title not known yet" once the app's own entry goes quiet.
test('a checkpoint saved while the stream is open (a pause) keeps the title', async () => {
  const paused = session({ itemId: 'tt35538033', itemName: 'Resident Evil', lastPosition: 46 * MIN, totalDuration: 93 * MIN, updatedAt: new Date(START.getTime() + 46 * MIN) })
  const [card] = await merge({ sessions: [paused] })
  assert.equal(card.item.name, 'Resident Evil')
  assert.equal(card.item.guessed, true)
  assert.equal(card.lastPosition, 46 * MIN)
  assert.equal(card.positionAt, START.getTime() + 46 * MIN, 'counts on from the save, not from the stream start')
})
