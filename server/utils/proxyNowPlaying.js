// Merges AIOStreams proxy-detected active streams (ProxyStreamSession) into
// a WatchSession-derived nowPlaying list. The proxy signal is authoritative
// for whether something is actually playing right now and exactly when it
// started/stopped (confirmed accurate to one ~30s poll cycle - see
// proxyStreamMonitor.js), which the WatchSession/library-poll pipeline is
// not always reliable at (see MovieWatchHistory / ProxyStreamSession schema
// comments for background on that).
//
// When a user has both an active proxy stream and a matching (same-title)
// WatchSession-derived entry, the proxy entry wins for liveness/timing but
// borrows the richer item metadata (poster, season, episode, real title)
// from the WatchSession entry when available, since ProxyStreamSession only
// has a filename-derived display name. Coverage is per-title, not per-user:
// a WatchSession entry for a DIFFERENT title than any of that user's active
// proxy rows (e.g. a usenet stream, which never routes through AIOStreams'
// proxy at all, watched while a stale/unrelated debrid proxy row is still
// active for the same user) is kept as-is, so nothing already working is
// lost.
//
// `users` must be objects with at least { id, username }. `watchSessionNowPlaying`
// entries must have a `user.id` field - callers with a differently-shaped
// list (e.g. the per-user publicLibrary.js route, which has no `user` field
// at all since it's already scoped to one user) should wrap/unwrap around
// this call - see publicLibrary.js for that pattern.
// How far back a closed proxy connection still counts as "the proxy knows
// this stream ended". Must comfortably exceed the native tracker's
// actively-watching freshness window (~18 min as of 2026-07-20, widened from
// 15min - see sessionTracker.js), since that window is exactly how long a
// native session lingers as "active" after the provider's final checkpoint.
// Kept at the same ~5min margin above that window as before (was 20 vs 15).
const RECENTLY_CLOSED_MS = 23 * 60 * 1000

// AIOStreams only bumps a connection's `lastSeen` when a new byte-range
// request actually comes in - it does NOT expire/close the connection just
// because requests stopped (confirmed real case: `lastSeen` sat 3.4s after
// `startTime` for a whole 8+ minute paused session, connection still
// `isActive` in AIOStreams the entire time).
//
// This is NOT a reliable pause detector, though - confirmed with real
// production data (2026-07-29): a fast debrid connection (TorBox) can pull
// most/all of a file through the proxy in a handful of requests within
// seconds of starting (`requestCount: 6`, `lastSeenAt` frozen 2.7s after
// `startTime`), then play on for the movie's entire runtime straight from
// the player's local buffer with zero further proxy traffic - genuinely
// still playing, indistinguishable from a real pause by request cadence
// alone. An earlier version of this file used this threshold to EXCLUDE a
// stale row from Now Playing entirely, which broke exactly that case: the
// entry vanished after ~3min of real (buffered) playback and never came
// back, even after the user resumed from an actual pause, because a
// resume-from-deep-buffer needs no new proxy request either. Do not resurrect
// that behavior - use this constant only for the softer "possibly paused"
// hint below, never to hide a still-`isActive` row.
const PAUSED_STALE_MS = 3 * 60 * 1000

async function mergeProxyNowPlaying(prisma, accountId, users, watchSessionNowPlaying) {
  let proxySessions
  let recentlyClosedSessions
  try {
    proxySessions = await prisma.proxyStreamSession.findMany({
      where: { accountId, isActive: true },
      orderBy: { startTime: 'desc' },
    })
    // Also load streams the proxy recently finished. The proxy is
    // authoritative for content it carries: if it saw a stream and that
    // stream has ended, a native "still watching" entry for the same title is
    // a stale echo (native only learns of a session when the provider writes
    // a checkpoint - at stop, for Nuvio - and then holds it "active" for its
    // whole freshness window). Suppressing those keeps an exited stream from
    // lingering in Now Playing. Content the proxy NEVER carried (e.g. usenet
    // via newznab, which bypasses the proxy entirely) has no such signal, so
    // its native entry is left alone - native is the only truth for it.
    recentlyClosedSessions = await prisma.proxyStreamSession.findMany({
      where: {
        accountId,
        isActive: false,
        endTime: { gte: new Date(Date.now() - RECENTLY_CLOSED_MS) },
      },
      orderBy: { endTime: 'desc' },
    })
  } catch (error) {
    console.warn('[ProxyNowPlaying] Failed to fetch proxy sessions:', error.message)
    return watchSessionNowPlaying
  }

  if (proxySessions.length === 0 && recentlyClosedSessions.length === 0) {
    return watchSessionNowPlaying
  }

  // Which managed user a client IP resolved to, the last time there was a
  // real signal for it (see disambiguateMatch below) - the smarter
  // tiebreaker for ambiguous same-email attributions, learned over time
  // instead of a fixed AIOSTREAMS_FALLBACK_USER_IDS order.
  let ipAffinityByIp = new Map()
  // Device claims: the admin's explicit "this IP is this person" - the
  // authoritative tier above every learned/guessed resolution below.
  let claimsByIp = new Map()
  try {
    const [affinityRows, claimRows] = await Promise.all([
      prisma.proxyUserIpAffinity.findMany({ where: { accountId } }),
      prisma.proxyDeviceClaim.findMany({ where: { accountId } }),
    ])
    ipAffinityByIp = new Map(affinityRows.map((r) => [r.clientIp, r.userId]))
    claimsByIp = new Map(claimRows.map((r) => [r.clientIp, r.userId]))
  } catch {} // tables may not exist yet on a very-first boot before db push runs

  const userByUsername = new Map(
    users.filter((u) => u.username).map((u) => [u.username.toLowerCase(), u])
  )
  // Secondary match: local-part of email (e.g. "someuser" from
  // "someuser@example.com"). Handles the common case where one AIOStreams
  // login covers multiple per-provider SlickSync profiles that share the same
  // email but have provider-specific usernames that don't match the AIOStreams
  // username at all.
  const userByEmailLocalPart = new Map(
    users
      .filter((u) => u.email && u.email.includes('@'))
      .map((u) => [u.email.split('@')[0].toLowerCase(), u])
  )
  const watchSessionByUserId = new Map(
    watchSessionNowPlaying.filter((np) => np.user && np.user.id).map((np) => [np.user.id, np])
  )

  const result = []
  // Tracks, per user, the normalized titles of proxy-covered streams - NOT
  // just which users have any active proxy row. A stale/unrelated active
  // proxy connection (AIOStreams keeps rows active up to 6h - see the
  // grouping comment below) or a debrid stream watched earlier must not
  // blank out a genuinely different, still-active WatchSession entry for
  // the same user (e.g. a usenet stream that never routes through the
  // proxy at all) - only the specific title the proxy is covering should
  // be suppressed from the WatchSession pass below.
  const coveredTitlesByUser = new Map()
  // Same idea, but for titles the proxy recently FINISHED carrying - used only
  // to suppress a native entry that's a stale echo of an already-ended stream.
  const recentlyClosedTitlesByUser = new Map()

  // Fallback: AIOStreams only has one login username, but a single person
  // can have multiple per-provider SlickSync profiles (e.g. one Stremio
  // profile, one Nuvio profile) that don't match that username at all.
  // AIOSTREAMS_FALLBACK_USER_IDS lists which SlickSync user IDs should
  // receive proxy-detected activity when the username lookup above finds
  // no match, rather than silently dropping it. Comma-separated, set in
  // this app's own .env.
  const fallbackUserIds = (process.env.AIOSTREAMS_FALLBACK_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const usersById = new Map(users.map((u) => [u.id, u]))

  // Normalizes a title for loose comparison: lowercase, strip year/parens,
  // collapse whitespace. Good enough to tell "Obsession" vs "Obsession
  // (2025)" apart from something unrelated, not meant to be exact.
  function normalizeTitle(name) {
    return (name || '')
      .toLowerCase()
      .replace(/\(\d{4}\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  }

  // When multiple SlickSync profiles match one AIOStreams login (this
  // login has no way to say which actual client/profile made the
  // request), pick a single one instead of showing the stream duplicated
  // under all of them. Prefers whichever candidate has an existing active
  // WatchSession entry whose title matches the proxy's parsed name; falls
  // back to the first candidate if no title match narrows it down.
  // Substring containment, not exact equality - the proxy's parsed
  // displayName includes episode info from the filename (e.g. "Man on
  // Fire S01E01"), while WatchSession's itemName is just the show title
  // ("Man on Fire"). These are the same show but never match via strict
  // equality, which silently broke disambiguation (confirmed with real
  // data: a correct WatchSession match existed but wasn't recognized,
  // causing a fallback to the wrong candidate).
  function titlesMatch(a, b) {
    if (!a || !b) return false
    return a.includes(b) || b.includes(a)
  }

  // Returns { user, confident }. `confident` means this resolution came from
  // real evidence (a unique match, or a title match against a live native
  // session) rather than a guess - only confident resolutions get written
  // back into ipAffinityByIp, so a guess can never reinforce itself into a
  // permanent wrong answer.
  function disambiguateMatch(candidates, proxyDisplayName, clientIp, confidentIfUnique) {
    if (candidates.length <= 1) return { user: candidates[0] || null, confident: confidentIfUnique }

    // Device claim first: a human said outright whose device this is, which
    // outranks every inference below - including the title match, whose
    // whole job is guessing what a human could simply have told us.
    // Confident, so the affinity row aligns with the claim too.
    if (clientIp) {
      const claimedUserId = claimsByIp.get(clientIp)
      if (claimedUserId) {
        const claimed = candidates.find((u) => u.id === claimedUserId)
        if (claimed) return { user: claimed, confident: true }
      }
    }

    const proxyTitle = normalizeTitle(proxyDisplayName)
    if (proxyTitle) {
      const titleMatch = candidates.find((u) => {
        const existing = watchSessionByUserId.get(u.id)
        return existing && titlesMatch(normalizeTitle(existing.item?.name), proxyTitle)
      })
      if (titleMatch) return { user: titleMatch, confident: true }
    }

    // No title-match signal available (common while a stream is mid-playback
    // and native hasn't checkpointed yet - native only writes a session at
    // pause/stop). Next best guess: which candidate this exact client IP
    // resolved to the last time there WAS a real signal - most households
    // have one device per person on a fairly stable local IP, so this beats
    // a fixed id order without needing a fresh confirmation every time.
    if (clientIp) {
      const affinityUserId = ipAffinityByIp.get(clientIp)
      if (affinityUserId) {
        const affinityMatch = candidates.find((u) => u.id === affinityUserId)
        if (affinityMatch) return { user: affinityMatch, confident: false }
      }
    }

    // No affinity learned for this IP yet either. Use the fallback list's
    // order as a last-resort tiebreaker: whichever candidate appears
    // earliest in AIOSTREAMS_FALLBACK_USER_IDS wins, rather than picking
    // candidates[0] in arbitrary database row order. Not confident - this is
    // exactly the guess the affinity tier above exists to eventually replace.
    if (fallbackUserIds.length > 0) {
      const byFallbackOrder = candidates
        .map((u) => ({ u, rank: fallbackUserIds.indexOf(u.id) }))
        .filter((c) => c.rank !== -1)
        .sort((a, b) => a.rank - b.rank)
      if (byFallbackOrder.length > 0) return { user: byFallbackOrder[0].u, confident: false }
    }

    return { user: candidates[0], confident: false }
  }

  // Group active proxy rows by normalized title before attributing them.
  // Seeking/rewinding creates a new connection (different byte-range
  // request) while the old one sometimes lingers as "active" - AIOStreams
  // keeps stale connections active up to 6h unless explicitly told the
  // request ended. Without grouping, the old and new rows for the SAME
  // real viewing session could get disambiguated to two DIFFERENT
  // profiles independently, showing as a split/duplicate entry. Grouping
  // ensures every row for one title gets the same single attribution.
  const groupedByTitle = new Map()
  for (const proxy of proxySessions) {
    const key = normalizeTitle(proxy.displayName) || proxy.url
    if (!groupedByTitle.has(key)) groupedByTitle.set(key, [])
    groupedByTitle.get(key).push(proxy)
  }

  for (const group of groupedByTitle.values()) {
    // Use the most recently active row in the group as the representative
    // for display fields (poster, displayName, liveness) - the freshest one
    // is most likely the real current connection, not a stale leftover.
    const representative = group.reduce((latest, p) =>
      p.lastSeenAt > latest.lastSeenAt ? p : latest
    )
    // Earliest startTime across the whole group is used for the reported
    // watch duration - a seek creates a new connection with a new (later)
    // startTime, and using the representative's own startTime alone would
    // make "Watching for Xm" reset toward 0 after every seek instead of
    // counting continuously from when viewing actually began. The
    // representative's own startTime is kept too (lastConnectionStartTime,
    // below) rather than discarded, in case a future UI wants to show
    // something like "resumed 2m ago" alongside the total duration.
    const earliestStartTime = group.reduce((earliest, p) =>
      p.startTime < earliest ? p.startTime : earliest
    , representative.startTime)

    // Most recent poll cycle that reconfirmed ANY connection in this group is
    // still in AIOStreams' own active-connection list - see the elapsedSeconds
    // comment below for why this, not lastSeenAt, is the freeze basis.
    const mostRecentPollConfirmation = group.reduce((latest, p) =>
      p.updatedAt > latest ? p.updatedAt : latest
    , representative.updatedAt)

    let candidates = []
    // True only when `candidates` came from a genuinely unique match
    // (username or email), not an arbitrary configured list - a fallback
    // list that happens to resolve to exactly one valid id is still just a
    // guess, not evidence, and must not be recorded as confirmed affinity.
    let candidatesAreRealMatch = false
    const aiostreamsUserLower = (representative.aiostreamsUser || '').toLowerCase()
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)

    if (directMatch) {
      candidates = [directMatch]
      candidatesAreRealMatch = true
    } else if (emailMatch) {
      // One AIOStreams login, multiple per-provider profiles sharing an
      // email - matched by email local-part rather than username.
      candidates = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
      candidatesAreRealMatch = true
    } else if (fallbackUserIds.length > 0) {
      candidates = fallbackUserIds
        .map((id) => usersById.get(id))
        .filter(Boolean)
    }

    if (candidates.length === 0) continue // no direct match and no usable fallback - skip rather than guess

    const { user, confident } = disambiguateMatch(candidates, representative.displayName, representative.clientIp, candidatesAreRealMatch)
    if (!user) continue

    // Learn from this resolution for next time - only when it's real
    // evidence, not a guess (see disambiguateMatch's own comment on why).
    if (confident && representative.clientIp) {
      // Checked against ipAffinityByIp's initial snapshot (loaded once above,
      // before this loop) - an IP this account has never confidently
      // resolved before, for ANY user, streaming for the first time. Fired
      // BEFORE the upsert below (which would otherwise make every later
      // check in this same poll see it as already-known) and the map is
      // updated immediately after so a second representative sharing this
      // IP later in the same poll doesn't fire twice.
      if (!ipAffinityByIp.has(representative.clientIp)) {
        ipAffinityByIp.set(representative.clientIp, user.id)
        notifyNewDevice(prisma, accountId, user, representative.clientIp).catch(() => {})
      }
      prisma.proxyUserIpAffinity.upsert({
        where: { accountId_clientIp: { accountId, clientIp: representative.clientIp } },
        create: { accountId, clientIp: representative.clientIp, userId: user.id },
        update: { userId: user.id, confirmedAt: new Date() },
      }).catch(() => {}) // best-effort, never blocks building the Now Playing list
    }

    if (!coveredTitlesByUser.has(user.id)) coveredTitlesByUser.set(user.id, new Set())
    coveredTitlesByUser.get(user.id).add(normalizeTitle(representative.displayName))
    const existing = watchSessionByUserId.get(user.id)
    // Only borrow the existing WatchSession's item/videoId if it's actually
    // about the same title the proxy detected - an existing session for
    // this user that's about something else entirely (a real, unrelated,
    // still-active session) must not be shown as if it were the proxied
    // content. User identity (avatar/username/email) is unaffected by this
    // check - that's about the person, not the content.
    const existingTitleMatches = existing &&
      titlesMatch(normalizeTitle(existing.item?.name), normalizeTitle(representative.displayName))

    result.push({
      user: existing?.user ?? {
        id: user.id,
        username: user.username || user.email,
        email: user.email,
        colorIndex: user.colorIndex || 0,
        avatarUrl: user.avatarUrl || null,
        useGravatar: user.useGravatar ?? false,
      },
      item: existingTitleMatches ? existing.item : {
        id: null,
        name: representative.displayName || representative.filename || 'Unknown',
        type: null,
        year: null,
        poster: representative.posterUrl || null,
        season: null,
        episode: null,
      },
      videoId: existingTitleMatches ? existing.videoId : null,
      // Same borrow-if-same-title rule as item/videoId above - the proxy
      // itself has no semantic playback position (it only sees byte-range
      // requests), so this is native's data riding along on the proxy's
      // liveness signal, not something the proxy actually knows.
      lastPosition: existingTitleMatches ? (existing.lastPosition ?? null) : null,
      totalDuration: existingTitleMatches ? (existing.totalDuration ?? null) : null,
      ...(existingTitleMatches && existing.stremioAppUrl ? { stremioAppUrl: existing.stremioAppUrl, nuvioAppUrl: existing.nuvioAppUrl } : {}),
      // Proxy startTime/liveness is the authoritative signal here, not
      // whatever the WatchSession entry (if any) happened to record.
      watchedAt: earliestStartTime.toISOString(),
      watchedAtTimestamp: earliestStartTime.getTime(),
      startTime: earliestStartTime,
      // Most recent connection's own start time (e.g. when the last seek
      // happened) - kept separately, not used for duration display.
      lastConnectionStartTime: representative.startTime.toISOString(),
      // A "possibly paused" label was tried here and pulled (2026-07-29,
      // same day) - confirmed against real usage that a fast debrid
      // connection (TorBox) routinely front-loads an entire file within
      // seconds, so the request-cadence signal it was based on reads as
      // "stale" for nearly this account's ENTIRE runtime on every normal
      // play, not just real pauses. A label that's wrong by default is
      // worse than no label - removed rather than left showing a
      // confidently incorrect guess.
      lastActivityAt: representative.lastSeenAt.toISOString(),
      lastActivityAtTimestamp: representative.lastSeenAt.getTime(),
      // Elapsed time we can actually stand behind, in seconds - real
      // wall-clock elapsed while the connection is confirmed live, but
      // frozen once we can no longer confirm that rather than continuing to
      // climb off raw wall-clock forever (same root cause as the label
      // above: no way to confirm real activity once requests stop; the
      // honest fix for a NUMBER is to stop advancing it, not to keep
      // incrementing a figure we can no longer vouch for - confirmed real
      // case: a session showed "Watching for 49m" and climbing well after
      // the stream had already been exited, so proxy startTime alone is not
      // a safe basis for an ever-increasing duration display).
      //
      // The freeze basis is mostRecentPollConfirmation (this row's updatedAt,
      // bumped every ~30s poll cycle for as long as AIOStreams' OWN stats
      // still list the connection as active), NOT lastSeenAt (the last
      // actual application-level request). Confirmed real case 2026-07-30: a
      // StremThru/TorBox 4K stream hit lastSeenAt exactly once, ~0.8s after
      // startTime (3 requests, then the player streamed the rest of a
      // 20+ minute watch straight from TorBox's own CDN with zero further
      // proxy traffic) - lastSeenAt froze the display at "~3m" for the
      // entire watch despite proxyStreamMonitor.js's own 30s poll
      // continuing to confirm, cycle after cycle, that AIOStreams still had
      // this exact connection open. updatedAt reflects that ongoing
      // reconfirmation; lastSeenAt only reflects request cadence, which this
      // debrid pattern has none of after the first second. This still can't
      // reintroduce the "climbing after exit" bug above: the moment
      // AIOStreams actually drops the connection, proxyStreamMonitor.js
      // stops touching the row (see toClose in that file), updatedAt stops
      // advancing right along with it, and the row is closed outright
      // shortly after - same safety property as before, just anchored to a
      // signal that doesn't go stale within the first second of a fast
      // debrid stream.
      elapsedSeconds: Math.max(0, Math.floor(
        (Math.min(Date.now(), mostRecentPollConfirmation.getTime() + PAUSED_STALE_MS) - earliestStartTime.getTime()) / 1000
      )),
      // True once elapsedSeconds above has stopped advancing (no poll
      // reconfirmation for PAUSED_STALE_MS) - lets the UI stop ticking a
      // frozen number live instead of implying it's still counting up.
      elapsedFrozen: (Date.now() - mostRecentPollConfirmation.getTime()) > PAUSED_STALE_MS,
      source: 'aiostreams-proxy',
    })
  }

  // Titles the proxy recently FINISHED carrying, per user. A native entry for
  // one of these is a stale echo of a stream the proxy knows already ended -
  // drop it so an exited stream doesn't linger in Now Playing for the length
  // of native's freshness window.
  for (const closed of recentlyClosedSessions) {
    const aiostreamsUserLower = (closed.aiostreamsUser || '').toLowerCase()
    let candidates = []
    const directMatch = userByUsername.get(aiostreamsUserLower)
    const emailMatch = userByEmailLocalPart.get(aiostreamsUserLower)
    if (directMatch) {
      candidates = [directMatch]
    } else if (emailMatch) {
      candidates = users.filter(
        (u) => u.email && u.email.split('@')[0].toLowerCase() === aiostreamsUserLower
      )
    } else if (fallbackUserIds.length > 0) {
      candidates = fallbackUserIds.map((id) => usersById.get(id)).filter(Boolean)
    }
    // A closed stream can't be disambiguated by a live title match, so mark
    // the title as recently-carried for every candidate this login maps to.
    // That's deliberate: it only ever suppresses a native entry for THAT
    // exact title, which the proxy has confirmed ended.
    for (const candidate of candidates) {
      if (!recentlyClosedTitlesByUser.has(candidate.id)) recentlyClosedTitlesByUser.set(candidate.id, new Set())
      recentlyClosedTitlesByUser.get(candidate.id).add(normalizeTitle(closed.displayName))
    }
  }

  for (const np of watchSessionNowPlaying) {
    const uid = np.user && np.user.id
    const npTitle = normalizeTitle(np.item?.name)
    const activeTitles = uid ? coveredTitlesByUser.get(uid) : null
    const endedTitles = uid ? recentlyClosedTitlesByUser.get(uid) : null

    // Superseded when the proxy is currently carrying this title (the proxy
    // entry above replaces it), or recently finished carrying it (stale echo).
    const matches = (titles) =>
      !!titles && !!npTitle && Array.from(titles).some((t) => titlesMatch(t, npTitle))
    const isSuperseded = matches(activeTitles) || matches(endedTitles)
    if (!isSuperseded) result.push(np)
  }

  return result
}

// New-device alert - same push+bell pattern as every other notifyOn* type
// (see pushNotifications.js's notifyPushForType), gated on its own
// 'notifyOnNewDevice' toggle. Fires the first time this account's proxy
// pipeline confidently resolves a clientIp it's never seen before to a
// user - see the call site's comment for exactly what "confident" and
// "never seen before" mean here.
async function notifyNewDevice(prisma, accountId, user, clientIp) {
  try {
    const { notifyPushForType } = require('./pushNotifications')
    await notifyPushForType(prisma, accountId, 'notifyOnNewDevice', {
      title: '📱 New device detected',
      body: `${user.username || 'A user'}'s stream was just seen from an IP we haven't confirmed before (${clientIp}) - worth checking if that's expected.`,
      icon: '/android-chrome-192x192.png',
      url: `/users/${user.id}`,
    })
  } catch {}
}

module.exports = { mergeProxyNowPlaying }
