// The devices signed in as someone on a real Jellyfin server, and signing one
// out - an old TV, one at a friend's. Shown on that person's page.
//
// Jellyfin keeps this list (and lets a device be signed out) for
// administrators only, so it goes through an administrator's sign-in on the
// same server when anyone here has one; otherwise the page says so.
// AIOStreams and AIOMetadata have no such list - their /Devices only ever
// names the device asking - so this is for real Jellyfin servers.
//
// SlickSync's own sign-ins (device ids 'slicksync-...') are shown as such and
// can't be signed out here: that would cut SlickSync off from the server.

const serverCollections = require('./jellyfinServerCollections')

const OWN_PREFIX = 'slicksync-'

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

async function serverOf(prisma, accountId, userId) {
  const person = await prisma.user.findFirst({
    where: { id: String(userId), accountId, providerType: 'jellyfin' },
    select: { id: true, username: true, jellyfinServerKind: true, jellyfinUserId: true },
  })
  if (!person) throw httpError(404, 'Person not found')
  if (person.jellyfinServerKind && person.jellyfinServerKind !== 'jellyfin') {
    throw httpError(400, 'Only a Jellyfin server keeps a list of signed-in devices - AIOStreams and AIOMetadata don’t')
  }
  const server = (await serverCollections.serversFor(prisma, accountId)).find((s) => s.people.some((p) => p.id === person.id))
  if (!server) throw httpError(400, `SlickSync has no working sign-in for ${person.username || 'this person'} on their Jellyfin server`)
  return { person, server }
}

async function adminFor(server, decrypt) {
  const { session, admin } = await serverCollections.findActor(server, decrypt)
  return admin ? session : null
}

/**
 * Everything signed in as this person, newest activity first. `needsAdmin`
 * when nobody here signs in to that server as an administrator.
 */
async function listDevices(prisma, decrypt, accountId, userId) {
  const { person, server } = await serverOf(prisma, accountId, userId)
  const s = await adminFor(server, decrypt)
  if (!s) return { needsAdmin: true, devices: [] }
  const data = await serverCollections.call(s, `/Devices?${new URLSearchParams({ userId: person.jellyfinUserId })}`)
  const devices = (Array.isArray(data?.Items) ? data.Items : [])
    .filter((d) => d && d.Id)
    .map((d) => ({
      id: String(d.Id),
      name: d.CustomName || d.Name || 'Unknown device',
      app: [d.AppName, d.AppVersion].filter(Boolean).join(' ') || null,
      lastActive: d.DateLastActivity || null,
      slicksync: String(d.Id).startsWith(OWN_PREFIX),
    }))
    .sort((a, b) => String(b.lastActive || '').localeCompare(String(a.lastActive || '')))
  // SlickSync may hold more than one sign-in for a person (added, then signed
  // in again); one line says it.
  const firstOwn = devices.findIndex((d) => d.slicksync)
  return { needsAdmin: false, devices: devices.filter((d, i) => !d.slicksync || i === firstOwn) }
}

/** Sign one device out: the server forgets its sign-in, so it has to sign in again. */
async function signOutDevice(prisma, decrypt, accountId, userId, deviceId) {
  const id = String(deviceId || '')
  if (!id) throw httpError(400, 'Which device is missing')
  if (id.startsWith(OWN_PREFIX)) throw httpError(400, 'That’s SlickSync’s own sign-in - signing it out would stop SlickSync reading this person’s viewing')
  const { person, server } = await serverOf(prisma, accountId, userId)
  const s = await adminFor(server, decrypt)
  if (!s) throw httpError(400, 'Signing a device out needs an administrator’s sign-in on that Jellyfin server')
  // Only a device that is actually this person's: the id comes from the page.
  const data = await serverCollections.call(s, `/Devices?${new URLSearchParams({ userId: person.jellyfinUserId })}`)
  const mine = (Array.isArray(data?.Items) ? data.Items : []).some((d) => String(d?.Id) === id)
  if (!mine) throw httpError(404, 'That device isn’t signed in as this person any more')
  await serverCollections.call(s, `/Devices?${new URLSearchParams({ id })}`, { method: 'DELETE' })
  return { ok: true }
}

module.exports = { listDevices, signOutDevice }
