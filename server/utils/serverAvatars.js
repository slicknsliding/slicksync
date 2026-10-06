// Profile pictures from people's own servers.
//
// Someone signed in to a Jellyfin, AIOStreams or AIOMetadata server usually
// has a picture there. When they have none of their own in SlickSync, it is
// taken from the server: downloaded once and kept with the uploaded pictures
// (data/avatars), so it shows wherever SlickSync does - whether or not the
// browser can reach their server. A picture chosen in SlickSync is never
// replaced; one taken from the server follows it when it changes there.
// Household users (profiles) get theirs the same way.
//
// Where a picture is: /UserImage?userId= (Jellyfin 10.9 and later, and
// AIOMetadata), /Users/<id>/Images/Primary on older Jellyfin, and on
// AIOStreams the picture each user has in /AIOStreams/Users.
//
// What was taken lives in sync.serverAvatars ({ <person id> | p:<profile id>:
// { url, hash } }), so a picture changed by hand is recognised as theirs.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { jfRequest, authorizationHeader, deviceIdFor, restrictsPrivateAddresses } = require('../providers/jellyfinAuth')

const AVATAR_DIR = path.join(process.cwd(), 'data', 'avatars')
const MAX_BYTES = 3 * 1024 * 1024
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
const INTERVAL_MS = 12 * 60 * 60 * 1000

const sameId = (a, b) => String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase()

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/** An image at `url`, or null: not an image, too big, or not there. */
async function fetchImage(url, headers = {}, { checkAddress = false } = {}) {
  try {
    if (checkAddress) {
      const { assertSafeUrl } = require('./safeUrl')
      await assertSafeUrl(url)
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'follow' })
    if (!res.ok) return null
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!EXT_BY_TYPE[type]) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null
    return { buf, type }
  } catch {
    return null
  }
}

/** Someone's picture on their server, or null. */
async function pictureFor({ serverUrl, kind, token, userId }) {
  const base = String(serverUrl || '').replace(/\/+$/, '')
  if (!base || !userId || !token) return null
  const deviceId = deviceIdFor(serverUrl, userId)
  const headers = { Authorization: authorizationHeader({ token, deviceId }) }
  const checkAddress = restrictsPrivateAddresses()
  for (const p of [`/UserImage?userId=${encodeURIComponent(userId)}&maxWidth=256`, `/Users/${encodeURIComponent(userId)}/Images/Primary?maxWidth=256`]) {
    const img = await fetchImage(`${base}${p}`, headers, { checkAddress })
    if (img) return img
  }
  if (kind && kind !== 'jellyfin') {
    // AIOStreams keeps each user's picture as a web address of its own.
    const users = await jfRequest(serverUrl, '/AIOStreams/Users', { token, deviceId }).catch(() => null)
    const me = (Array.isArray(users) ? users : []).find((u) => sameId(u?.user?.Id, userId))
    if (me?.avatar && /^https?:\/\//i.test(me.avatar)) return fetchImage(me.avatar, {}, { checkAddress })
  }
  return null
}

function save(img) {
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true })
  const filename = `${crypto.randomUUID()}${EXT_BY_TYPE[img.type]}`
  fs.writeFileSync(path.join(AVATAR_DIR, filename), img.buf)
  return `/uploads/avatars/${filename}`
}

function forget(url) {
  const m = /^\/uploads\/avatars\/([a-f0-9-]+\.(?:jpg|png|gif|webp))$/i.exec(String(url || ''))
  if (!m) return
  try { fs.unlinkSync(path.join(AVATAR_DIR, m[1])) } catch { /* already gone */ }
}

/**
 * Bring one picture up to date. `current` is the picture shown now, `taken`
 * what SlickSync took last time. Returns the new { url, hash } record, the
 * old one when nothing changed, or null when it isn't ours to set.
 */
async function refreshOne(source, current, taken) {
  // Theirs: chosen in SlickSync, so left alone.
  if (current && current !== taken?.url) return null
  const img = await pictureFor(source)
  if (!img) return taken || null
  const hash = crypto.createHash('sha1').update(img.buf).digest('hex')
  if (taken?.hash === hash && current === taken.url) return taken
  const url = save(img)
  if (taken?.url) forget(taken.url)
  return { url, hash }
}

async function refreshAccount(prisma, decrypt, accountId) {
  const people = await prisma.user.findMany({
    where: { accountId, providerType: 'jellyfin', isActive: true, jellyfinToken: { not: null } },
    select: { id: true, avatarUrl: true, useGravatar: true, jellyfinServerUrl: true, jellyfinServerKind: true, jellyfinUserId: true, jellyfinToken: true },
  })
  const profiles = await prisma.jellyfinProfile.findMany({
    where: { accountId, ownUserId: null, token: { not: null } },
    select: { id: true, ownerUserId: true, jellyfinUserId: true, token: true, avatarUrl: true },
  }).catch(() => [])
  if (!people.length && !profiles.length) return 0
  const { cfg } = await readSync(prisma, accountId)
  const taken = cfg.serverAvatars && typeof cfg.serverAvatars === 'object' ? cfg.serverAvatars : {}
  const next = {}
  let changed = 0
  const tokenOf = (enc) => { try { return decrypt(enc, { appAccountId: accountId }) } catch { return null } }

  for (const p of people) {
    if (p.useGravatar) continue
    try {
      const rec = await refreshOne({ serverUrl: p.jellyfinServerUrl, kind: p.jellyfinServerKind, token: tokenOf(p.jellyfinToken), userId: p.jellyfinUserId }, p.avatarUrl, taken[p.id])
      if (!rec) continue
      next[p.id] = rec
      if (rec.url !== p.avatarUrl) { await prisma.user.update({ where: { id: p.id }, data: { avatarUrl: rec.url } }); changed++ }
    } catch (e) {
      console.warn(`[ServerAvatars] ${p.id}:`, e?.message)
    }
  }
  const owners = new Map(people.map((p) => [p.id, p]))
  for (const pr of profiles) {
    const owner = owners.get(pr.ownerUserId)
    if (!owner) continue
    const key = `p:${pr.id}`
    try {
      const rec = await refreshOne({ serverUrl: owner.jellyfinServerUrl, kind: owner.jellyfinServerKind, token: tokenOf(pr.token), userId: pr.jellyfinUserId }, pr.avatarUrl, taken[key])
      if (!rec) continue
      next[key] = rec
      if (rec.url !== pr.avatarUrl) { await prisma.jellyfinProfile.update({ where: { id: pr.id }, data: { avatarUrl: rec.url } }); changed++ }
    } catch (e) {
      console.warn(`[ServerAvatars] profile ${pr.id}:`, e?.message)
    }
  }

  // Written as one key, on a fresh read: the pass can take a while.
  const fresh = await readSync(prisma, accountId)
  const merged = { ...(fresh.cfg.serverAvatars || {}), ...next }
  const out = { ...fresh.cfg, serverAvatars: merged }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: fresh.asString ? JSON.stringify(out) : out } })
  return changed
}

async function refreshAll(prisma, decrypt) {
  const accounts = await prisma.appAccount.findMany({ select: { id: true } })
  for (const acc of accounts) {
    try {
      const n = await refreshAccount(prisma, decrypt, acc.id)
      if (n) console.log(`[ServerAvatars] ${n} picture(s) taken from people's servers`)
    } catch (e) {
      console.warn('[ServerAvatars] account failed:', e?.message)
    }
  }
}

let timer = null
function scheduleServerAvatars(prisma, decrypt) {
  if (timer) clearInterval(timer)
  const run = () => refreshAll(prisma, decrypt).catch((e) => console.warn('[ServerAvatars] pass failed:', e?.message))
  setTimeout(run, 6 * 60 * 1000)
  timer = setInterval(run, INTERVAL_MS)
}

module.exports = { scheduleServerAvatars, refreshAccount, refreshOne, pictureFor }
