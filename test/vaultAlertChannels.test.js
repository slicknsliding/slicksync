'use strict'
// Vault alerts can be switched off per channel (push, bell, Discord) without
// touching the master Vault toggle; unset means on, as before the switches.
const test = require('node:test')
const assert = require('node:assert/strict')
const { _test: { vaultChannels, getNotifyConfig, notify } } = require('../server/utils/vaultMonitor')

function fakePrisma(sync) {
  const bell = []
  return {
    bell,
    appAccount: { findUnique: async () => ({ sync: JSON.stringify(sync) }) },
    notification: {
      create: async ({ data }) => { bell.push(data); return data },
      upsert: async ({ create }) => { bell.push(create); return create },
    },
  }
}

test('nothing stored means every channel is on', () => {
  assert.deepEqual(vaultChannels({}), { push: true, bell: true, discord: true })
  assert.deepEqual(vaultChannels(null), { push: true, bell: true, discord: true })
  assert.deepEqual(vaultChannels({ vaultAlerts: 'junk' }), { push: true, bell: true, discord: true })
})

test('only an explicit false turns a channel off', () => {
  assert.deepEqual(vaultChannels({ vaultAlerts: { push: false } }), { push: false, bell: true, discord: true })
  assert.deepEqual(vaultChannels({ vaultAlerts: { bell: false, discord: false } }), { push: true, bell: false, discord: false })
  assert.deepEqual(vaultChannels({ vaultAlerts: { push: true, bell: 0 } }), { push: true, bell: true, discord: true })
})

test('a Discord switch that is off hides the webhook from the sender', () => {
  const on = getNotifyConfig({ notifyOnVault: true, webhookUrl: 'https://example.invalid/hook' })
  assert.equal(on.discordWebhookUrl, 'https://example.invalid/hook')
  const off = getNotifyConfig({ notifyOnVault: true, webhookUrl: 'https://example.invalid/hook', vaultAlerts: { discord: false } })
  assert.equal(off.discordWebhookUrl, null)
  assert.equal(off.enabled, true)
})

test('bell on, push off: the bell row is written', async () => {
  const prisma = fakePrisma({ notifyOnVault: true, vaultAlerts: { push: false } })
  const cfg = getNotifyConfig({ notifyOnVault: true, vaultAlerts: { push: false } })
  await notify(cfg, { title: 'Key expiring', message: 'x' }, { prisma, accountId: 'a1' })
  assert.equal(prisma.bell.length, 1)
  assert.equal(prisma.bell[0].type, 'vault')
})

test('bell off: no bell row', async () => {
  const prisma = fakePrisma({ notifyOnVault: true, vaultAlerts: { bell: false, push: false } })
  const cfg = getNotifyConfig({ notifyOnVault: true, vaultAlerts: { bell: false, push: false } })
  await notify(cfg, { title: 'Key expiring', message: 'x' }, { prisma, accountId: 'a1' })
  assert.equal(prisma.bell.length, 0)
})

test('both on keeps the old path: one bell row', async () => {
  const prisma = fakePrisma({ notifyOnVault: true })
  const cfg = getNotifyConfig({ notifyOnVault: true })
  await notify(cfg, { title: 'Key expiring', message: 'x' }, { prisma, accountId: 'a1' })
  assert.equal(prisma.bell.length, 1)
})

test('the master Vault toggle off still blocks the bell when push is off', async () => {
  const prisma = fakePrisma({ notifyOnVault: false, vaultAlerts: { push: false } })
  const cfg = getNotifyConfig({ notifyOnVault: false, vaultAlerts: { push: false } })
  await notify(cfg, { title: 'Key expiring', message: 'x' }, { prisma, accountId: 'a1' })
  assert.equal(prisma.bell.length, 0)
})
