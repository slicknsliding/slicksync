const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { checkUser } = require('../server/utils/accountGuard')

const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json'
const TORRENTIO = 'https://torrentio.strem.fun/providers=yts/manifest.json'
const SUBS = 'https://opensubtitles-v3.strem.io/manifest.json'
const addon = (url, name) => ({ transportUrl: url, manifest: { name } })

// A Stremio account's guard baseline as it was stored before the identity
// fix: every addon keyed "manifest.json", no version.
function oldBaseline() {
  const keys = ['manifest.json', 'manifest.json']
  return {
    byProvider: {
      stremio: {
        keys,
        hash: crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16),
        addons: [{ url: CINEMETA, name: 'Cinemeta' }, { url: TORRENTIO, name: 'Torrentio' }],
        assertedAt: '2026-10-01T00:00:00.000Z',
      },
    },
  }
}

function fakePrisma() {
  const writes = []
  return { writes, user: { update: async ({ data }) => { writes.push(JSON.parse(data.guardStateJson)) } } }
}

const user = () => ({ id: 'u1', providerType: 'stremio', guardStateJson: JSON.stringify(oldBaseline()) })

test('deploying the identity fix raises no alert on an account that matches its baseline', async () => {
  const prisma = fakePrisma()
  const r = await checkUser(prisma, user(), {}, {}, { prefetchedAddons: [addon(CINEMETA, 'Cinemeta'), addon(TORRENTIO, 'Torrentio')] })
  assert.equal(r.verdict, 'match')
  assert.equal(prisma.writes[0].byProvider.stremio.v, 2)
})

test('a swap the old identity hid (Torrentio for OpenSubtitles) is now noticed, by name', async () => {
  const prisma = fakePrisma()
  const r = await checkUser(prisma, user(), {}, {}, { prefetchedAddons: [addon(CINEMETA, 'Cinemeta'), addon(SUBS, 'OpenSubtitles')] })
  assert.equal(r.verdict, 'alerted')
  assert.deepEqual(r.external.added.map((a) => a.name), ['OpenSubtitles'])
  assert.deepEqual(r.external.removed.map((a) => a.name), ['Torrentio'])
})
