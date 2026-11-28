'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const js = require('../server/utils/jobStatus')

test.beforeEach(() => js._test.reset())

test('a run shows up with its plain name and time', () => {
  js.noteRun('vaultChecks', { ok: true })
  const [row] = js.listJobs()
  assert.equal(row.label, 'Vault checks')
  assert.equal(row.ok, true)
  assert.equal(row.message, null)
  assert.ok(!Number.isNaN(new Date(row.lastRunAt).getTime()))
})

test('a failed run keeps a reason, scrubbed of addresses and keys', () => {
  js.noteRun('addonHealth', { ok: false, message: 'GET https://example.invalid/path/abcdefghijklmnopqrstuvwxyz123456?key=SECRET failed with bearer abc.def' })
  const [row] = js.listJobs()
  assert.equal(row.ok, false)
  assert.ok(!/https?:|SECRET|abcdefghijklmnop|abc\.def/.test(row.message), row.message)
})

test('the reason is cut to 140 characters', () => {
  js.noteRun('backups', { ok: false, message: 'word '.repeat(100) })
  assert.ok(js.listJobs()[0].message.length <= 140)
})

test('a later good run replaces an earlier failure', () => {
  js.noteRun('backups', { ok: false, message: 'disk full' })
  js.noteRun('backups', { ok: true })
  const [row] = js.listJobs()
  assert.equal(row.ok, true)
  assert.equal(row.message, null)
})

test('known jobs come in a steady order, unknown ones last, bad input is ignored', () => {
  js.noteRun('followWatch', { ok: true })
  js.noteRun('somethingNew', { ok: true })
  js.noteRun('scheduledSync', { ok: true })
  js.noteRun(null)
  assert.deepEqual(js.listJobs().map((j) => j.name), ['scheduledSync', 'followWatch', 'somethingNew'])
})
