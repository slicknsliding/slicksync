// Trakt one-time migration import - "leave Trakt in one click" for the
// biggest reason anyone stays on it: their own history is stuck there.
//
// CSV import (csvHistoryImport.js) already exists for IMDb/Letterboxd, but
// that same file's own comment documents why Trakt itself is excluded from
// it: "Trakt has no single stable CSV format at all (VIP-gated, and
// confirmed inconsistent even among Trakt's own users)". The only reliable
// way to get a Trakt user's real data out is Trakt's own API, not a CSV
// export that may not even be available on their plan.
//
// OAuth Device Code flow (no redirect URI, unlike Authorization Code -
// nothing to host, nothing to configure per-deployment beyond a client
// id/secret registered once by whoever runs this instance). Verified
// against Trakt's own current API source (github.com/trakt/trakt-api,
// projects/api/src/contracts/oauth and .../sync) rather than assumed:
//
//   POST https://auth.trakt.tv/oauth/device/code   {client_id}
//     -> {device_code, user_code, verification_url, expires_in, interval}
//   POST https://auth.trakt.tv/oauth/device/token  {code, client_id, client_secret}
//     -> 200 with the access token once the user has approved it at
//        verification_url, 400 while still pending, 404/410/418/429 for the
//        other documented device-flow states.
//
// The access/refresh tokens are used for exactly one pull and then
// discarded - nothing is persisted, matching "connect once, then
// disconnects." A user who wants to re-import later just reconnects.
//
// Data pull reuses the EXACT same Prisma write calls the CSV importer uses
// (movieWatchHistory.upsert / titleRating.upsert) rather than a parallel
// write path, and inherits its scope: movies only, matching what CSV import
// already does and why (episode/season history has no equivalent write path
// yet in this codebase - out of scope for either importer today, not a new
// limitation this one introduces).

const AUTH_BASE = 'https://auth.trakt.tv';
const API_BASE = 'https://api.trakt.tv';
const FETCH_TIMEOUT_MS = 15000;
const MAX_HISTORY_ITEMS = 5000; // generous but bounded, same spirit as csvHistoryImport's MAX_ROWS

function traktConfigured() {
  return !!(process.env.TRAKT_CLIENT_ID && process.env.TRAKT_CLIENT_SECRET);
}

async function timedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1: request a device code. Call once per import attempt. */
async function startDeviceAuth() {
  if (!traktConfigured()) {
    const err = new Error('Trakt import is not configured on this instance (TRAKT_CLIENT_ID/TRAKT_CLIENT_SECRET unset)');
    err.notConfigured = true;
    throw err;
  }
  const res = await timedFetch(`${AUTH_BASE}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.TRAKT_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`Trakt device code request failed (${res.status})`);
  const body = await res.json();
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

/**
 * Step 2: poll for the token. Trakt's own documented device-flow responses:
 * 200 = approved (token in body), 400 = still pending (not an error, just
 * "keep polling"), 404 = invalid device_code, 409 = already used, 410 =
 * expired, 418 = user explicitly denied it, 429 = polling too fast.
 * Returns {status: 'pending'|'approved'|'denied'|'expired'|'error', token?}.
 */
async function pollDeviceToken(deviceCode) {
  const res = await timedFetch(`${AUTH_BASE}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: deviceCode,
      client_id: process.env.TRAKT_CLIENT_ID,
      client_secret: process.env.TRAKT_CLIENT_SECRET,
    }),
  });
  if (res.status === 200) {
    const body = await res.json();
    return { status: 'approved', accessToken: body.access_token };
  }
  if (res.status === 400) return { status: 'pending' };
  if (res.status === 418) return { status: 'denied' };
  if (res.status === 410 || res.status === 404) return { status: 'expired' };
  if (res.status === 409) return { status: 'expired', message: 'This code was already used' };
  if (res.status === 429) return { status: 'pending' }; // back off, caller's own interval already paces this
  return { status: 'error', message: `Trakt returned ${res.status}` };
}

function traktHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': process.env.TRAKT_CLIENT_ID,
    Authorization: `Bearer ${accessToken}`,
  };
}

/** Movies only from /sync/history - see the file header for why. */
async function fetchTraktMovieHistory(accessToken) {
  const res = await timedFetch(`${API_BASE}/sync/history/movies?limit=${MAX_HISTORY_ITEMS}`, {
    headers: traktHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`Failed to fetch Trakt history (${res.status})`);
  return res.json();
}

async function fetchTraktMovieRatings(accessToken) {
  const res = await timedFetch(`${API_BASE}/sync/ratings/movies`, { headers: traktHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to fetch Trakt ratings (${res.status})`);
  return res.json();
}

/**
 * Full pull-and-write for one user. Same upsert calls csvHistoryImport's
 * route uses, so a Trakt-imported item behaves identically to a CSV-
 * imported one everywhere else in the app (never overwrites a native
 * record, same 'Imported' profileLabel).
 */
async function importTraktData(prisma, accountId, userId, accessToken) {
  const { resolveSinglePoster } = require('./libraryHelpers');

  const [history, ratings] = await Promise.all([
    fetchTraktMovieHistory(accessToken),
    fetchTraktMovieRatings(accessToken).catch(() => []), // ratings are a bonus, never fail the whole import over them
  ]);

  const ratingByImdbId = new Map();
  for (const r of ratings) {
    const imdbId = r?.movie?.ids?.imdb;
    if (imdbId && Number.isFinite(r.rating)) ratingByImdbId.set(imdbId, r.rating);
  }

  // Dedupe by imdb id - Trakt's history is one row PER PLAY, so a rewatched
  // movie appears multiple times; the write target (movieWatchHistory) is
  // one row per title, same as the CSV importer's own behavior, so only the
  // most recent watched_at per title is kept.
  const latestByImdbId = new Map();
  for (const entry of history) {
    const imdbId = entry?.movie?.ids?.imdb;
    if (!imdbId) continue;
    const watchedAt = entry.watched_at ? new Date(entry.watched_at) : new Date();
    const existing = latestByImdbId.get(imdbId);
    if (!existing || watchedAt > existing.watchedAt) {
      latestByImdbId.set(imdbId, { watchedAt, title: entry.movie?.title || imdbId });
    }
  }

  let imported = 0;
  let skipped = 0;

  for (const [imdbId, { watchedAt, title }] of latestByImdbId) {
    try {
      const poster = await resolveSinglePoster(imdbId, 'movie', null);
      await prisma.movieWatchHistory.upsert({
        where: { accountId_userId_itemId: { accountId, userId, itemId: imdbId } },
        create: { accountId, userId, itemId: imdbId, itemName: title, poster, profileLabel: 'Imported', completed: true, watchedAt },
        update: {}, // never overwrite an existing native record with an imported one
      });
      const rating = ratingByImdbId.get(imdbId);
      if (rating) {
        await prisma.titleRating.upsert({
          where: { accountId_itemId_season: { accountId, itemId: imdbId, season: 0 } },
          create: { accountId, itemId: imdbId, itemType: 'movie', season: 0, rating, itemName: title },
          update: {},
        }).catch(() => {});
      }
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped, totalFromTrakt: latestByImdbId.size };
}

module.exports = {
  traktConfigured,
  startDeviceAuth,
  pollDeviceToken,
  importTraktData,
};
