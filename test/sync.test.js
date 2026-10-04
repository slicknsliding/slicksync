const test = require('node:test')
const assert = require('node:assert/strict')
const { createManifestFingerprint } = require('../server/utils/sync')

test('createManifestFingerprint (urlOnly): identity is the canonical URL only', () => {
  const fp = createManifestFingerprint(null, { urlOnly: true })
  const addon = { transportUrl: 'HTTPS://Example.com/Manifest.json  ' }
  assert.equal(fp(addon), 'https://example.com/manifest.json')
})

test('createManifestFingerprint (urlOnly): uses a supplied canonicalizeManifestUrl', () => {
  const canonicalizeManifestUrl = (u) => `canon:${u}`
  const fp = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly: true })
  assert.equal(fp({ url: 'https://example.com/x.json' }), 'canon:https://example.com/x.json')
})

test('createManifestFingerprint (Stremio): identity is the addon UUID, not manifest content', () => {
  // Regression test for the false-"Unsynced" bug: the background addon
  // health checker refreshes the DB's cached manifest (name/description/
  // resources) independent of anything the admin/user did. Two addon
  // entries with the same install URL but different manifest content -
  // simulating "before" and "after" a health-checker refresh - must
  // fingerprint identically, or sync status falsely flips to Unsynced.
  const fp = createManifestFingerprint(null, { urlOnly: false })
  const uuid = '00000000-0000-4000-8000-000000000000'
  const addonBeforeRefresh = {
    transportUrl: `https://host/stremio/${uuid}/manifest.json`,
    manifest: { name: 'Old Name', description: 'v1', resources: ['stream'] },
  }
  const addonAfterRefresh = {
    transportUrl: `https://host/stremio/${uuid}/manifest.json`,
    manifest: { name: 'New Name', description: 'v2 - refreshed by health checker', resources: ['stream', 'catalog'] },
  }
  assert.equal(fp(addonBeforeRefresh), fp(addonAfterRefresh))
  assert.equal(fp(addonBeforeRefresh), uuid)
})

test('createManifestFingerprint (Stremio): different addon UUIDs still differ', () => {
  const fp = createManifestFingerprint(null, { urlOnly: false })
  const a = { transportUrl: 'https://host/stremio/00000000-0000-4000-8000-000000000000/manifest.json' }
  const b = { transportUrl: 'https://host/stremio/11111111-2222-3333-4444-555555555555/manifest.json' }
  assert.notEqual(fp(a), fp(b))
})

test('createManifestFingerprint (Stremio): without a UUID the whole address is the identity', () => {
  const { canonicalizeManifestUrl } = require('../server/utils/validation')
  const fp = createManifestFingerprint(canonicalizeManifestUrl, { urlOnly: false })
  const cinemeta = { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' }
  const torrentio = { transportUrl: 'https://torrentio.strem.fun/providers=yts/manifest.json' }
  const subs = { transportUrl: 'https://opensubtitles-v3.strem.io/manifest.json' }
  // Different addons are different - they all used to be "manifest.json".
  assert.equal(new Set([cinemeta, torrentio, subs].map(fp)).size, 3)
  // The same addon written slightly differently is still the same.
  assert.equal(fp(cinemeta), fp({ transportUrl: 'http://V3-Cinemeta.strem.io/manifest.json?x=1' }))
  // An account with Cinemeta + Torrentio is not "in sync" with Cinemeta + OpenSubtitles.
  assert.notDeepEqual([cinemeta, torrentio].map(fp).sort(), [cinemeta, subs].map(fp).sort())
})

test('createManifestFingerprint (Stremio): a UUID address stays the same addon when its encrypted part changes', () => {
  const fp = createManifestFingerprint(null, { urlOnly: false })
  const uuid = '00000000-0000-4000-8000-000000000000'
  assert.equal(fp({ transportUrl: `https://host/stremio/${uuid}/encA/manifest.json` }), fp({ transportUrl: `https://host/stremio/${uuid}/encB/manifest.json` }))
})

test('createManifestFingerprint (Stremio): handles an unparseable URL without throwing', () => {
  const fp = createManifestFingerprint(null, { urlOnly: false })
  assert.doesNotThrow(() => fp({ transportUrl: 'not a url' }))
})
