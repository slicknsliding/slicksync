// Fixes from the 2026-11-27 audit:
// - the Live TV watch keeps a setting that was saved while it was checking;
// - a route that edits someone's addon list waits its turn behind a sync;
// - an account that reads back empty is read once more before a push.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { watchLiveTv } = require('../server/utils/liveTvWatch')
const { withPersonSync, personLock, personKey } = require('../server/utils/syncLock')
const { confirmEmptyRead, lastAssertedCount } = require('../server/utils/accountGuard')

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

test('a setting saved during a Live TV check is still there afterwards', async () => {
  const store = { sync: { screenTime: { u1: { limit: 60 } } } }
  const prisma = { appAccount: {
    findUnique: async () => ({ sync: store.sync }),
    update: async ({ data }) => { store.sync = data.sync; return {} },
  } }
  const person = { id: 'u1', username: 'Sam', accountId: 'acc' }
  const config = { presets: [{ type: 'm3u', options: { name: 'Home TV', playlist: 'http://tv.example.com/list.m3u' } }] }
  // While the playlist is being checked, someone switches the limit off and saves a theme choice.
  const check = async () => { store.sync = { ...store.sync, screenTime: {}, menuHighlight: 'orbit' }; return { ok: true, message: 'Playlist loads' } }
  await watchLiveTv(prisma, person, config, { now: Date.parse('2026-11-27T12:00:00Z'), check })
  assert.deepEqual(store.sync.screenTime, {})
  assert.equal(store.sync.menuHighlight, 'orbit')
  assert.equal(Object.keys(store.sync.liveTv.u1).length, 1)
})

test('another person’s Live TV entry saved meanwhile is kept', async () => {
  const store = { sync: {} }
  const prisma = { appAccount: {
    findUnique: async () => ({ sync: store.sync }),
    update: async ({ data }) => { store.sync = data.sync; return {} },
  } }
  const config = { presets: [{ type: 'm3u', options: { name: 'Home TV', playlist: 'http://tv.example.com/list.m3u' } }] }
  const check = async () => { store.sync = { ...store.sync, liveTv: { ...(store.sync.liveTv || {}), u2: { k: { name: 'Other', kind: 'm3u' } } } }; return { ok: true } }
  await watchLiveTv(prisma, { id: 'u1', username: 'Sam', accountId: 'acc' }, config, { now: Date.parse('2026-11-27T12:00:00Z'), check })
  assert.deepEqual(Object.keys(store.sync.liveTv).sort(), ['u1', 'u2'])
})

test('personKey falls back to the default account', () => {
  assert.equal(personKey(null, 'p1'), 'default:p1')
  assert.equal(personKey('acc', 'p1'), 'acc:p1')
})

test('an addon-list route waits behind a running sync and frees its turn when it has answered', async () => {
  const log = []
  const sync = withPersonSync('acc:p9', async () => { log.push('sync:start'); await tick(40); log.push('sync:end') })
  const res = new EventEmitter()
  const turn = personLock((req) => personKey('acc', req.params.id))
  turn({ params: { id: 'p9' } }, res, () => { log.push('route:start'); setTimeout(() => { log.push('route:end'); res.emit('finish') }, 20) })
  const after = withPersonSync('acc:p9', async () => { log.push('next:start') })
  await Promise.all([sync, after])
  assert.deepEqual(log, ['sync:start', 'sync:end', 'route:start', 'route:end', 'next:start'])
})

test('a route with no person to name goes straight through', () => {
  let called = false
  personLock(() => null)({ params: {} }, new EventEmitter(), () => { called = true })
  assert.equal(called, true)
})

test('a route that never answers gives its turn up', async () => {
  const turn = personLock(() => 'acc:p10', 30)
  turn({ params: {} }, new EventEmitter(), () => {})
  let ran = false
  await withPersonSync('acc:p10', async () => { ran = true })
  assert.equal(ran, true)
})

const guardPrisma = (keys) => ({ user: { findFirst: async () => ({ guardStateJson: keys ? JSON.stringify({ byProvider: { stremio: { keys, hash: 'x' } } }) : null }) } })

test('lastAssertedCount reads what SlickSync last left on the account', async () => {
  assert.equal(await lastAssertedCount(guardPrisma(['a', 'b', 'c']), 'u1', 'stremio'), 3)
  assert.equal(await lastAssertedCount(guardPrisma(null), 'u1', 'stremio'), 0)
  assert.equal(await lastAssertedCount(guardPrisma(['a']), 'u1', 'nuvio'), 0)
})

test('an account never known to hold addons is not read again', async () => {
  let reads = 0
  const verdict = await confirmEmptyRead(guardPrisma(null), 'u1', 'stremio', async () => { reads++; return [] }, { waitMs: 1 })
  assert.equal(verdict, 'ok')
  assert.equal(reads, 0)
})

test('empty, then addons on the second read: nothing is pushed', async () => {
  const verdict = await confirmEmptyRead(guardPrisma(['a', 'b']), 'u1', 'stremio', async () => [{ transportUrl: 'https://addon.example.com/manifest.json' }], { waitMs: 1 })
  assert.equal(verdict, 'changed')
})

test('empty both times is taken as really empty', async () => {
  const verdict = await confirmEmptyRead(guardPrisma(['a', 'b']), 'u1', 'stremio', async () => [], { waitMs: 1 })
  assert.equal(verdict, 'ok')
})

test('a second read that fails pushes nothing', async () => {
  const verdict = await confirmEmptyRead(guardPrisma(['a']), 'u1', 'stremio', async () => { throw new Error('timeout') }, { waitMs: 1 })
  assert.equal(verdict, 'changed')
})
