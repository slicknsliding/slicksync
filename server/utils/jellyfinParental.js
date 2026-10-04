// A Jellyfin person's age limit: the highest age rating their account on a
// real Jellyfin server may play, set on the server itself so every Jellyfin
// app respects it. The choices are the server's own rating list (it differs
// by country and server version). Optionally titles with no rating at all
// are hidden too - otherwise an unrated film slips past any limit.
//
// Jellyfin lets only administrators change this, so it goes through an
// administrator's sign-in on that server. AIOStreams and AIOMetadata have no
// such setting.

const serverCollections = require('./jellyfinServerCollections')

const httpError = (status, message) => Object.assign(new Error(message), { status })
const UNRATED_TYPES = ['Movie', 'Series']

async function context(prisma, decrypt, accountId, userId) {
  const person = await prisma.user.findFirst({
    where: { id: String(userId), accountId, providerType: 'jellyfin' },
    select: { id: true, username: true, jellyfinServerKind: true, jellyfinUserId: true },
  })
  if (!person) throw httpError(404, 'Person not found')
  if (person.jellyfinServerKind && person.jellyfinServerKind !== 'jellyfin') return { available: false }
  const server = (await serverCollections.serversFor(prisma, accountId)).find((s) => s.people.some((p) => p.id === person.id))
  if (!server) return { available: false }
  const { session, admin } = await serverCollections.findActor(server, decrypt)
  return { available: true, person, session: admin ? session : null }
}

/** The server's ratings grouped by level, lowest first: [{ value, label }]. */
async function ratingLevels(session) {
  const list = await serverCollections.call(session, '/Localization/ParentalRatings')
  const byValue = new Map()
  for (const r of Array.isArray(list) ? list : []) {
    const value = Number.isFinite(r?.Value) ? r.Value : r?.RatingScore?.Score
    if (!Number.isFinite(value) || !r?.Name) continue
    if (!byValue.has(value)) byValue.set(value, [])
    byValue.get(value).push(String(r.Name))
  }
  return [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, names]) => ({ value, label: names.slice(0, 3).join(' · ') }))
}

async function getAgeLimit(prisma, decrypt, accountId, userId) {
  const ctx = await context(prisma, decrypt, accountId, userId)
  if (!ctx.available) return { available: false }
  if (!ctx.session) return { available: true, needsAdmin: true }
  const [levels, user] = await Promise.all([
    ratingLevels(ctx.session),
    serverCollections.call(ctx.session, `/Users/${ctx.person.jellyfinUserId}`),
  ])
  const policy = user?.Policy || {}
  return {
    available: true,
    needsAdmin: false,
    levels,
    current: Number.isFinite(policy.MaxParentalRating) ? policy.MaxParentalRating : null,
    blockUnrated: Array.isArray(policy.BlockUnratedItems) && UNRATED_TYPES.every((t) => policy.BlockUnratedItems.includes(t)),
  }
}

/** value null = no limit. */
async function setAgeLimit(prisma, decrypt, accountId, userId, { value, blockUnrated }) {
  const ctx = await context(prisma, decrypt, accountId, userId)
  if (!ctx.available) throw httpError(400, 'Only a Jellyfin server has an age limit to set')
  if (!ctx.session) throw httpError(400, 'Setting an age limit needs an administrator’s sign-in on that Jellyfin server')
  const user = await serverCollections.call(ctx.session, `/Users/${ctx.person.jellyfinUserId}`)
  const policy = user?.Policy
  if (!policy) throw httpError(502, 'The server did not say how this account is set up')
  const limit = value === null || value === undefined || value === '' ? null : Number(value)
  if (limit !== null && !Number.isFinite(limit)) throw httpError(400, 'Pick a rating from the list')
  const blocked = new Set(Array.isArray(policy.BlockUnratedItems) ? policy.BlockUnratedItems : [])
  if (blockUnrated === true) UNRATED_TYPES.forEach((t) => blocked.add(t))
  if (blockUnrated === false) UNRATED_TYPES.forEach((t) => blocked.delete(t))
  await serverCollections.call(ctx.session, `/Users/${ctx.person.jellyfinUserId}/Policy`, {
    method: 'POST',
    body: { ...policy, MaxParentalRating: limit, MaxParentalSubRating: null, BlockUnratedItems: [...blocked] },
  })
  return getAgeLimit(prisma, decrypt, accountId, userId)
}

module.exports = { getAgeLimit, setAgeLimit, ratingLevels }
