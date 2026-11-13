const test = require('node:test')
const assert = require('node:assert')
const { vaultFieldProblem } = require('../server/utils/vaultFields')

test('good saves pass, including leaving fields out', () => {
  assert.strictEqual(vaultFieldProblem({}), null)
  assert.strictEqual(vaultFieldProblem({ testType: 'torbox', notifyDaysBefore: 4, isActive: false, secretLabel: 'API Key', expiresAt: '2026-12-31T15:43:00Z' }), null)
  assert.strictEqual(vaultFieldProblem({ testType: 'manual', notifyDaysBefore: 0, expiresAt: null }), null)
  assert.strictEqual(vaultFieldProblem({ testType: 'debrid_link', expiresAt: '' }), null)
})

test('each wrong field is named', () => {
  assert.match(vaultFieldProblem({ testType: 'made_up' }), /testType/)
  assert.match(vaultFieldProblem({ testType: 'constructor' }), /testType/)
  assert.match(vaultFieldProblem({ notifyDaysBefore: '3' }), /notifyDaysBefore/)
  assert.match(vaultFieldProblem({ notifyDaysBefore: -1 }), /notifyDaysBefore/)
  assert.match(vaultFieldProblem({ notifyDaysBefore: 2.5 }), /notifyDaysBefore/)
  assert.match(vaultFieldProblem({ isActive: 'yes' }), /isActive/)
  assert.match(vaultFieldProblem({ secretLabel: { a: 1 } }), /secretLabel/)
  assert.match(vaultFieldProblem({ expiresAt: 'not a date' }), /expiresAt/)
  assert.match(vaultFieldProblem({ expiresAt: { at: 1 } }), /expiresAt/)
  assert.match(vaultFieldProblem({ expiresAt: '0001-01-01' }), /expiresAt/)
})
