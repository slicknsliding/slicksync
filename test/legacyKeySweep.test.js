const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-not-for-use-0123456789'
const { aesGcmEncrypt, aesGcmDecrypt } = require('../server/utils/encryption')
const { sweepLegacyKey } = require('../server/utils/legacyKeySweep')

const current = crypto.randomBytes(32)
const legacy = crypto.randomBytes(32)
const other = crypto.randomBytes(32)
const quiet = { log() {}, warn() {} }

function fakePrisma(rows, { failWrites = false } = {}) {
  return {
    user: {
      findMany: async ({ where }) => {
        const col = Object.keys(where)[0]
        return rows.filter((r) => r[col] != null).map((r) => ({ id: r.id, [col]: r[col] }))
      },
      updateMany: async ({ where, data }) => {
        if (failWrites) throw new Error('db down')
        const col = Object.keys(data)[0]
        const r = rows.find((x) => x.id === where.id && x[col] === where[col])
        if (!r) return { count: 0 }
        Object.assign(r, data)
        return { count: 1 }
      },
    },
  }
}
const targets = [['user', ['jellyfinToken']]]

test('a value that opens only under the legacy key moves to the current key', async () => {
  const rows = [
    { id: 'a', jellyfinToken: aesGcmEncrypt(legacy, 'old-secret') },
    { id: 'b', jellyfinToken: aesGcmEncrypt(current, 'fresh-secret') },
    { id: 'c', jellyfinToken: aesGcmEncrypt(other, 'account-key-secret') },
    { id: 'd', jellyfinToken: null },
  ]
  const before = { b: rows[1].jellyfinToken, c: rows[2].jellyfinToken }
  const r = await sweepLegacyKey(fakePrisma(rows), { current, legacy, targets, log: quiet })
  assert.deepEqual(r, { rewritten: 1, failed: 0 })
  assert.equal(aesGcmDecrypt(current, rows[0].jellyfinToken), 'old-secret')
  assert.equal(rows[1].jellyfinToken, before.b)
  assert.equal(rows[2].jellyfinToken, before.c)
  // idempotent
  assert.deepEqual(await sweepLegacyKey(fakePrisma(rows), { current, legacy, targets, log: quiet }), { rewritten: 0, failed: 0 })
})

test('a failed write leaves the old value readable', async () => {
  const old = aesGcmEncrypt(legacy, 'old-secret')
  const rows = [{ id: 'a', jellyfinToken: old }]
  const r = await sweepLegacyKey(fakePrisma(rows, { failWrites: true }), { current, legacy, targets, log: quiet })
  assert.deepEqual(r, { rewritten: 0, failed: 1 })
  assert.equal(rows[0].jellyfinToken, old)
  assert.equal(aesGcmDecrypt(legacy, rows[0].jellyfinToken), 'old-secret')
})

test('a value changed while sweeping is not overwritten', async () => {
  const rows = [{ id: 'a', jellyfinToken: aesGcmEncrypt(legacy, 'old-secret') }]
  const prisma = fakePrisma(rows)
  const real = prisma.user.updateMany
  prisma.user.updateMany = async (args) => { rows[0].jellyfinToken = aesGcmEncrypt(current, 'newer'); return real(args) }
  const r = await sweepLegacyKey(prisma, { current, legacy, targets, log: quiet })
  assert.equal(r.rewritten, 0)
  assert.equal(aesGcmDecrypt(current, rows[0].jellyfinToken), 'newer')
})

test('a missing table is skipped', async () => {
  assert.deepEqual(await sweepLegacyKey({}, { current, legacy, targets, log: quiet }), { rewritten: 0, failed: 0 })
})
