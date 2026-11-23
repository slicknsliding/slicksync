// The monthly recap goes to the bell and as a push every time, and the poster
// collage goes to Discord on top when a webhook is set. It used to be a push
// alone without Discord and Discord alone with it, so the bell never had it.
const test = require('node:test')
const assert = require('node:assert/strict')

// Stubbed before posterMosaic loads, since it takes these at require time.
const discordPosts = []
require('../server/utils/notify').postDiscordFile = async (url, buffer, filename, content) => {
  discordPosts.push({ url, filename, content })
  return true
}
let posterAnswer = async () => ({ ok: false })
require('../server/utils/safeUrl').safeFetch = (...args) => posterAnswer(...args)

const { generateAndPostMosaic, scheduleMosaicMonitor } = require('../server/utils/posterMosaic')

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

// November 2026: 30 shows watched, five of them without a poster.
const NOV = new Date('2026-11-15T12:00:00Z')
const EPISODES = Array.from({ length: 30 }, (_, i) => ({
  showId: `tt${1000 + i}`, showName: `Show ${i}`, poster: i < 25 ? `https://img.example.com/${i}.jpg` : null, watchedAt: NOV,
}))

function store({ sync = {}, episodes = EPISODES } = {}) {
  const account = { id: 'default', sync: { notifyOnMosaic: true, ...sync } }
  const rows = []
  const models = {
    appAccount: {
      findUnique: async () => ({ sync: account.sync }),
      findFirst: async () => ({ sync: account.sync }),
      findMany: async () => [{ id: account.id, sync: account.sync }],
      update: async ({ data }) => { account.sync = typeof data.sync === 'string' ? JSON.parse(data.sync) : data.sync },
    },
    movieWatchHistory: { findMany: async () => [] },
    episodeWatchHistory: { findMany: async () => episodes },
    notification: { create: async ({ data }) => { rows.push(data); return data } },
    pushSubscription: { findMany: async () => [] },
  }
  // Anything else answers empty.
  const empty = new Proxy({}, { get: (_, m) => (m === 'then' ? undefined : async () => (m === 'findMany' ? [] : null)) })
  const prisma = new Proxy(models, { get: (o, name) => (name === 'then' ? undefined : o[name] || empty) })
  return { prisma, rows, account }
}

test.beforeEach(() => { discordPosts.length = 0 })

test('without Discord, the recap lands in the bell with the real count', async () => {
  const { prisma, rows } = store()
  const result = await generateAndPostMosaic(prisma, 'default', null, '2026-11', 'UTC')
  assert.equal(result.posted, true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'recap')
  assert.equal(rows[0].title, 'November 2026 recap')
  assert.equal(rows[0].body, '30 titles watched in November')
  assert.equal(rows[0].url, '/metrics')
  assert.equal(rows[0].poster, null)
  assert.equal(discordPosts.length, 0)
})

test('one title reads in the singular', async () => {
  const { prisma, rows } = store({ episodes: EPISODES.slice(0, 1) })
  await generateAndPostMosaic(prisma, 'default', null, '2026-11', 'UTC')
  assert.equal(rows[0].body, '1 title watched in November')
})

test('with Discord, the bell still gets the recap', async () => {
  const { prisma, rows } = store()
  const result = await generateAndPostMosaic(prisma, 'default', 'https://discord.example.com/api/webhooks/1/x', '2026-11', 'UTC')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'recap')
  // No poster loaded here, so the collage itself fails and is retried later.
  assert.equal(result.posted, false)
  assert.equal(result.noticeSent, true)
})

test('nothing watched sends nothing', async () => {
  const { prisma, rows } = store({ episodes: [] })
  const result = await generateAndPostMosaic(prisma, 'default', null, '2026-11', 'UTC')
  assert.equal(result.reason, 'nothing watched')
  assert.equal(rows.length, 0)
})

test('a Discord retry does not send the bell and push again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { prisma, rows, account } = store({ sync: { webhookUrl: 'https://discord.example.com/api/webhooks/1/x' } })
  scheduleMosaicMonitor(prisma, 'default')
  await flush()
  assert.equal(rows.length, 1)
  assert.match(String(account.sync.lastRecapNoticeMonth), /^\d{4}-\d{2}$/)
  assert.equal(account.sync.lastMosaicMonth, undefined, 'the collage failed, so it is retried')
  // The next 6-hour check: the collage is tried again, the recap is not sent again.
  t.mock.timers.tick(6 * 60 * 60 * 1000)
  await flush()
  assert.equal(rows.length, 1)
  assert.equal(account.sync.lastMosaicMonth, undefined)
})

test('with posters, Discord gets the collage and the bell gets the recap', async () => {
  const { Jimp } = require('jimp')
  const png = await new Jimp({ width: 2, height: 3, color: 0x336699ff }).getBuffer('image/png')
  posterAnswer = async () => ({ ok: true, arrayBuffer: async () => png })
  try {
    const { prisma, rows } = store()
    const result = await generateAndPostMosaic(prisma, 'default', 'https://discord.example.com/api/webhooks/1/x', '2026-11', 'UTC')
    assert.equal(result.posted, true)
    assert.equal(rows.length, 1)
    assert.equal(discordPosts.length, 1)
    assert.equal(discordPosts[0].content, '**November 2026 — 30 titles watched**')
  } finally {
    posterAnswer = async () => ({ ok: false })
  }
})
