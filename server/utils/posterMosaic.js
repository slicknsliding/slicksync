// Monthly poster mosaic: a collage of every distinct title the household
// watched in a calendar month, posted to Discord as an actual picture -
// a scrapbook page, not a stat block. Reuses MovieWatchHistory /
// EpisodeWatchHistory (the same source History/Activity already read) since
// those carry title+poster; WatchActivity is deltas only, no display
// metadata - same reasoning as their own header comments in schema.sqlite.prisma.
//
// Image compositing uses Jimp, not sharp: Jimp is pure JavaScript with zero
// native bindings, which matters on this image's bun+Alpine build - sharp's
// prebuilt binaries are a real risk there (musl vs glibc, bun's optional-
// dependency resolution), Jimp has no binary to fail to resolve. Verified
// against Jimp's own v1.x test suite (composite.node.test.ts) rather than
// guessed: `new Jimp({ width, height, color })` for a blank canvas,
// `Jimp.read(buffer)`, `image.cover({ w, h })` for a crop-to-fill resize
// that doesn't squash non-2:3 posters, `canvas.composite(img, x, y)`, and
// `canvas.getBuffer('image/png')`.
//
// The month/count caption is sent as the Discord message's own text content
// (see generateAndPostMosaic), not drawn into the image - avoids depending
// on Jimp's bitmap-font plugin at all, and a caption above a picture is a
// perfectly normal Discord message shape anyway.

const { Jimp } = require('jimp')
const { monthBoundsInTimezone } = require('./dateUtils')
const { postDiscordFile } = require('./notify')

const MAX_TILES = 24
const TILE_W = 200
const TILE_H = 300
const GUTTER = 6
const BG_COLOR = 0x0d1117ff // matches the app's own dark background

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Every distinct title (movie or show) the account's users watched during
 * `yearMonth`, one entry per title (deduped across users and, for shows,
 * across episodes - the mosaic is "what did we watch," not "how many
 * episodes"), newest-watched first, capped at MAX_TILES.
 */
async function getMonthTitles(prisma, accountId, yearMonth, timeZone) {
  const { start, end } = monthBoundsInTimezone(yearMonth, timeZone)

  const [movies, episodes] = await Promise.all([
    prisma.movieWatchHistory.findMany({
      where: { accountId, watchedAt: { gte: start, lt: end } },
      select: { itemId: true, itemName: true, poster: true, watchedAt: true },
    }),
    prisma.episodeWatchHistory.findMany({
      where: { accountId, watchedAt: { gte: start, lt: end } },
      select: { showId: true, showName: true, poster: true, watchedAt: true },
    }),
  ])

  const byId = new Map()
  for (const m of movies) {
    const prev = byId.get(m.itemId)
    if (!prev || m.watchedAt > prev.watchedAt) {
      byId.set(m.itemId, { id: m.itemId, name: m.itemName, poster: m.poster, watchedAt: m.watchedAt })
    }
  }
  for (const e of episodes) {
    const prev = byId.get(e.showId)
    if (!prev || e.watchedAt > prev.watchedAt) {
      byId.set(e.showId, { id: e.showId, name: e.showName, poster: e.poster, watchedAt: e.watchedAt })
    }
  }

  return Array.from(byId.values())
    .filter((t) => t.poster)
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .slice(0, MAX_TILES)
}

async function fetchPosterTile(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const img = await Jimp.read(buf)
    img.cover({ w: TILE_W, h: TILE_H })
    return img
  } catch {
    return null
  }
}

/**
 * Fetches every title's poster and composites them into a grid PNG. Skips
 * (rather than fails) any poster that doesn't load - a mosaic missing one
 * tile beats no mosaic at all.
 */
async function buildMosaicBuffer(titles) {
  const tiles = (await Promise.all(titles.map((t) => fetchPosterTile(t.poster)))).filter(Boolean)
  if (tiles.length === 0) return null

  const cols = Math.min(6, Math.ceil(Math.sqrt(tiles.length)))
  const rows = Math.ceil(tiles.length / cols)
  const width = cols * TILE_W + (cols + 1) * GUTTER
  const height = rows * TILE_H + (rows + 1) * GUTTER

  const canvas = new Jimp({ width, height, color: BG_COLOR })
  tiles.forEach((tile, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    canvas.composite(tile, GUTTER + col * (TILE_W + GUTTER), GUTTER + row * (TILE_H + GUTTER))
  })

  return canvas.getBuffer('image/png')
}

/**
 * Builds and posts the mosaic for `yearMonth` to `webhookUrl`. Returns a
 * summary rather than throwing, so both the scheduler and the manual
 * "Generate Now" route can report/log without a try/catch of their own.
 */
async function generateAndPostMosaic(prisma, accountId, webhookUrl, yearMonth, timeZone) {
  const titles = await getMonthTitles(prisma, accountId, yearMonth, timeZone)
  if (titles.length === 0) return { posted: false, reason: 'nothing watched', count: 0 }

  const buffer = await buildMosaicBuffer(titles)
  if (!buffer) return { posted: false, reason: 'no posters resolved', count: 0 }

  const [y, m] = yearMonth.split('-').map(Number)
  const label = `${MONTH_NAMES[m - 1]} ${y}`
  const content = `**${label} — ${titles.length} title${titles.length === 1 ? '' : 's'} watched**`

  const ok = await postDiscordFile(webhookUrl, buffer, `slicksync-${yearMonth}.png`, content)
  return { posted: !!ok, reason: ok ? null : 'discord post failed', count: titles.length, month: label }
}

let mosaicTimer = null
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // matches vault monitor's cadence - a month rollover only needs catching once, no finer granularity needed

async function checkAndPostIfNewMonth(prisma, accountId) {
  try {
    const { getAccountMonthString, previousMonthString, resolveAccountTimezone } = require('./dateUtils')
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    cfg = cfg || {}
    if (cfg.notifyOnMosaic !== true || !cfg.webhookUrl) return

    const timeZone = await resolveAccountTimezone(prisma, accountId)
    const targetMonth = previousMonthString(getAccountMonthString(new Date(), timeZone))
    if (cfg.lastMosaicMonth === targetMonth) return // already handled this month

    const result = await generateAndPostMosaic(prisma, accountId, cfg.webhookUrl, targetMonth, timeZone)
    // Mark done on a real post OR a genuinely empty month - only leave it
    // unmarked (so the next 6h check retries) on an actual failure
    // (Discord unreachable, every poster fetch failed).
    if (result.posted || result.reason === 'nothing watched') {
      const nextCfg = { ...cfg, lastMosaicMonth: targetMonth }
      try {
        await prisma.appAccount.update({ where: { id: accountId }, data: { sync: nextCfg } })
      } catch {
        await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(nextCfg) } })
      }
    }
  } catch (e) {
    console.warn('[PosterMosaic] Monthly check failed:', e?.message)
  }
}

function scheduleMosaicMonitor(prisma, accountId) {
  if (mosaicTimer) clearInterval(mosaicTimer)
  checkAndPostIfNewMonth(prisma, accountId)
  mosaicTimer = setInterval(() => checkAndPostIfNewMonth(prisma, accountId), CHECK_INTERVAL_MS)
}

module.exports = { getMonthTitles, buildMosaicBuffer, generateAndPostMosaic, scheduleMosaicMonitor, MAX_TILES }
