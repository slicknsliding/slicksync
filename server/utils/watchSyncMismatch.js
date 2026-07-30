/**
 * Silent account-mismatch detector - per-title, account-wide.
 *
 * The problem it catches: a member watches on a device signed into a Stremio
 * or Nuvio account that ISN'T added to SlickSync (or is a different account
 * than the one connected). The IP-based AIOStreams proxy still sees the stream
 * (Now Playing fires), but the native pipeline only reads the libraries of
 * accounts SlickSync actually holds credentials for - so History/Watch Time
 * silently never record it. Nothing ever told the operator why (confirmed real
 * case 2026-07-29: watched Stremio under whatchudabbin@ while SlickSync had
 * SLICK STREMIO connected to slicknslidin@, plus a NuvioSLICK profile - so the
 * watch reached neither connected library).
 *
 * Why per-TITLE, not per-user: with one shared AIOStreams login across several
 * SlickSync profiles (common - e.g. a Stremio + a Nuvio profile on the same
 * email), the proxy CANNOT attribute a stream to a specific account; the login
 * resolves ambiguously to just one of them. An earlier per-user version was
 * confounded by exactly that and never fired. So instead we ask the only
 * question that has a reliable answer: did the proxy stream a title that NO
 * connected account recorded natively? Each such title is a concrete
 * "watched-but-untracked" event, and it correctly treats a title watched on a
 * genuinely-connected account (Stremio OR Nuvio) as tracked.
 *
 * This directly serves the operator's rule: any number of accounts is fine, as
 * long as each account someone watches on is added to SlickSync and its
 * history tracks - so the warning is "a streamed title isn't being recorded by
 * any connected account; add the account you watched it on."
 *
 * False-positive guards:
 *  - Only titles whose proxy activity has STABILIZED (no proxy traffic for
 *    STABILIZE_MS) are considered, so a still-playing / just-finished watch
 *    that simply hasn't checkpointed to its (connected) library yet isn't
 *    flagged prematurely.
 *  - A title counts as tracked if ANY connected account recorded it natively
 *    with a recent timestamp - across every provider - so watching on a
 *    connected Nuvio account never trips it.
 *  - usenet bypasses the proxy entirely, so it never generates a proxy row.
 */

const { createNotification } = require('./notificationStore')

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // 3 days: how far back we look at proxy activity
const STABILIZE_MS = 30 * 60 * 1000 // ignore titles still/just streaming - give them time to land natively

// Normalize a title for loose comparison: drop year and episode markers,
// lowercase, collapse to alphanumeric words. Same spirit as
// proxyNowPlaying.js's normalizeTitle - "Kingpin (1996)" and native's
// "Kingpin" both become "kingpin"; "Cape Fear S01E08 ..." becomes "cape fear".
function normalizeTitle(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bs\d{1,2}e\d{1,3}\b.*$/i, '') // strip SxxExx and everything after
    .replace(/\be\d{1,3}\b.*$/i, '') // bare Exx marker
    .replace(/\(\d{4}\)/g, '') // year in parens
    .replace(/\b(19|20)\d{2}\b/g, '') // bare year
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function checkWatchSyncMismatch(prisma, accountId, users) {
  try {
    const now = Date.now()
    const windowStart = new Date(now - WINDOW_MS)

    // Distinct proxy titles in the window, with the most recent activity per
    // title (to apply the stabilize guard) and a display name for the message.
    const proxyRows = await prisma.proxyStreamSession.findMany({
      where: { accountId, startTime: { gte: windowStart } },
      select: { displayName: true, startTime: true, lastSeenAt: true },
    })
    if (proxyRows.length === 0) return

    const byTitle = new Map() // normalized -> { display, lastActivity }
    for (const row of proxyRows) {
      const norm = normalizeTitle(row.displayName)
      if (!norm) continue
      const lastActivity = Math.max(
        row.lastSeenAt ? row.lastSeenAt.getTime() : 0,
        row.startTime ? row.startTime.getTime() : 0
      )
      const existing = byTitle.get(norm)
      if (!existing || lastActivity > existing.lastActivity) {
        byTitle.set(norm, { display: row.displayName, lastActivity })
      } else if (existing && !existing.display) {
        existing.display = row.displayName
      }
    }
    if (byTitle.size === 0) return

    // Pull recent native watches across ALL users (every provider) once, and
    // index their normalized titles - a title recorded by any connected
    // account counts as tracked.
    const [movies, episodes, sessions] = await Promise.all([
      prisma.movieWatchHistory.findMany({ where: { accountId, watchedAt: { gte: windowStart } }, select: { itemName: true } }),
      prisma.episodeWatchHistory.findMany({ where: { accountId, watchedAt: { gte: windowStart } }, select: { itemName: true } }),
      prisma.watchSession.findMany({ where: { accountId, startTime: { gte: windowStart } }, select: { itemName: true } }),
    ])
    const trackedTitles = new Set()
    for (const r of [...movies, ...episodes, ...sessions]) {
      const norm = normalizeTitle(r.itemName)
      if (norm) trackedTitles.add(norm)
    }

    // A title is "untracked" if the proxy streamed it (and it has stabilized)
    // but no connected account recorded it natively in the window.
    const untracked = [] // { dedupeKey, display }
    for (const [norm, info] of byTitle.entries()) {
      if (now - info.lastActivity < STABILIZE_MS) continue // still settling
      if (trackedTitles.has(norm)) continue // recorded by some connected account
      untracked.push({ dedupeKey: `untracked-${norm}`, display: info.display || norm })
    }

    const untrackedKeys = new Set(untracked.map((u) => u.dedupeKey))

    // Self-heal: drop any standing "untracked" notification whose title is now
    // tracked (the operator added the account and it synced) or has aged out of
    // the window entirely.
    const existing = await prisma.notification.findMany({
      where: { accountId, type: 'mismatch' },
      select: { id: true, dedupeKey: true },
    })
    const staleIds = existing.filter((n) => n.dedupeKey && !untrackedKeys.has(n.dedupeKey)).map((n) => n.id)
    if (staleIds.length > 0) {
      await prisma.notification.deleteMany({ where: { id: { in: staleIds } } }).catch(() => {})
    }

    // Raise one standing notification per untracked title.
    for (const u of untracked) {
      await createNotification(prisma, accountId, {
        type: 'mismatch',
        title: 'Playback not being tracked',
        body: `"${u.display}" was streamed but no connected account recorded it. If you watched it on a Stremio or Nuvio account that isn't added to SlickSync, add that account to track its history.`,
        url: '/users',
        dedupeKey: u.dedupeKey,
      })
    }
  } catch (e) {
    console.warn('[WatchSyncMismatch] check failed:', e?.message)
  }
}

module.exports = { checkWatchSyncMismatch }
