const test = require('node:test')
const assert = require('node:assert/strict')
const { ensureEmailUniqueness } = require('../server/utils/helpers/database')

test('adding someone never deletes a person from another household', async () => {
  const touched = []
  const trap = new Proxy({}, { get: (_, model) => new Proxy({}, { get: (__, op) => async () => { touched.push(`${String(model)}.${String(op)}`); return [] } }) })
  await ensureEmailUniqueness(trap, 'Someone@Example.com', 'household-a')
  assert.deepEqual(touched.filter((t) => /delete|update/i.test(t)), [])
})
