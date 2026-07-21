/**
 * Web Push (the browser Push API) for SlickSync's PWA - lets new-episode
 * alerts arrive as native phone/desktop notifications even when SlickSync
 * isn't open.
 *
 * VAPID keys (the keypair browsers require to accept push from this server)
 * are generated once on first use and stored in data/vapid.json, which lives
 * on the same mounted volume as backups - so they persist across container
 * rebuilds with zero env/setup on the operator's part. If web-push isn't
 * installed (or generation fails), everything degrades to a no-op: push just
 * doesn't fire, and the bell/Discord alerts are unaffected.
 */

const fs = require('fs')
const path = require('path')

const VAPID_FILE = path.join(process.cwd(), 'data', 'vapid.json')
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@slicksync.local'

let webpush = null
try {
  webpush = require('web-push')
} catch {
  // web-push not installed - push disabled, handled gracefully everywhere below.
}

let cachedKeys = null

function getVapidKeys() {
  if (!webpush) return null
  if (cachedKeys) return cachedKeys
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'))
      if (parsed?.publicKey && parsed?.privateKey) {
        cachedKeys = parsed
        return cachedKeys
      }
    }
  } catch {}
  // Generate + persist a fresh pair.
  try {
    const keys = webpush.generateVAPIDKeys()
    try {
      fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true })
      fs.writeFileSync(VAPID_FILE, JSON.stringify(keys), 'utf8')
    } catch (e) {
      console.warn('[Push] Could not persist VAPID keys:', e?.message)
    }
    cachedKeys = keys
    return cachedKeys
  } catch (e) {
    console.warn('[Push] Failed to generate VAPID keys:', e?.message)
    return null
  }
}

function isPushEnabled() {
  return !!(webpush && getVapidKeys())
}

/** The public key the browser needs to subscribe. Null when push is disabled. */
function getPublicKey() {
  const keys = getVapidKeys()
  return keys?.publicKey || null
}

function configureWebPush() {
  const keys = getVapidKeys()
  if (!webpush || !keys) return false
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey)
    return true
  } catch {
    return false
  }
}

/**
 * Sends one payload to every stored subscription for an account, pruning any
 * that the push service reports as gone (404/410). Best-effort: a failure to
 * one endpoint never throws out of here.
 */
async function sendPushToAccount(prisma, accountId, payload) {
  if (!configureWebPush()) return { sent: 0, pruned: 0 }
  let subs = []
  try {
    subs = await prisma.pushSubscription.findMany({ where: { accountId } })
  } catch {
    return { sent: 0, pruned: 0 } // table may not exist yet on an older DB
  }

  const body = JSON.stringify(payload)
  let sent = 0
  let pruned = 0
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }
    try {
      await webpush.sendNotification(subscription, body)
      sent++
    } catch (err) {
      const status = err?.statusCode
      if (status === 404 || status === 410) {
        try { await prisma.pushSubscription.delete({ where: { id: sub.id } }); pruned++ } catch {}
      }
    }
  }
  return { sent, pruned }
}

module.exports = { isPushEnabled, getPublicKey, sendPushToAccount }
