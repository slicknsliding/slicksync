// Pausing on AIOStreams (server/utils/aioPause.js): which addons lose their
// streams, and that putting back an old version of a configuration leaves
// SlickSync's own variants as they are now (server/utils/aioConfigHistory.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { pauseScript } = require('../server/utils/aioPause')
const { merge } = require('../server/utils/aioConfigHistory')

test('only the stream goes: stream-only addons are switched off, mixed ones keep their catalogs', async () => {
  const realFetch = global.fetch
  global.fetch = async (url) => ({
    json: async () => (String(url).endsWith('/api/v1/status')
      ? { data: { settings: { presets: [
        { ID: 'torrentio', SUPPORTED_RESOURCES: ['stream'] },
        { ID: 'mediafusion', SUPPORTED_RESOURCES: ['stream', 'catalog', 'meta'] },
        { ID: 'custom', SUPPORTED_RESOURCES: [] },
      ] } } }
      : String(url).includes('streams-addon') ? { resources: ['stream'] } : { resources: ['catalog', { name: 'meta' }] }),
  })
  try {
    const script = await pauseScript('http://aio', { presets: [
      { type: 'torrentio', instanceId: 'a1', options: {} },
      { type: 'mediafusion', instanceId: 'b2', options: {} },
      { type: 'custom', instanceId: 'c3', options: { manifestUrl: 'http://streams-addon/manifest.json' } },
      { type: 'custom', instanceId: 'd4', options: { manifestUrl: 'http://catalogs/manifest.json' } },
      { type: 'torrentio', instanceId: 'e5', enabled: false, options: {} },
      { type: 'mediafusion', instanceId: 'f6', options: { resources: ['catalog'] } },
    ] })
    assert.deepEqual(script.split('\n'), [
      'disable presets[instanceId=a1]',
      'set presets[instanceId=b2].options.resources = ["catalog","meta"]',
      'disable presets[instanceId=c3]',
    ])
  } finally {
    global.fetch = realFetch
  }
})

test('putting back an old version keeps SlickSync\'s own variants as they are now', () => {
  const old = {
    variants: [{ id: 'stremio', script: 'x' }, { id: 'slicksync-pause', script: 'old pause' }],
    jellyfin: { primary: { variants: ['stremio', 'slicksync-pause'] }, personas: [{ id: 'kid', variants: ['slicksync-kid'] }] },
  }
  const current = {
    variants: [{ id: 'slicksync-kid', script: 'collections' }],
    jellyfin: { primary: { name: 'Me' }, personas: [{ id: 'kid', variants: ['slicksync-kid'] }] },
  }
  const next = merge(old, current, { keepPersonas: false })
  assert.deepEqual(next.variants.map((v) => v.id), ['stremio', 'slicksync-kid'], 'the old pause is not brought back')
  assert.deepEqual(next.jellyfin.primary.variants, ['stremio'])
  assert.deepEqual(next.jellyfin.personas[0].variants, ['slicksync-kid'])
})
