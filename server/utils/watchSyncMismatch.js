/**
 * Silent account-mismatch detector.
 *
 * The problem it catches: a member watches Stremio on a device signed into a
 * DIFFERENT Stremio account than the one connected to SlickSync. The IP-based
 * AIOStreams proxy still sees the stream (Now Playing fires), but the native
 * pipeline reads only the CONNECTED account's cloud library - which never
 * records those watches - so History/Watch Time stay silently empty. Nothing
 * ever told the operator why (confirmed real case 2026-07-29: watched under
 * whatchudabbin@ while SlickSync held slicknslidin@'s key).
 *
 * SlickSync can't read or even name the other account (neither Stremio nor
 * Nuvio exposes the signed-in account to the proxy/addon layer - only the
 * AIOStreams login + IP), so it can't auto-fix this. What it CAN do is detect
 * the divergence and surface it: "proxy keeps catching this user watching, but
 * their connected account logs none of it" is a dead-giveaway of a mismatched
 * account. We flag the user (badge) and raise one standing bell/push
 * notification, cleared automatically once the connected account's library
 * starts recording watches again.
 *
 * Applies to BOTH providers. The scenario is identical for Nuvio - a member
 * with two Nuvio accounts can watch on the wrong one, and the connected
 * account's library then records nothing while the IP-based proxy still sees
 * the stream. (An earlier version wrongly limited this to Stremio on the
 * assumption "Nuvio updates natively" - true only when you're on the RIGHT
 * account, which is exactly what this detects the absence of.)
 *
 * False-positive guards:
 *  - Defers to providerConnectionError: if the library FETCH is failing
 *    (expired session, network), that's a different, already-surfaced problem
 *    ("Reconnect needed"), not an account mismatch - skip so the two don't
 *    both fire for one underlying cause.
 *  - Requires >= MIN_PROXY_WATCHES *distinct* proxy titles in the window, so
 *    one watch plus a normal sync delay never trips it.
 *  - usenet bypasses the proxy entirely, so a usenet-only watcher never
 *    generates a proxy row and can't false-positive.
 */

const { resolveUserForActiveConnection } = require('./proxyStreamMonitor')
const { createNotification } = require('./notificationStore')

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
const MIN_PROXY_WATCHES = 2 // distinct proxy-detected titles before we're confident

// Human-facing provider name for the warning copy. A merged user's own
// providerType is still its primary provider, which is the account whose
// library the native pipeline reads - so this is the right one to name.
function providerLabel(user) {
  return user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'
}

async function checkWatchSyncMismatch(prisma, accountId, users) {
  try {
    const now = Date.now()
    const windowStart = new Date(now - WINDOW_MS)

    // Any user with usable library credentials (either provider). A failing
    // FETCH is handled by providerConnectionError, not here - skip those.
    const candidates = users.filter(
      (u) => !u.providerConnectionError && (u.stremioAuthKey || (u.nuvioRefreshToken && u.nuvioUserId))
    )
    if (candidates.length === 0) return

    const proxyRows = await prisma.proxyStreamSession.findMany({
      where: { accountId, startTime: { gte: windowStart } },
      select: { aiostreamsUser: true, displayName: true },
    })
    if (proxyRows.length === 0) return

    for (const user of candidates) {
      // Distinct proxy-detected titles attributed to THIS user in the window.
      // Reuses the same username/email/fallback resolution the proxy pipeline
      // itself uses, so attribution matches what Now Playing showed.
      const titles = new Set()
      for (const row of proxyRows) {
        const resolved = resolveUserForActiveConnection(users, row.aiostreamsUser)
        if (resolved && resolved.id === user.id) {
          titles.add((row.displayName || '').toLowerCase().trim())
        }
      }
      const proxyWatches = titles.size

      // Newest native watch for this user across every native table.
      const [movie, ep, sess] = await Promise.all([
        prisma.movieWatchHistory.findFirst({ where: { accountId, userId: user.id }, orderBy: { watchedAt: 'desc' }, select: { watchedAt: true } }),
        prisma.episodeWatchHistory.findFirst({ where: { accountId, userId: user.id }, orderBy: { watchedAt: 'desc' }, select: { watchedAt: true } }),
        prisma.watchSession.findFirst({ where: { accountId, userId: user.id }, orderBy: { startTime: 'desc' }, select: { startTime: true } }),
      ])
      const nativeTimes = [movie?.watchedAt, ep?.watchedAt, sess?.startTime]
        .filter(Boolean)
        .map((d) => d.getTime())
      const newestNative = nativeTimes.length ? Math.max(...nativeTimes) : 0
      const nativeStale = newestNative < windowStart.getTime()

      const mismatch = proxyWatches >= MIN_PROXY_WATCHES && nativeStale
      const label = user.username || user.email || 'This user'
      const provider = providerLabel(user)
      const dedupeKey = `mismatch-${user.id}` // one standing notification per user until resolved

      if (mismatch) {
        if (!user.watchSyncWarning) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              watchSyncWarning: `Playback detected but not syncing to the connected ${provider} account - the device may be signed into a different ${provider} account.`,
              watchSyncWarningAt: new Date(),
            },
          })
        }
        // Upsert (dedupeKey) so this is one standing notification, not a fresh
        // nag every poll while the mismatch persists.
        await createNotification(prisma, accountId, {
          type: 'mismatch',
          title: `${label}: playback not syncing`,
          body: `We're seeing live activity but the connected ${provider} account isn't logging it. The device may be signed into a different ${provider} account. Reconnect ${label} to the account you actually watch on.`,
          url: `/users/${user.id}`,
          dedupeKey,
        })
      } else if (user.watchSyncWarning && !nativeStale) {
        // Connected account caught up - self-heal: clear the flag and drop the
        // standing notification. Only clears on genuine native recovery, not
        // merely because proxy activity happened to be quiet this window.
        await prisma.user.update({
          where: { id: user.id },
          data: { watchSyncWarning: null, watchSyncWarningAt: null },
        })
        await prisma.notification.deleteMany({ where: { accountId, dedupeKey } }).catch(() => {})
      }
    }
  } catch (e) {
    console.warn('[WatchSyncMismatch] check failed:', e?.message)
  }
}

module.exports = { checkWatchSyncMismatch }
