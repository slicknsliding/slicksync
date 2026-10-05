// One row per Jellyfin-compatible server (Jellyfin, AIOStreams, AIOMetadata)
// for the Health page. Read from what the activity monitor already recorded
// on each person - their providerConnectionError from the last pass - so the
// page makes no calls to the servers, the same as the rest of Health.
//
// - up: someone on it was read fine on the last pass
// - down: everyone on it is failing to connect (the connection alerts' own
//   test for a server outage - utils/connectionAlerts.js)
// - partial: it answers, but some people's sign-ins are rejected or failing

const { serverKeyOf } = require('./jellyfinServerCollections')

const KIND_LABELS = { jellyfin: 'Jellyfin', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }

function stateOf(person) {
  const error = person.providerConnectionError || ''
  if (!error) return 'ok'
  return /^Reconnect needed:/i.test(error) ? 'reconnect' : 'issue'
}

async function serverStatusList(prisma, accountId) {
  const people = await prisma.user.findMany({
    where: { accountId, isActive: true, providerType: 'jellyfin', jellyfinServerUrl: { not: null } },
    select: { id: true, username: true, jellyfinServerUrl: true, jellyfinServerId: true, jellyfinServerKind: true, providerConnectionError: true, providerConnectionErrorAt: true },
    orderBy: { username: 'asc' },
  })
  const { displayServer } = require('../providers/jellyfinAuth')
  const servers = new Map()
  for (const p of people) {
    const key = serverKeyOf(p)
    if (!key) continue
    if (!servers.has(key)) {
      servers.set(key, { key, kind: p.jellyfinServerKind || 'jellyfin', label: KIND_LABELS[p.jellyfinServerKind] || 'Jellyfin', address: displayServer(p.jellyfinServerUrl), people: [] })
    }
    servers.get(key).people.push({
      id: p.id,
      name: p.username || 'Someone',
      state: stateOf(p),
      error: p.providerConnectionError ? p.providerConnectionError.replace(/^(Reconnect needed|Connection issue):\s*/i, '').slice(0, 200) : null,
      since: p.providerConnectionErrorAt || null,
    })
  }
  return [...servers.values()].map((s) => {
    const failing = s.people.filter((p) => p.state !== 'ok')
    const down = s.people.length > 0 && s.people.every((p) => p.state === 'issue')
    const status = down ? 'down' : failing.length ? 'partial' : 'up'
    const since = down ? new Date(Math.min(...s.people.map((p) => new Date(p.since || Date.now()).getTime()))).toISOString() : null
    return { ...s, status, since, failingCount: failing.length }
  })
}

module.exports = { serverStatusList }
