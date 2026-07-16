const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeProxyNowPlaying } = require('../server/utils/proxyNowPlaying')

function makeProxyRow(overrides = {}) {
  return {
    id: 'proxy-1',
    aiostreamsUser: 'alice',
    filename: 'The.Rock.1996.mkv',
    displayName: 'The Rock (1996)',
    posterUrl: null,
    url: 'https://example.com/stream',
    startTime: new Date('2026-07-15T20:00:00Z'),
    lastSeenAt: new Date('2026-07-15T20:05:00Z'),
    ...overrides,
  }
}

test('mergeProxyNowPlaying: a stale/unrelated active proxy row does not suppress a different-title native entry for the same user (usenet regression)', async () => {
  // This is the exact bug reported: a user streaming a usenet-sourced show
  // (never routed through AIOStreams' proxy) had their legitimate native
  // Now Playing entry silently dropped whenever ANY active proxy row -
  // even a stale/unrelated debrid one - was attributed to them.
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const nativeChernobylEntry = {
    user: { id: 'user-1', username: 'alice' },
    item: { id: 'tt123', name: 'Chernobyl', type: 'series' },
    videoId: 'tt123:1:1',
  }
  const fakePrisma = {
    proxyStreamSession: {
      findMany: async () => [makeProxyRow()], // active proxy row for an unrelated title
    },
  }

  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', users, [nativeChernobylEntry])

  const titles = result.map((r) => r.item.name)
  assert.ok(titles.includes('The Rock (1996)'), 'proxy-derived entry should be present')
  assert.ok(titles.includes('Chernobyl'), 'unrelated native entry must survive - this is the usenet fix')
})

test('mergeProxyNowPlaying: a matching-title proxy row supersedes the native entry, borrowing its richer metadata', async () => {
  const users = [{ id: 'user-1', username: 'alice', email: 'alice@example.com' }]
  const nativeEntry = {
    user: { id: 'user-1', username: 'alice' },
    item: { id: 'tt999', name: 'The Rock', type: 'movie', poster: 'https://posters/rock.jpg' },
    videoId: null,
  }
  const fakePrisma = {
    proxyStreamSession: {
      findMany: async () => [makeProxyRow()], // displayName "The Rock (1996)" title-matches "The Rock"
    },
  }

  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', users, [nativeEntry])

  assert.equal(result.length, 1, 'should be a single merged entry, not a duplicate')
  assert.equal(result[0].source, 'aiostreams-proxy')
  assert.equal(result[0].item.id, 'tt999', 'should borrow the richer native item metadata, not the bare proxy one')
})

test('mergeProxyNowPlaying: returns the native list unchanged when there are no active proxy sessions', async () => {
  const nativeEntry = { user: { id: 'user-1', username: 'alice' }, item: { name: 'Anything' } }
  const fakePrisma = { proxyStreamSession: { findMany: async () => [] } }
  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', [{ id: 'user-1', username: 'alice' }], [nativeEntry])
  assert.deepEqual(result, [nativeEntry])
})

test('mergeProxyNowPlaying: falls back to the native list if the proxy session query fails', async () => {
  const nativeEntry = { user: { id: 'user-1', username: 'alice' }, item: { name: 'Anything' } }
  const fakePrisma = { proxyStreamSession: { findMany: async () => { throw new Error('db down') } } }
  const result = await mergeProxyNowPlaying(fakePrisma, 'acct-1', [{ id: 'user-1', username: 'alice' }], [nativeEntry])
  assert.deepEqual(result, [nativeEntry])
})
