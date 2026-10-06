// Profile pictures, kept in step between SlickSync and people's own servers.
//
// From the server: someone signed in to a Jellyfin, AIOStreams or AIOMetadata
// server usually has a picture there. When they have none of their own in
// SlickSync it is taken from the server - downloaded and kept with the
// uploaded pictures (data/avatars), so it shows wherever SlickSync does,
// whether or not the browser can reach their server. Household users
// (profiles) get theirs the same way.
//
// To the server: changing someone's picture in SlickSync can also set it on
// their server (pushPicture - the picker's "Also use it on their ..." box).
// From then on the two are in step, and a picture changed on the server later
// comes back here too. A picture chosen here without sending it is theirs and
// is never replaced from the server.
//
// What was taken or sent lives in sync.serverAvatars ({ <person id> |
// p:<profile id>: { url, hash, own? } }): `url` is the picture SlickSync shows
// while in step, `hash` the server's picture at that moment, `own` that the
// file was made here from the server's (so it can be tidied away).
//
// Where a picture is: /UserImage?userId= (Jellyfin 10.9 and later, and
// AIOMetadata), /Users/<id>/Images/Primary on older Jellyfin and on
// AIOStreams (whose /UserImage is its logo for everyone), and the picture
// each user has in /AIOStreams/Users. AIOStreams and
// AIOMetadata keep a picture as a web address their apps load, so one
// uploaded here is given to them at /trax/pictures/<file> - the same doorway
// SlickTrax uses, which a login gate in front of SlickSync lets through.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { jfRequest, authorizationHeader, deviceIdFor, restrictsPrivateAddresses } = require('../providers/jellyfinAuth')

const AVATAR_DIR = path.join(process.cwd(), 'data', 'avatars')
const MAX_BYTES = 3 * 1024 * 1024
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
const TYPE_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
// Every 2 minutes, so a picture changed on the server shows here within a
// couple of minutes. Cheap: each look is one small read of the person's
// picture tag (Jellyfin's PrimaryImageTag, which AIOStreams and AIOMetadata
// give too); the picture itself is only downloaded when the tag changes.
const INTERVAL_MS = 2 * 60 * 1000
const UPLOAD = /^\/uploads\/avatars\/([a-f0-9-]+\.(jpg|png|gif|webp))$/i
// AIOStreams keeps a configuration cached for 5 minutes, so straight after a
// picture is sent its apps can still show the old one. Nothing is taken back
// from the server for this long after sending, or the old one would return.
const SETTLE_MS = 15 * 60 * 1000

const sameId = (a, b) => String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase()
const plainId = (id) => String(id || '').replace(/-/g, '').toLowerCase()
const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

function fail(message, status = 409) {
  return Object.assign(new Error(message), { status })
}

async function readSync(prisma, accountId) {
  const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = acc?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  return { cfg: cfg && typeof cfg === 'object' ? cfg : {}, asString }
}

/** Write some pictures' records, on a fresh read. */
async function remember(prisma, accountId, records) {
  const fresh = await readSync(prisma, accountId)
  const out = { ...fresh.cfg, serverAvatars: { ...(fresh.cfg.serverAvatars || {}), ...records } }
  await prisma.appAccount.update({ where: { id: accountId }, data: { sync: fresh.asString ? JSON.stringify(out) : out } })
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
  // AIOStreams answers /UserImage with its own logo for everyone - asked
  // there, everybody would get that. Its per-user address relays the real
  // picture and says 404 when there's none.
  const paths = kind === 'aiostreams'
    ? [`/Users/${encodeURIComponent(userId)}/Images/Primary?maxWidth=256`]
    : [`/UserImage?userId=${encodeURIComponent(userId)}&maxWidth=256`, `/Users/${encodeURIComponent(userId)}/Images/Primary?maxWidth=256`]
  for (const p of paths) {
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
  const m = UPLOAD.exec(String(url || ''))
  if (!m) return
  try { fs.unlinkSync(path.join(AVATAR_DIR, m[1])) } catch { /* already gone */ }
}

/**
 * Bring one picture up to date from the server. `current` is the picture
 * shown now, `taken` the record from last time. Returns the new record, the
 * old one when nothing changed, or null when it isn't the server's to set.
 */
/**
 * The server's tag for their picture - it changes whenever the picture does -
 * or '' for none, or null when the server didn't say (then the picture
 * itself is compared).
 */
async function pictureTag({ serverUrl, token, userId }) {
  try {
    const user = await jfRequest(serverUrl, `/Users/${encodeURIComponent(userId)}`, { token, deviceId: deviceIdFor(serverUrl, userId), timeoutMs: 8000 })
    if (!user || typeof user !== 'object') return null
    return typeof user.PrimaryImageTag === 'string' ? user.PrimaryImageTag : ''
  } catch {
    return null
  }
}

async function refreshOne(source, current, taken, { tagOf = pictureTag } = {}) {
  // Chosen here and not sent to the server: theirs, so left alone.
  if (current && current !== taken?.url) return null
  // Just sent from here: the server may not show it yet.
  if (taken?.sentAt && Date.now() - Date.parse(taken.sentAt) < SETTLE_MS) return taken
  // Same tag as last time: the same picture, so nothing to download.
  const tag = await tagOf(source)
  if (tag !== null && taken && taken.tag === tag && current === taken.url) return taken
  const img = await pictureFor(source)
  if (!img) return taken ? { ...taken, tag } : null
  const hash = hashOf(img.buf)
  if (taken?.hash === hash && current === taken.url) return { ...taken, tag }
  const url = save(img)
  if (taken?.own && taken.url) forget(taken.url)
  return { url, hash, own: true, tag }
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
      if (JSON.stringify(rec) !== JSON.stringify(taken[p.id])) next[p.id] = rec
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
      if (JSON.stringify(rec) !== JSON.stringify(taken[key])) next[key] = rec
      if (rec.url !== pr.avatarUrl) { await prisma.jellyfinProfile.update({ where: { id: pr.id }, data: { avatarUrl: rec.url } }); changed++ }
    } catch (e) {
      console.warn(`[ServerAvatars] profile ${pr.id}:`, e?.message)
    }
  }
  // Written as one key, on a fresh read: the pass can take a while.
  if (Object.keys(next).length) await remember(prisma, accountId, next)
  return changed
}

// ---------------------------------------------------------------------------
// Sending a picture chosen here to their server

/** The address SlickSync is reached at from outside - the one SlickTrax links use. */
async function publicBase(prisma, accountId) {
  let base = (process.env.PUBLIC_APP_URL || '').trim()
  if (!base) {
    const { cfg } = await readSync(prisma, accountId)
    base = (typeof cfg.publicBaseUrl === 'string' && cfg.publicBaseUrl.trim()) || (typeof cfg.observedBaseUrl === 'string' && cfg.observedBaseUrl.trim()) || ''
  }
  return base.replace(/\/+$/, '')
}

/** The picture's bytes: one of SlickSync's uploads, or an image address. */
async function pictureBytes(avatarUrl) {
  const m = UPLOAD.exec(String(avatarUrl || ''))
  if (m) {
    try {
      const buf = fs.readFileSync(path.join(AVATAR_DIR, m[1]))
      return { buf, type: TYPE_BY_EXT[m[2].toLowerCase()] }
    } catch {
      return null
    }
  }
  if (/^https?:\/\//i.test(String(avatarUrl || ''))) return fetchImage(avatarUrl, {}, { checkAddress: restrictsPrivateAddresses() })
  return null
}

/** The picture as a web address an app can load: its own, or SlickSync's doorway for uploads. */
async function pictureAddress(prisma, accountId, avatarUrl) {
  if (/^https?:\/\//i.test(String(avatarUrl || ''))) return avatarUrl
  const m = UPLOAD.exec(String(avatarUrl || ''))
  if (!m) return null
  const base = await publicBase(prisma, accountId)
  if (!base) throw fail('SlickSync doesn’t know its public address yet - set it in Settings -> Sync, so their apps can load the picture.')
  return `${base}/trax/pictures/${m[1]}`
}

const PUSH_SELECT = {
  id: true, username: true, accountId: true, providerType: true, avatarUrl: true, jellyfinServerUrl: true, jellyfinServerKind: true,
  jellyfinUserId: true, jellyfinToken: true, aioConfigId: true, aioConfigPassword: true,
}

/** Who holds the configuration password for this AIOStreams or AIOMetadata person. */
async function configOwner(prisma, accountId, person) {
  if (person.aioConfigId && person.aioConfigPassword) return person
  const profile = await prisma.jellyfinProfile.findFirst({ where: { ownUserId: person.id }, select: { ownerUserId: true } })
  if (!profile) return null
  const owner = await prisma.user.findFirst({ where: { id: profile.ownerUserId, accountId }, select: PUSH_SELECT })
  return owner?.aioConfigId && owner.aioConfigPassword ? owner : null
}

/** A real Jellyfin server: upload the picture to them, or take theirs away. */
async function pushJellyfin(prisma, decrypt, accountId, person, img) {
  const token = decrypt(person.jellyfinToken, { appAccountId: accountId })
  const base = String(person.jellyfinServerUrl || '').replace(/\/+$/, '')
  const url = `${base}/UserImage?userId=${encodeURIComponent(person.jellyfinUserId)}`
  const send = async (tok) => {
    const res = await fetch(url, img
      ? { method: 'POST', headers: { Authorization: authorizationHeader({ token: tok, deviceId: deviceIdFor(person.jellyfinServerUrl, person.jellyfinUserId) }), 'Content-Type': img.type }, body: img.buf.toString('base64'), signal: AbortSignal.timeout(15000) }
      : { method: 'DELETE', headers: { Authorization: authorizationHeader({ token: tok, deviceId: deviceIdFor(person.jellyfinServerUrl, person.jellyfinUserId) }) }, signal: AbortSignal.timeout(15000) })
    return res.status
  }
  let status = await send(token)
  // Not allowed to change their own? An administrator here may.
  if (status === 401 || status === 403) {
    const ctx = await require('./jellyfinParental').adminContext(prisma, decrypt, accountId, person.id).catch(() => null)
    if (ctx?.session?.token) status = await send(ctx.session.token)
  }
  if (status === 404 && !img) return // nothing there to take away
  if (status >= 400) throw fail(`Their Jellyfin server refused the picture (${status})`)
}

/** AIOStreams: the picture's address on their user in the configuration. */
async function pushAiostreams(prisma, decrypt, accountId, person, address) {
  const owner = await configOwner(prisma, accountId, person)
  if (!owner) throw fail(`Setting ${person.username}'s picture on AIOStreams needs the configuration password - reconnect them with it.`)
  const { readConfig, writeConfig, rebaseline, noteOutsideChanges } = require('./aiostreamsConfig')
  const { personaUserId } = require('./aioHousehold')
  const access = { serverUrl: owner.jellyfinServerUrl, account: owner.aioConfigId, password: decrypt(owner.aioConfigPassword, { appAccountId: owner.accountId || accountId }) }
  const config = await readConfig(access)
  const uuid = config.uuid || owner.aioConfigId
  config.jellyfin = config.jellyfin && typeof config.jellyfin === 'object' ? config.jellyfin : {}
  let target = null
  if (plainId(person.jellyfinUserId) === plainId(uuid)) {
    config.jellyfin.primary = config.jellyfin.primary && typeof config.jellyfin.primary === 'object' ? config.jellyfin.primary : {}
    target = config.jellyfin.primary
  } else {
    target = (Array.isArray(config.jellyfin.personas) ? config.jellyfin.personas : []).find((p) => personaUserId(uuid, p.id) === plainId(person.jellyfinUserId)) || null
  }
  if (!target) throw fail(`${person.username} isn't a user in this AIOStreams configuration any more.`)
  if (address) target.avatar = address
  else delete target.avatar
  if (config.jellyfin.primary && !Object.keys(config.jellyfin.primary).length) delete config.jellyfin.primary
  try { await noteOutsideChanges(prisma, owner, await readConfig(access)) } catch { /* reported on the next look */ }
  try {
    await writeConfig(access, config)
  } catch (e) {
    throw fail(e?.message || 'AIOStreams refused the picture')
  }
  try { await rebaseline(prisma, owner, await readConfig(access)) } catch { /* the next look catches up */ }
}

/** AIOMetadata: the picture's address on the main user or their household user. */
async function pushAiometadata(prisma, decrypt, accountId, person, address) {
  const owner = await configOwner(prisma, accountId, person)
  if (!owner) throw fail(`Setting ${person.username}'s picture on AIOMetadata needs the configuration password - reconnect them with it.`)
  const aiom = require('./aiometadataHousehold')
  const access = aiom.accessFor(owner, decrypt)
  const config = await aiom.readConfig(access)
  if (plainId(person.jellyfinUserId) === plainId(access.uuid)) {
    if (address) config.jellyfinUserAvatar = address
    else delete config.jellyfinUserAvatar
  } else {
    const user = (Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []).find((u) => typeof u?.id === 'string' && aiom.userIdFor(access.uuid, u.id) === plainId(person.jellyfinUserId))
    if (!user) throw fail(`${person.username} isn't a household user in this AIOMetadata configuration any more.`)
    if (address) user.avatar = address
    else delete user.avatar
  }
  await aiom.writeConfig(access, config)
}

/**
 * Set the picture SlickSync shows for this person on their server too - or,
 * with none, take theirs away there. Afterwards the two are in step, so a
 * later change on the server comes back here. Returns { server }.
 */
async function pushPicture(prisma, decrypt, accountId, userId) {
  const person = await prisma.user.findFirst({ where: { id: userId, accountId }, select: PUSH_SELECT })
  if (!person) throw fail('User not found', 404)
  if (person.providerType !== 'jellyfin' || !person.jellyfinToken) throw fail('Only someone signed in to a Jellyfin, AIOStreams or AIOMetadata server has a picture there', 400)
  const kind = person.jellyfinServerKind || 'jellyfin'
  const img = person.avatarUrl ? await pictureBytes(person.avatarUrl) : null
  if (person.avatarUrl && !img) throw fail('That picture couldn’t be read to send it on', 400)
  if (kind === 'jellyfin') await pushJellyfin(prisma, decrypt, accountId, person, img)
  else {
    const address = person.avatarUrl ? await pictureAddress(prisma, accountId, person.avatarUrl) : null
    if (kind === 'aiostreams') await pushAiostreams(prisma, decrypt, accountId, person, address)
    else if (kind === 'aiometadata') await pushAiometadata(prisma, decrypt, accountId, person, address)
    else throw fail('That server doesn’t keep pictures', 400)
  }
  // In step from here. Jellyfin shows the new picture at once, so remember
  // its own copy; AIOStreams and AIOMetadata load it from the address they
  // were given, so remember what was sent, and when.
  let hash = img ? hashOf(img.buf) : null
  let tag
  if (kind === 'jellyfin') {
    const source = { serverUrl: person.jellyfinServerUrl, kind, token: decrypt(person.jellyfinToken, { appAccountId: accountId }), userId: person.jellyfinUserId }
    const now = await pictureFor(source).catch(() => null)
    hash = now ? hashOf(now.buf) : null
    tag = (await pictureTag(source)) ?? undefined
  }
  await remember(prisma, accountId, { [person.id]: { url: person.avatarUrl || null, hash, sentAt: new Date().toISOString(), ...(tag !== undefined ? { tag } : {}) } })
  const labels = { jellyfin: 'Jellyfin', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }
  return { server: labels[kind] || 'server' }
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

module.exports = { scheduleServerAvatars, refreshAccount, refreshOne, pictureFor, pictureTag, pushPicture, publicBase, AVATAR_DIR }
