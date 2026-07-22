/**
 * Cross-user library-sync dedup.
 *
 * Problem: when two users on the same account share a Stremio identity
 * (same email — the Nuvio-only account is still signed into Stremio's
 * cloud), Stremio's server-side library replicates watch state to BOTH
 * accounts. The metrics poller then writes per-user rows for a single
 * real play. That single play then shows up:
 *  - twice in the Activity feed, under two provider badges
 *  - twice in per-user stat totals (Watch Time, Content Breakdown)
 *  - twice in Top Viewers / leaderboard sums
 *
 * Two household members using SEPARATE email addresses genuinely watching
 * the same movie shouldn't be affected — the shared-email restriction is
 * what distinguishes a phantom from a real independent watch. Different
 * emails → each user's stats stand on their own.
 *
 * All exports are pure — they take rows in, return filtered rows.
 */

/**
 * Build the set of userIds that are "phantom-eligible": every user whose
 * email is shared by at least one OTHER user on the same account. Case-
 * insensitive, blank-email users are never phantom-eligible.
 *
 * @param {Array<{id: string, email?: string|null}>} users
 * @returns {Set<string>} userIds that share their email with another user
 */
function findSharedEmailUserIds(users) {
  const byEmail = new Map()
  for (const u of users) {
    const email = (u.email || '').trim().toLowerCase()
    if (!email) continue
    if (!byEmail.has(email)) byEmail.set(email, [])
    byEmail.get(email).push(u.id)
  }
  const shared = new Set()
  for (const ids of byEmail.values()) {
    if (ids.length > 1) for (const id of ids) shared.add(id)
  }
  return shared
}

/**
 * Given per-poll WatchActivity-style rows (`{ userId, itemId, date,
 * watchTimeSeconds, ... }`), collapse cross-user duplicates that arose
 * from library sync between shared-email accounts. For each
 * (itemId, date-bucket), if MULTIPLE shared-email users have rows, keep
 * only the one whose SUMMED watchTimeSeconds is highest — that user is
 * the one who actually played it. Rows from users NOT in the shared-email
 * set are always kept.
 *
 * date is normalized to a UTC day string so mid-day rows from independent
 * polls of the same play land in the same bucket.
 *
 * @param {Array<{userId: string, itemId: string, date: Date|string, watchTimeSeconds: number}>} rows
 * @param {Set<string>} sharedEmailUserIds  from findSharedEmailUserIds
 */
function dedupWatchActivityBySharedEmail(rows, sharedEmailUserIds) {
  if (!sharedEmailUserIds || sharedEmailUserIds.size === 0) return rows

  // Group by (itemId, day-bucket) and separate shared-email rows from the
  // rest. Only the shared-email group needs a decision; unshared users
  // pass through untouched.
  const dayKey = (r) => {
    const d = new Date(r.date)
    return `${r.itemId}::${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
  }
  const groups = new Map()
  for (const r of rows) {
    const k = dayKey(r)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }

  const kept = []
  for (const group of groups.values()) {
    // Split into shared-email rows vs the rest.
    const shared = group.filter((r) => sharedEmailUserIds.has(r.userId))
    const rest = group.filter((r) => !sharedEmailUserIds.has(r.userId))
    kept.push(...rest)

    if (shared.length === 0) continue

    // Sum shared-email rows per user; keep only the user with the max sum.
    const sums = new Map()
    for (const r of shared) sums.set(r.userId, (sums.get(r.userId) || 0) + (r.watchTimeSeconds || 0))
    let winner = null
    let winnerSum = -1
    for (const [uid, s] of sums) {
      if (s > winnerSum) { winner = uid; winnerSum = s }
    }
    for (const r of shared) if (r.userId === winner) kept.push(r)
  }

  return kept
}

module.exports = { findSharedEmailUserIds, dedupWatchActivityBySharedEmail }
