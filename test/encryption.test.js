// Pins how SlickSync encrypts. Every stored addon URL, Vault secret and
// provider login is under these functions; a change that alters a derived
// key or the stored format would leave all of it unreadable, so the outputs
// are fixed here against values checked by an independent implementation.
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const e = require('../server/utils/encryption')
const km = require('../server/utils/keyManager')

const ikm = Buffer.alloc(32, 0xaa)
const salt = Buffer.alloc(32, 0x55)

test('HKDF matches the standard (RFC 5869) and its pinned output', () => {
  const ours = e.hkdfSha256(ikm, salt)
  assert.strictEqual(ours.toString('hex'), 'ff0f6343815fd017c4617a033f2b8fe597df0cac6582bc22bf62be16edd88d3d')
  assert.ok(ours.equals(Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'syncio-hkdf', 32))))
})

test('the per-account key (syncio-dek) is pinned', () => {
  const dek = e.deriveDek(salt, ikm)
  assert.strictEqual(dek.toString('hex'), '89e08d21f3cad3f677a5f553129bdfd1cb495b51db5939ba3420116bd15af81d')
  assert.ok(dek.equals(Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'syncio-dek', 32))))
})

test('passphrase keys (scrypt) are pinned', async () => {
  const k = await e.scryptKey('example-passphrase', 'example-salt')
  assert.strictEqual(k.toString('hex'), '51ab216d7aaa7ebbf979febd4dc77375474f08187d48d2966cf2c84000d3a825')
})

test('AES-GCM round trip, and tampering or a wrong key is refused', () => {
  const key = crypto.randomBytes(32)
  const sealed = e.aesGcmEncrypt(key, 'manifest-url-example')
  assert.strictEqual(sealed.split(':').length, 3)
  assert.strictEqual(e.aesGcmDecrypt(key, sealed), 'manifest-url-example')
  assert.throws(() => e.aesGcmDecrypt(crypto.randomBytes(32), sealed))
  const [iv, ct, tag] = sealed.split(':')
  const flipped = Buffer.from(ct, 'base64'); flipped[0] ^= 1
  assert.throws(() => e.aesGcmDecrypt(key, `${iv}:${flipped.toString('base64')}:${tag}`))
  const withAad = e.aesGcmEncrypt(key, 'x', 'account-a')
  assert.strictEqual(e.aesGcmDecrypt(key, withAad, 'account-a'), 'x')
  assert.throws(() => e.aesGcmDecrypt(key, withAad, 'account-b'))
})

test('the older pipe-separated format still decrypts', () => {
  // An iv, ciphertext or tag holding the separator byte could not be split
  // back apart, so draw until one has none (a few tries at most).
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update('legacy value'), c.final()])
    const tag = c.getAuthTag()
    if ([iv, ct, tag].some((b) => b.includes(0x7c))) continue
    const legacy = Buffer.concat([iv, Buffer.from('|'), ct, Buffer.from('|'), tag]).toString('base64')
    assert.strictEqual(e.aesGcmDecrypt(key, legacy), 'legacy value')
    return
  }
  assert.fail('no separator-free sample in 100 tries')
})

test('data under an older key is still read through the fallbacks', () => {
  const sealed = e.aesGcmEncrypt(km.LEGACY_KEY, 'written before the key changed')
  assert.ok(km.ENCRYPTION_KEY_FALLBACKS.some((k) => k.equals(km.LEGACY_KEY)))
  assert.strictEqual(e.decrypt(sealed, {}), 'written before the key changed')
  assert.throws(() => e.decrypt(e.aesGcmEncrypt(crypto.randomBytes(32), 'y'), {}))
})
