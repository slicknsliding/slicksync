// Reading pause and play from Stremio's saves to the account, with no addon.
// The times and positions in the first tests are a real viewing, read every
// 15 seconds on 2026-11-02 (server/utils/stremioSaves.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const saves = require('../server/utils/stremioSaves')
const ownWrites = require('../server/utils/ownWrites')
const { stremioSaveFields, stremioSaveCards } = require('../server/utils/metricsBuilder')
const { processUserSessions } = require('../server/utils/sessionTracker')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')

const DURATION = 1395000 // 23:15
const VIDEO = 'tt0096697:1:1'
const OPENED = '2026-11-02T21:43:55.843Z'
const at = (iso) => Date.parse(iso)
const item = (mtime, timeOffset, extra = {}) => ({
  _id: 'tt0096697', name: 'The Simpsons', type: 'series', _mtime: mtime,
  state: { timeOffset, duration: DURATION, video_id: VIDEO, lastWatched: OPENED, ...extra },
})
const read = (mtime, offset, secondsLater = 8) => saves.observe('u1', 'tt0096697', item(mtime, offset), at(mtime) + secondsLater * 1000)
const now = (mtime, secondsLater = 8) => saves.viewing('u1', 'tt0096697', VIDEO, at(mtime) + secondsLater * 1000)

test('the measured viewing: pause, play, the timer, then the end', () => {
  saves.forget()
  assert.equal(read('2026-11-02T22:48:23.126Z', 1195027), false, 'a first sight is not a save')
  assert.equal(now('2026-11-02T22:48:23.126Z'), null, 'and says nothing yet')

  assert.equal(read('2026-11-02T22:52:43.287Z', 1195194), true)
  assert.equal(now('2026-11-02T22:52:43.287Z').paused, false, 'pressing play')

  read('2026-11-02T22:54:13.288Z', 1284658)
  assert.equal(now('2026-11-02T22:54:13.288Z').paused, false, 'the timer')
  read('2026-11-02T22:55:43.289Z', 1374623)
  const playing = now('2026-11-02T22:55:43.289Z')
  assert.equal(playing.paused, false)
  assert.equal(playing.positionMs, 1374623)

  read('2026-11-02T22:56:03.928Z', 0)
  assert.equal(now('2026-11-02T22:56:03.928Z').ended, true, 'back to 0 from the end')
})

test('a save sooner than the timer, with the position moving as normal, is a pause', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 795211)
  read('2026-11-02T21:46:30.000Z', 885211)
  read('2026-11-02T21:47:00.000Z', 915300)
  const paused = now('2026-11-02T21:47:00.000Z')
  assert.equal(paused.paused, true)
  assert.equal(paused.positionMs, 915300, 'at the exact spot')

  read('2026-11-02T21:49:00.000Z', 915700)
  assert.equal(now('2026-11-02T21:49:00.000Z').paused, false, 'pressing play moves it under a second')
})

test('a slower timer is not a pause, and going quiet past it is', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  read('2026-11-02T21:48:00.000Z', 280000)
  read('2026-11-02T21:51:00.000Z', 460000)
  assert.equal(now('2026-11-02T21:51:00.000Z', 150).paused, false, 'inside the timer')

  // Read again later, nothing new.
  saves.observe('u1', 'tt0096697', item('2026-11-02T21:51:00.000Z', 460000), at('2026-11-02T21:51:00.000Z') + 210000)
  assert.equal(now('2026-11-02T21:51:00.000Z', 210).paused, true, 'quiet past any timer')
})

test('an app with a shorter timer learns it after one wrong pause', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  read('2026-11-02T21:45:30.000Z', 130000)
  assert.equal(now('2026-11-02T21:45:30.000Z').paused, true)
  read('2026-11-02T21:46:00.000Z', 160000)
  assert.equal(now('2026-11-02T21:46:00.000Z').paused, false, 'it played on with no press of play')
  read('2026-11-02T21:46:30.000Z', 190000)
  assert.equal(now('2026-11-02T21:46:30.000Z').paused, false, 'so that is its timer')
})

test('an app that never showed a timer is not called paused for going quiet', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  read('2026-11-02T21:45:05.000Z', 100300)
  saves.observe('u1', 'tt0096697', item('2026-11-02T21:45:05.000Z', 100300), at('2026-11-02T21:45:05.000Z') + 600000)
  assert.equal(now('2026-11-02T21:45:05.000Z', 600).paused, false)
})

test('a library edit moves _mtime but is not a save', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  assert.equal(read('2026-11-02T21:45:30.000Z', 100000), false)
  assert.equal(saves.lastSaveAt('u1', 'tt0096697', at('2026-11-02T21:46:00.000Z')), null)
})

test('back to 0 is the end even when the last save was short of the credits', () => {
  // 2026-11-03: S1E2 saved at 17:11, closed past the credits a little over
  // three minutes later, and the last save before that was at about 84%.
  saves.forget()
  read('2026-11-03T00:20:49.000Z', 1031948)
  read('2026-11-03T00:22:19.000Z', 1121948)
  read('2026-11-03T00:24:05.938Z', 0)
  const ended = now('2026-11-03T00:24:05.938Z')
  assert.equal(ended.ended, true)
  assert.equal(ended.paused, false)

  read('2026-11-03T03:00:00.000Z', 90000)
  assert.equal(now('2026-11-03T03:00:00.000Z').ended, false, 'playing it again')
})

test('the next episode starts fresh, and the old episode is not described', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  saves.observe('u1', 'tt0096697', item('2026-11-02T21:45:30.000Z', 1000, { video_id: 'tt0096697:1:2' }), at('2026-11-02T21:45:38.000Z'))
  const when = at('2026-11-02T21:45:40.000Z')
  assert.equal(saves.viewing('u1', 'tt0096697', VIDEO, when), null)
  assert.equal(saves.viewing('u1', 'tt0096697', 'tt0096697:1:2', when).paused, false)
})

test('an episode that ends moves on to the next at 0, and nobody is watching that yet', () => {
  saves.forget()
  const next = 'tt0096697:1:2'
  read('2026-11-02T22:54:13.288Z', 1284658)
  read('2026-11-02T22:55:43.289Z', 1374623)
  saves.observe('u1', 'tt0096697', item('2026-11-02T22:56:03.928Z', 0), at('2026-11-02T22:56:10.000Z'))
  saves.observe('u1', 'tt0096697', item('2026-11-02T22:56:13.978Z', 0, { video_id: next }), at('2026-11-02T22:56:25.000Z'))
  assert.equal(saves.viewing('u1', 'tt0096697', next, at('2026-11-02T22:56:30.000Z')).ended, true)

  saves.observe('u1', 'tt0096697', item('2026-11-02T22:56:40.000Z', 20000, { video_id: next }), at('2026-11-02T22:56:45.000Z'))
  const playing = saves.viewing('u1', 'tt0096697', next, at('2026-11-02T22:56:50.000Z'))
  assert.equal(playing.ended, false, 'until it really plays')
  assert.equal(playing.paused, false)
})

test('a device clock that is far off is not used for times', () => {
  saves.forget()
  read('2026-11-02T21:45:00.000Z', 100000)
  saves.observe('u1', 'tt0096697', item('2026-11-02T18:00:00.000Z', 190000), at('2026-11-02T21:46:30.000Z'))
  assert.equal(saves.lastSaveAt('u1', 'tt0096697', at('2026-11-02T21:46:40.000Z')), at('2026-11-02T21:46:30.000Z'))
})

test('whole libraries of old titles are not remembered', () => {
  saves.forget()
  saves.observe('u1', 'old', { _mtime: '2020-01-01T00:00:00.000Z', state: { timeOffset: 5 } }, at('2026-11-02T21:45:00.000Z'))
  saves.observe('u1', 'old', { _mtime: '2026-11-02T21:45:30.000Z', state: { timeOffset: 900 } }, at('2026-11-02T21:45:38.000Z'))
  assert.equal(saves.lastSaveAt('u1', 'old', at('2026-11-02T21:45:40.000Z')), null, 'that was its first sight')
})

test('a card: playing counts on from the save, paused stands still', () => {
  saves.forget()
  const user = { id: 'u1', providerType: 'stremio' }
  const session = { itemId: 'tt0096697', videoId: VIDEO }
  read('2026-11-02T21:45:00.000Z', 100000)
  read('2026-11-02T21:46:30.000Z', 190000)
  const playing = stremioSaveFields(user, session, at('2026-11-02T21:46:40.000Z'))
  assert.equal(playing.source, 'stremio-saves')
  assert.equal(playing.positionAt, at('2026-11-02T21:46:30.000Z'))
  assert.equal(playing.paused, undefined)

  read('2026-11-02T21:47:00.000Z', 220000)
  const paused = stremioSaveFields(user, session, at('2026-11-02T21:47:10.000Z'))
  assert.equal(paused.paused, true)
  assert.equal(paused.positionAt, undefined)
  assert.equal(paused.lastPosition, 220000)

  assert.equal(stremioSaveFields({ id: 'u1', providerType: 'nuvio' }, session, at('2026-11-02T21:47:10.000Z')), null, 'Stremio only')
})

test('a paused card goes after 5 minutes, or 20 while the proxy has the stream', () => {
  const t = at('2026-11-02T22:00:00.000Z')
  const card = (minutesAgo, extra = {}) => ({ source: 'stremio-saves', paused: true, stremioSavedAt: t - minutesAgo * 60000, ...extra })
  assert.equal(stremioSaveCards([card(4)], t).length, 1)
  assert.equal(stremioSaveCards([card(5)], t).length, 0)
  assert.equal(stremioSaveCards([card(19, { carriedByProxy: true })], t).length, 1)
  assert.equal(stremioSaveCards([card(20, { carriedByProxy: true })], t).length, 0)
  const playing = { source: 'stremio-saves', stremioSavedAt: t - 60 * 60000 }
  const other = { source: 'aiostreams-proxy' }
  assert.equal(stremioSaveCards([playing, other], t).length, 2, 'only paused save cards are touched')
})

// --- Sessions ---

function fakePrisma(rows = []) {
  return {
    rows,
    user: { findUnique: async () => ({ id: 'u1', username: 'TEST', email: null, colorIndex: 0, discordWebhookUrl: null, providerType: 'stremio' }) },
    watchSession: {
      findMany: async ({ where }) => rows.filter((r) => r.isActive === where.isActive),
      findUnique: async () => rows[0] || null,
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
      upsert: async ({ create, update }) => {
        if (rows[0]) return Object.assign(rows[0], update)
        const row = { id: 's1', ...create }
        rows.push(row)
        return row
      },
    },
  }
}

test('a Stremio viewing longer than 18 minutes stays open while it saves', async () => {
  saves.forget()
  const prisma = fakePrisma([{
    id: 's1', accountId: 'a', userId: 'u1', itemId: 'tt0096697', videoId: VIDEO, itemName: 'The Simpsons', itemType: 'series',
    startTime: new Date(OPENED), startPosition: 0, lastPosition: 0, durationSeconds: 0, isActive: true, endTime: null, totalDuration: DURATION,
  }])
  const poll = (mtime, offset) => processUserSessions(prisma, 'a', 'u1', [item(mtime, offset)], new Date(at(mtime) + 8000))
  await poll('2026-11-02T21:58:00.000Z', 100000)
  await poll('2026-11-02T22:10:00.000Z', 800000) // 26 minutes after opening
  assert.equal(prisma.rows[0].isActive, true)
  assert.equal(prisma.rows[0].lastPosition, 800000)

  // Stops saving: closes one window after the last save, at that save.
  await processUserSessions(prisma, 'a', 'u1', [item('2026-11-02T22:10:00.000Z', 800000)], new Date(at('2026-11-02T22:29:00.000Z')))
  assert.equal(prisma.rows[0].isActive, false)
  assert.equal(prisma.rows[0].endTime.toISOString(), '2026-11-02T22:10:00.000Z')
})

test('a Nuvio library is not read for saves', async () => {
  saves.forget()
  const prisma = fakePrisma([])
  prisma.user.findUnique = async () => ({ id: 'u1', username: 'TEST', providerType: 'nuvio' })
  await processUserSessions(prisma, 'a', 'u1', [item('2026-11-02T22:10:00.000Z', 800000)], new Date(at('2026-11-02T22:10:08.000Z')))
  await processUserSessions(prisma, 'a', 'u1', [item('2026-11-02T22:11:30.000Z', 890000)], new Date(at('2026-11-02T22:11:38.000Z')))
  assert.equal(saves.lastSaveAt('u1', 'tt0096697', at('2026-11-02T22:11:40.000Z')), null)
})

// --- With the proxy ---

function proxyPrisma(active, closed = []) {
  return {
    proxyStreamSession: { findMany: async ({ where }) => (where.isActive ? active : closed) },
    proxyUserIpAffinity: { findMany: async () => [] },
    proxyDeviceClaim: { findMany: async () => [] },
  }
}
const stream = (extra = {}) => ({
  aiostreamsUser: 'slick', displayName: 'The Simpsons', metadataItemId: 'tt0096697', metadataName: 'The Simpsons', metadataItemType: 'series',
  url: 'u', clientIp: null, requestCount: 9, startTime: new Date(Date.now() - 600000), lastSeenAt: new Date(), updatedAt: new Date(), endTime: null, ...extra,
})
const saveRow = () => ({ user: { id: 'u1', username: 'slick' }, item: { id: 'tt0096697', name: 'The Simpsons' }, source: 'stremio-saves', paused: true, lastPosition: 5, stremioSavedAt: Date.now() })
const users = [{ id: 'u1', username: 'slick' }]

test('the proxy does not replace a card its saves stand behind, and marks it as still open', async () => {
  const rows = await mergeProxyNowPlaying(proxyPrisma([stream()]), 'a', users, [saveRow()], { isConfirming: () => true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'stremio-saves')
  assert.equal(rows[0].paused, true)
  assert.equal(rows[0].carriedByProxy, true)
})

test('the card goes when the proxy sees the stream close', async () => {
  const closed = stream({ endTime: new Date() })
  const rows = await mergeProxyNowPlaying(proxyPrisma([], [closed]), 'a', users, [saveRow()], { isConfirming: () => true })
  assert.equal(rows.length, 0)
})

test('a seek leaving an old connection closed does not take the card away', async () => {
  const rows = await mergeProxyNowPlaying(proxyPrisma([stream()], [stream({ endTime: new Date() })]), 'a', users, [saveRow()], { isConfirming: () => true })
  assert.equal(rows.length, 1)
})

test('records not looked at for a day are swept', () => {
  const s = require('../server/utils/stremioSaves')
  s.forget()
  const DAY = 24 * 60 * 60 * 1000
  const t0 = Date.now()
  const item = { _mtime: new Date(t0).toISOString(), state: { timeOffset: 1000, video_id: 'v' } }
  s.observe('u-sweep', 'tt1', item, t0)
  assert.equal(s.viewing('u-sweep', 'tt1', null, t0), null) // first sight is no save, but is held
  s.observe('u-other', 'tt2', item, t0 + DAY + 11 * 60 * 1000) // later pass sweeps the old record
  s.observe('u-sweep', 'tt1', { ...item, _mtime: new Date(t0 + 1000).toISOString(), state: { timeOffset: 5000, video_id: 'v' } }, t0 + DAY + 12 * 60 * 1000)
  // the swept record is gone, so this reads as a first sight again: no save seen
  assert.equal(s.viewing('u-sweep', 'tt1', null, t0 + DAY + 12 * 60 * 1000), null)
  s.forget()
})

// --- Copies SlickSync wrote ---

test('a copy SlickSync wrote is not a viewing, and real playback after it still is', async () => {
  saves.forget()
  ownWrites.forget()
  const prisma = fakePrisma([])
  const T0 = '2026-11-02T20:00:00.000Z'
  const COPY = '2026-11-02T22:00:00.000Z'
  const recent = '2026-11-02T21:58:00.000Z' // the source's real watch, minutes before the copy
  // The item was touched earlier today, so its saves are being remembered.
  await processUserSessions(prisma, 'a', 'u1', [item(T0, 100000, { lastWatched: '2026-11-01T10:00:00.000Z' })], new Date(at(T0) + 8000))
  // Keep in step writes a further-along position with the source's recent date.
  ownWrites.note('u1', [{ id: 'tt0096697', mtime: COPY }], at(COPY))
  const copied = item(COPY, 700000, { lastWatched: recent })
  assert.equal(saves.observe('u1', 'tt0096697', copied, at(COPY) + 5000), false, 'not a save')
  await processUserSessions(prisma, 'a', 'u1', [copied], new Date(at(COPY) + 60000))
  assert.equal(prisma.rows.length, 0, 'no session seeded from the copied position')
  assert.equal(saves.lastSaveAt('u1', 'tt0096697', at(COPY) + 60000), null)

  // Someone presses play: the next save moves _mtime and the position.
  const REAL = '2026-11-02T22:05:00.000Z'
  const played = item(REAL, 705000, { lastWatched: recent })
  assert.equal(saves.observe('u1', 'tt0096697', played, at(REAL) + 5000), true, 'a real save is seen')
  await processUserSessions(prisma, 'a', 'u1', [played], new Date(at(REAL) + 8000))
  assert.equal(prisma.rows.length, 1, 'real playback opens a session')
  assert.equal(prisma.rows[0].isActive, true)
})

test('a Nuvio copy stays out of Now Playing until the position or date moves', async () => {
  saves.forget()
  ownWrites.forget()
  const prisma = fakePrisma([])
  prisma.user.findUnique = async () => ({ id: 'u1', username: 'TEST', providerType: 'nuvio' })
  const WHEN = '2026-11-02T22:00:00.000Z'
  ownWrites.note('u1', [{ id: 'tt0096697', lastWatched: WHEN, position: 700000 }], at(WHEN))
  const copied = item(WHEN, 700000, { lastWatched: WHEN })
  await processUserSessions(prisma, 'a', 'u1', [copied], new Date(at(WHEN) + 60000))
  assert.equal(prisma.rows.length, 0)
  const played = item(WHEN, 760000, { lastWatched: '2026-11-02T22:02:00.000Z' })
  await processUserSessions(prisma, 'a', 'u1', [played], new Date(at(WHEN) + 150000))
  assert.equal(prisma.rows.length, 1, 'real playback is never held back')
})

// Opening a title saves at once, with state.lastWatched at that same moment.
const opening = (mtime, offset, videoId = VIDEO) => item(mtime, offset, { lastWatched: mtime, video_id: videoId })

test('a title just opened plays from the opening save, before the timer has saved', () => {
  saves.forget()
  const t = '2026-11-09T05:27:00.000Z'
  assert.equal(saves.observe('u1', 'tt0096697', opening(t, 0), at(t) + 20000), true, 'the opening save counts')
  const seen = saves.viewing('u1', 'tt0096697', VIDEO, at(t) + 20000)
  assert.equal(seen.paused, false)
  assert.equal(seen.ended, false)
  assert.equal(seen.positionMs, 0)
  const card = stremioSaveFields({ id: 'u1', providerType: 'stremio' }, { itemId: 'tt0096697', videoId: VIDEO }, at(t) + 20000)
  assert.equal(card.positionAt, at(t), 'counted on from the moment it opened')
  assert.equal(card.paused, undefined)
})

test('reopening a title part way through plays from where it was', () => {
  saves.forget()
  const t = '2026-11-09T05:27:00.000Z'
  saves.observe('u1', 'tt0096697', opening(t, 600000), at(t) + 5000)
  assert.equal(saves.viewing('u1', 'tt0096697', VIDEO, at(t) + 5000).positionMs, 600000)
})

test('a first sight of an older opening is still only the baseline', () => {
  saves.forget()
  const t = '2026-11-09T05:27:00.000Z'
  // Opened ten minutes before the server first read it (a restart).
  assert.equal(saves.observe('u1', 'tt0096697', opening(t, 0), at(t) + 600000), false)
  assert.equal(saves.viewing('u1', 'tt0096697', VIDEO, at(t) + 600000), null)
  // A later save that is not the opening one (lastWatched stays put).
  saves.forget()
  const later = item('2026-11-09T05:30:00.000Z', 180000, { lastWatched: t })
  assert.equal(saves.observe('u1', 'tt0096697', later, at('2026-11-09T05:30:00.000Z') + 5000), false)
})

test('the next episode opened at 0 is playing, not an ending', () => {
  saves.forget()
  read('2026-11-02T22:48:23.126Z', 1195027)
  read('2026-11-02T22:49:53.126Z', 1285027)
  const t = '2026-11-02T23:10:00.000Z'
  assert.equal(saves.observe('u1', 'tt0096697', opening(t, 0, 'tt0096697:1:2'), at(t) + 10000), true)
  const seen = saves.viewing('u1', 'tt0096697', 'tt0096697:1:2', at(t) + 10000)
  assert.equal(seen.ended, false)
  assert.equal(seen.paused, false)
})

test('an episode that ends still ends: lastWatched does not move with it', () => {
  saves.forget()
  read('2026-11-02T22:48:23.126Z', 1195027)
  read('2026-11-02T22:49:53.126Z', 1285027)
  const end = item('2026-11-02T22:52:00.000Z', 0, { video_id: 'tt0096697:1:2' })
  saves.observe('u1', 'tt0096697', end, at('2026-11-02T22:52:00.000Z') + 5000)
  assert.equal(saves.viewing('u1', 'tt0096697', 'tt0096697:1:2', at('2026-11-02T22:52:00.000Z') + 5000).ended, true)
})

test('a Stremio account read since a stream began, with nothing opened, is ruled out for it', () => {
  saves.forget()
  const start = Date.parse('2026-11-09T21:54:44Z')
  assert.equal(saves.openedNothingSince('u1', start, start + 60000), false, 'never read: nothing known')
  saves.libraryRead('u1', start - 16 * 3600e3, start + 10000)
  assert.equal(saves.openedNothingSince('u1', start, start + 20000), false, 'read too soon after the start')
  saves.libraryRead('u1', start - 16 * 3600e3, start + 60000)
  assert.equal(saves.openedNothingSince('u1', start, start + 70000), true)
  saves.libraryRead('u1', start + 3000, start + 60000)
  assert.equal(saves.openedNothingSince('u1', start, start + 70000), false, 'opened something then: maybe theirs')
  saves.libraryRead('u1', start - 60000, start + 60000)
  assert.equal(saves.openedNothingSince('u1', start, start + 70000), false, 'within a device clock\'s slack')
  saves.forget()
})

test('the stream goes to the Nuvio profile when the same person\'s Stremio opened nothing', async () => {
  saves.forget()
  const start = new Date(Date.now() - 3 * 60000)
  const stremio = { id: 'st', username: 'Them Stremio', email: 'them@example.invalid', providerType: 'stremio' }
  const nuvio = { id: 'nv', username: 'Them Nuvio', email: 'them@example.invalid', providerType: 'nuvio' }
  const row = { id: 'p1', accountId: 'default', aiostreamsUser: 'them', clientIp: '192.0.2.10', url: 'https://example.invalid/a', filename: 'Police.Story.1985.mkv', displayName: 'Police Story (1985)', requestCount: 6, startTime: start, lastSeenAt: new Date(start.getTime() + 150000), updatedAt: new Date(), isActive: true }
  const prisma = {
    proxyStreamSession: { findMany: async ({ where }) => (where.isActive ? [row] : []) },
    proxyUserIpAffinity: { findMany: async () => [{ clientIp: '192.0.2.10', userId: 'st' }], upsert: async () => {} },
    proxyDeviceClaim: { findMany: async () => [] },
    watchSession: { findMany: async () => [] },
    dismissedContinueWatching: { findFirst: async () => null },
  }
  const who = async () => (await mergeProxyNowPlaying(prisma, 'default', [stremio, nuvio], [], { isConfirming: () => true })).map((n) => n.user?.id)
  assert.deepEqual(await who(), ['st'], 'before Stremio is read, the address still decides')
  saves.libraryRead('st', start.getTime() - 16 * 3600e3, Date.now())
  assert.deepEqual(await who(), ['nv'])
  saves.forget()
})
