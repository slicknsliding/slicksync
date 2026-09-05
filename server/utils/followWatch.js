// Follow alerts: the two "tell me when this changes" feeds.
//
//   person - an actor or director you follow; alerts when they have a NEW
//            release (TMDb credits), which is the gap between "I loved their
//            last film" and ever hearing about the next one.
//   show   - a show someone finished; alerts when TMDb's status changes
//            (renewed / canceled / a premiere date appears). The episode
//            calendar covers a show while it is airing; nothing covered the
//            wait afterwards, which is exactly when people forget.
//
// Both ride the existing notification plumbing (push + bell primary), and
// both are muteable per subject - the user asked for that explicitly, and a
// feed you cannot quiet is one people switch off entirely. A muted row is
// skipped here but kept, so the UI can still show it and un-muting restores
// the alert without losing what was already announced.
//
// Uses the account's own TMDb key (resolveKeyFromSettings, same as every
// other integration); with no key the sweep is a no-op rather than an error.

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000 // twice a day - renewals and credits are not minute-scale news
const BOOT_DELAY_MS = 5 * 60 * 1000

const STATUS_LABEL = {
  'Returning Series': 'renewed and returning',
  'In Production': 'in production',
  'Planned': 'planned',
  'Canceled': 'canceled',
  'Ended': 'ended',
}

async function tmdbGet(path, tmdbKey) {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(tmdbKey)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Show status changes: renewed, canceled, or a premiere date appearing. */
async function checkShow(prisma, accountId, row, tmdbKey) {
  const found = await tmdbGet(`/find/${encodeURIComponent(row.subjectId)}?external_source=imdb_id`, tmdbKey)
  const hit = found?.tv_results?.[0]
  if (!hit?.id) return null
  const detail = await tmdbGet(`/tv/${hit.id}`, tmdbKey)
  if (!detail?.status) return null

  // The signature is status + next air date together, so "renewed" and
  // "renewed AND now dated" are two separate pieces of news rather than one.
  const nextDate = detail.next_episode_to_air?.air_date || ''
  const signature = `${detail.status}|${nextDate}`
  if (row.lastSeen === signature) return null

  // First sight of a followed show just records where it stands - alerting
  // on the state it was already in would be noise, not news.
  if (!row.lastSeen) return { signature, silent: true }

  const label = STATUS_LABEL[detail.status] || detail.status
  const body = nextDate
    ? `${row.name} is ${label} - next episode airs ${nextDate}.`
    : `${row.name} is ${label}.`
  return { signature, title: `${row.name}: ${label}`, body, url: `/discover?q=${encodeURIComponent(row.name)}` }
}

/** New credits for a followed person. */
async function checkPerson(prisma, accountId, row, tmdbKey) {
  const credits = await tmdbGet(`/person/${encodeURIComponent(row.subjectId)}/combined_credits`, tmdbKey)
  const cast = Array.isArray(credits?.cast) ? credits.cast : []
  const crew = Array.isArray(credits?.crew) ? credits.crew : []
  const all = [...cast, ...crew]
    .filter((c) => c?.id && (c.release_date || c.first_air_date))
    .sort((a, b) => String(b.release_date || b.first_air_date).localeCompare(String(a.release_date || a.first_air_date)))
  const newest = all[0]
  if (!newest) return null

  const signature = String(newest.id)
  if (row.lastSeen === signature) return null
  if (!row.lastSeen) return { signature, silent: true }

  // Only announce something that is actually out or imminent - a credit
  // dated three years out is a listing, not news.
  const date = newest.release_date || newest.first_air_date
  const title = newest.title || newest.name
  return {
    signature,
    title: `New from ${row.name}`,
    body: `${title}${date ? ` (${String(date).slice(0, 4)})` : ''} is out.`,
    url: `/discover?q=${encodeURIComponent(title || row.name)}`,
  }
}

async function runFollowSweep(prisma, deps = {}) {
  let rows
  try {
    rows = await prisma.followedSubject.findMany({ where: { muted: false } })
  } catch {
    return // table may not exist yet on an instance mid-upgrade
  }
  if (rows.length === 0) return

  for (const row of rows) {
    try {
      const tmdbKey = await deps.resolveTmdbKeyForAccount?.(prisma, row.accountId)
      if (!tmdbKey) continue
      const result = row.kind === 'person'
        ? await checkPerson(prisma, row.accountId, row, tmdbKey)
        : await checkShow(prisma, row.accountId, row, tmdbKey)
      if (!result) {
        await prisma.followedSubject.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } }).catch(() => {})
        continue
      }
      await prisma.followedSubject.update({
        where: { id: row.id },
        data: { lastSeen: result.signature, lastCheckedAt: new Date() },
      }).catch(() => {})
      if (result.silent) continue

      const { createNotification } = require('./notificationStore')
      await createNotification(prisma, row.accountId, {
        type: 'episode',
        title: result.title,
        body: result.body,
        poster: row.poster || null,
        url: result.url,
        dedupeKey: `follow-${row.kind}-${row.subjectId}-${result.signature}`,
      }).catch(() => {})
      const { sendPushToAccount } = require('./pushNotifications')
      await sendPushToAccount(prisma, row.accountId, {
        title: result.title,
        body: result.body,
        url: result.url,
      }).catch(() => {})
    } catch (e) {
      console.warn(`[FollowWatch] check failed for ${row.kind} ${row.subjectId}:`, e?.message)
    }
  }
}

let timer = null

function scheduleFollowWatch(prisma, deps) {
  if (timer) { clearInterval(timer); timer = null }
  setTimeout(() => runFollowSweep(prisma, deps).catch(() => {}), BOOT_DELAY_MS)
  timer = setInterval(() => runFollowSweep(prisma, deps).catch(() => {}), SWEEP_INTERVAL_MS)
}

function clearFollowWatch() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { runFollowSweep, scheduleFollowWatch, clearFollowWatch }
