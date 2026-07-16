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
  const uuid = 'b2341edd-01be-4317-97b0-ba7afb1e1326'
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
  const a = { transportUrl: 'https://host/stremio/b2341edd-01be-4317-97b0-ba7afb1e1326/manifest.json' }
  const b = { transportUrl: 'https://host/stremio/11111111-2222-3333-4444-555555555555/manifest.json' }
  assert.notEqual(fp(a), fp(b))
})

test('createManifestFingerprint (Stremio): falls back to the last path segment when no UUID is present', () => {
  const fp = createManifestFingerprint(null, { urlOnly: false })
  const addon = { transportUrl: 'https://host/some-custom-addon/manifest.json' }
  assert.equal(fp(addon), 'manifest.json')
})

test('createManifestFingerprint (Stremio): handles an unparseable URL without throwing', () => {
  const fp = createManifestFingerprint(null, { urlOnly: false })
  assert.doesNotThrow(() => fp({ transportUrl: 'not a url' }))
})
