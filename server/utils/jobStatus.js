// What the background jobs have been up to, kept in memory for the Settings ->
// Maintenance "Background jobs" list: when each last ran and whether it went
// well. Nothing is stored - after a restart the list fills in as the jobs run
// again - and nothing here can disturb a job: noteRun never throws.

const LABELS = {
  scheduledSync: 'Scheduled sync',
  accountGuard: 'Account Guard',
  vaultChecks: 'Vault checks',
  aiostreams: 'AIOStreams and Live TV',
  addonHealth: 'Addon health',
  backups: 'Backups',
  followWatch: 'Follow watch',
  activityMonitor: 'Activity monitor',
}

const MAX_MESSAGE = 140
const jobs = new Map()

// Keep a reason readable and safe to show: no addresses (they can carry a
// key in the path or query), no long token-looking strings, one short line.
function scrub(message) {
  if (message == null) return null
  let text = String(message)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, 'an address')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1).trimEnd() + '…'
  return text
}

/** Call at the end of a job's pass. `ok: false` marks it as needing a look. */
function noteRun(name, { ok = true, message = null } = {}) {
  try {
    if (!name || typeof name !== 'string') return
    jobs.set(name, { name, ok: ok !== false, at: Date.now(), message: ok === false ? scrub(message) : null })
  } catch { /* never disturb the job */ }
}

/** Every job that has run since the server started, in a steady order. */
function listJobs() {
  const order = Object.keys(LABELS)
  return [...jobs.values()]
    .sort((a, b) => {
      const ia = order.indexOf(a.name), ib = order.indexOf(b.name)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map((j) => ({ name: j.name, label: LABELS[j.name] || j.name, ok: j.ok, lastRunAt: new Date(j.at).toISOString(), message: j.message }))
}

function reset() { jobs.clear() }

module.exports = { noteRun, listJobs, scrub, _test: { reset, LABELS } }
