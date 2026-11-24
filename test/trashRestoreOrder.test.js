'use strict'
// A restored person goes back to the place they held in their group, not to
// the end of it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { _test: { spotIn, putBackAt } } = require('../server/utils/trash')

function fakePrisma(userIds) {
  const row = { userIds: JSON.stringify(userIds) }
  return {
    row,
    group: {
      findUnique: async () => ({ userIds: row.userIds }),
      update: async ({ data }) => { row.userIds = data.userIds },
    },
  }
}

test('spotIn finds the place, and says -1 for a stranger or unreadable list', () => {
  assert.equal(spotIn('["a","b","c"]', 'b'), 1)
  assert.equal(spotIn('["a"]', 'z'), -1)
  assert.equal(spotIn('not json', 'a'), -1)
  assert.equal(spotIn(null, 'a'), -1)
})

test('a person appended on restore moves back to their old place', async () => {
  const db = fakePrisma(['b', 'c', 'a'])
  await putBackAt(db, 'g', 'a', 0)
  assert.deepEqual(JSON.parse(db.row.userIds), ['a', 'b', 'c'])
})

test('a place past the end means the end', async () => {
  const db = fakePrisma(['b', 'a'])
  await putBackAt(db, 'g', 'a', 5)
  assert.deepEqual(JSON.parse(db.row.userIds), ['b', 'a'])
})

test('no saved place, or not a member: the list is left alone', async () => {
  const db = fakePrisma(['b', 'a'])
  await putBackAt(db, 'g', 'a', undefined)
  await putBackAt(db, 'g', 'a', -1)
  await putBackAt(db, 'g', 'zz', 0)
  assert.deepEqual(JSON.parse(db.row.userIds), ['b', 'a'])
})
