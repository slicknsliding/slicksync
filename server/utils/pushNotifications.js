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
// Apple's web.push.apple.com validates the VAPID JWT's `sub` claim more
// strictly than Chrome/Firefox's push services do, and rejects a `.local`
// subject outright (403 BadJwtToken) — `.local` is a reserved,
// non-registrable TLD (RFC 6762), and Apple's validator apparently checks
// for a plausible domain shape rather than just "looks like an email."
// Confirmed live: iOS/Safari PWA subscriptions failed 100% of the time with
// the old default and succeeded immediately once switched to a real-shaped
// domain, while Firefox/Chrome never had a problem either way. example.com
// is IANA-reserved for documentation (RFC 2606), so it's a safe placeholder
// that still satisfies Apple's stricter check.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'

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
      // Best-effort - a device's Settings > Devices "last active" reading
      // shouldn't be able to fail the actual push send.
      prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
    } catch (err) {
      const status = err?.statusCode
      if (status === 404 || status === 410) {
        try { await prisma.pushSubscription.delete({ where: { id: sub.id } }); pruned++ } catch {}
      } else {
        // Anything else (e.g. the BadJwtToken failure that motivated this
        // log line - see VAPID_SUBJECT's comment above) used to disappear
        // silently. A subscription isn't gone here, so it's not pruned; log
        // it so a systemic failure (wrong subject, revoked VAPID keys, etc.)
        // is actually visible instead of just "push never seems to arrive."
        console.warn(`[Push] Send failed for subscription ${sub.id} (${new URL(sub.endpoint).host}): status=${status} ${err?.body || err?.message || ''}`)
      }
    }
  }
  return { sent, pruned }
}

/**
 * Toggle-aware push: sends `payload` to an account's devices only when that
 * account has the matching notification type enabled (the same
 * `notifyOnActivity` / `notifyOnSync` / `notifyOnInvite` / `notifyOnVault`
 * flags that gate the Discord notifications). Self-gating and fully
 * best-effort so notification call sites can fire it with a single line
 * without caring whether push is configured, the toggle is on, or the account
 * has any subscribed devices. Deliberately independent of whether a Discord
 * webhook is set, so phone notifications work even without Discord.
 */
async function notifyPushForType(prisma, accountId, typeKey, payload) {
  try {
    if (!accountId || !isPushEnabled()) return
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
    if (!cfg || typeof cfg !== 'object' || cfg[typeKey] !== true) return
    await sendPushToAccount(prisma, accountId, payload)
  } catch {
    // Never let a push failure disturb the Discord/bell path it rides alongside.
  }
}

module.exports = { isPushEnabled, getPublicKey, sendPushToAccount, notifyPushForType }
