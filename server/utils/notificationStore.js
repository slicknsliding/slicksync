/**
 * Persistent in-app notification store - the durable backing for the
 * notification bell (see the Notification model comment in
 * schema.sqlite.prisma for the full "why").
 *
 * The bell used to have no event store: it re-derived watch notifications live
 * from the metrics snapshot, so discrete events that push + Discord fired
 * (e.g. "started/finished watching") never produced a matching, persistent
 * bell entry. This module is the fix - every notification dispatch writes one
 * row here, so bell + push + Discord are all fed from one place.
 *
 * EpisodeAlert and AddonHealthAlert keep their own dedicated tables (they
 * predate this and already feed the bell via their own endpoints), so the
 * toggle->bell-type map below deliberately OMITS their toggles - routing them
 * through here too would show each of those notifications twice in the bell.
 */

// Maps a per-account notify toggle key to the bell category the row should
// carry. A toggle that isn't listed here gets NO generic bell row (push still
// fires as before) - that's how addon-health/episode alerts avoid a duplicate
// bell entry on top of their own dedicated tables.
const BELL_TYPE_BY_TOGGLE = {
  notifyOnActivity: 'activity',
  notifyOnSync: 'sync',
  notifyOnInvite: 'invite',
  notifyOnVault: 'vault',
  notifyOnBackup: 'task',
}

/**
 * Create one persistent bell notification. Idempotent when a dedupeKey is
 * given (a re-fire with the same key is silently ignored) - poll-driven
 * callers (e.g. the account-mismatch detector) MUST pass one; genuine
 * one-shot event callers can leave it null.
 */
async function createNotification(prisma, accountId, { type, title, body, poster = null, url = null, data = null, dedupeKey = null }) {
  if (!accountId || !type || !title) return null
  try {
    if (dedupeKey) {
      // upsert on the (accountId, dedupeKey) unique constraint so the same
      // event can never create two rows, even across restarts / re-polls.
      return await prisma.notification.upsert({
        where: { accountId_dedupeKey: { accountId, dedupeKey } },
        create: { accountId, type, title, body: body || '', poster, url, data, dedupeKey },
        // Deliberately do NOT clear read/readAt on re-fire - if the operator
        // already saw and read this exact event, a duplicate detection pass
        // shouldn't resurrect it as unread. Refresh only the display fields.
        update: { title, body: body || '', poster, url, data },
      })
    }
    return await prisma.notification.create({
      data: { accountId, type, title, body: body || '', poster, url, data },
    })
  } catch (e) {
    // Never let a bell-write failure disturb the push/Discord path it rides
    // alongside - the notification still reaches the other two channels.
    console.warn('[NotificationStore] createNotification failed:', e?.message)
    return null
  }
}

/**
 * Persist a bell row for a toggle-keyed dispatch, reusing the same
 * {title, body, icon, url} payload shape that notifyPushForType already
 * receives at every call site. Called from inside notifyPushForType so all
 * existing dispatch sites get a bell entry with no per-site change. Returns
 * without writing for toggles not in BELL_TYPE_BY_TOGGLE (see above).
 */
async function persistBellNotification(prisma, accountId, typeKey, payload) {
  const type = BELL_TYPE_BY_TOGGLE[typeKey]
  if (!type) return null
  // A generic '/android-chrome-192x192.png' icon is the push fallback, not a
  // real poster - don't store it as one, or the bell would render the app
  // icon as if it were content art.
  const poster = payload.icon && !payload.icon.includes('android-chrome') ? payload.icon : null
  return createNotification(prisma, accountId, {
    type,
    title: payload.title,
    body: payload.body,
    poster,
    url: payload.url || null,
  })
}

module.exports = { createNotification, persistBellNotification, BELL_TYPE_BY_TOGGLE }
