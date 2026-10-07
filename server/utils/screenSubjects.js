// Who a daily limit, a bedtime or an age limit is for.
//
// Mostly a person. But a Nuvio profile, or an AIOStreams or AIOMetadata
// household user, merged into a person has no person of its own - its
// viewing is recorded on that person, labelled with its name - and can still
// have limits of its own. Those are named here:
//
//   np-<Nuvio user id>-<profile index>   a merged Nuvio profile
//   hh-<household profile id>            a merged AIOStreams/AIOMetadata household user
//
// and load as a person-like object whose `subject` says which it is, and
// whose it is (ownerId: the person its viewing is recorded on). A profile
// given a person of its own is that person instead - loading it by its
// profile name then finds nothing.

const NUVIO = /^np-(.+)-(\d+)$/
const HOUSEHOLD = /^hh-([A-Za-z0-9_-]+)$/

const PERSON_SELECT = { id: true, username: true, providerType: true, jellyfinServerKind: true, isActive: true }

const nuvioProfileSubject = (nuvioUserId, index) => `np-${nuvioUserId}-${index}`
const householdSubject = (profileId) => `hh-${profileId}`
const isProfileSubject = (id) => NUVIO.test(String(id || '')) || HOUSEHOLD.test(String(id || ''))

/** The Nuvio profile's name and whether it uses the main profile's addons, as last read from Nuvio. */
function profileMeta(cfg, id) {
  const m = cfg?.screenTimeProfiles?.[id]
  return m && typeof m === 'object' ? m : {}
}

async function loadNuvioProfile(prisma, accountId, id, cfg) {
  const m = NUVIO.exec(id)
  if (!m) return null
  const nuvioUserId = m[1]
  const index = Number(m[2])
  const np = require('./nuvioProfiles')
  const siblings = await np.loadSiblings(prisma, accountId, nuvioUserId)
  if (!siblings.length || siblings.some((s) => np.profileOf(s) === index)) return null
  const routes = await np.loadRoutes(prisma, accountId, nuvioUserId)
  const ownerId = np.ownerOf(index, siblings, routes)
  const owner = siblings.find((s) => s.id === (ownerId || siblings[0]?.id))
  if (!owner) return null
  const meta = profileMeta(cfg, id)
  const name = typeof meta.name === 'string' && meta.name ? meta.name : null
  return {
    id,
    username: name || `Profile ${index}`,
    providerType: 'nuvio',
    jellyfinServerKind: null,
    isActive: owner.isActive !== false,
    subject: { kind: 'nuvio-profile', nuvioUserId, index, ownerId: owner.id, ownerName: owner.username, name, tracked: !!ownerId, sharesPrimary: meta.sharesPrimary === true },
  }
}

async function loadHousehold(prisma, accountId, id) {
  const m = HOUSEHOLD.exec(id)
  if (!m) return null
  const profile = await prisma.jellyfinProfile.findFirst({
    where: { id: m[1], accountId },
    select: { id: true, name: true, ownerUserId: true, jellyfinUserId: true, ownUserId: true, skip: true },
  })
  if (!profile || profile.ownUserId) return null
  const owner = await prisma.user.findFirst({ where: { id: profile.ownerUserId, accountId }, select: PERSON_SELECT })
  if (!owner) return null
  return {
    id,
    username: profile.name,
    providerType: owner.providerType,
    jellyfinServerKind: owner.jellyfinServerKind,
    isActive: owner.isActive !== false,
    subject: { kind: 'household', profileId: profile.id, ownerId: owner.id, ownerName: owner.username, jellyfinUserId: profile.jellyfinUserId, name: profile.name, tracked: !profile.skip },
  }
}

/** A person, or a merged profile or household user, by its id - or null. */
async function loadSubject(prisma, accountId, id, cfg = null) {
  const key = String(id || '')
  if (NUVIO.test(key)) {
    const settings = cfg || (await require('./screenTime').readSync(prisma, accountId)).cfg
    return loadNuvioProfile(prisma, accountId, key, settings)
  }
  if (HOUSEHOLD.test(key)) return loadHousehold(prisma, accountId, key)
  return prisma.user.findFirst({ where: { id: key, accountId }, select: PERSON_SELECT })
}

/** Many at once: people in one read, profiles one by one. A Map of id -> subject. */
async function loadSubjects(prisma, accountId, ids, cfg) {
  const out = new Map()
  const people = ids.filter((id) => !isProfileSubject(id))
  if (people.length) {
    for (const p of await prisma.user.findMany({ where: { accountId, id: { in: people } }, select: PERSON_SELECT })) out.set(p.id, p)
  }
  for (const id of ids.filter(isProfileSubject)) {
    const s = await loadSubject(prisma, accountId, id, cfg).catch(() => null)
    if (s) out.set(id, s)
  }
  return out
}

/**
 * The ids of a person's merged profiles and household users that have
 * limits of their own: their viewing is theirs, not the person's, and a
 * pause of the person leaves them alone.
 */
async function ownLimitedSubjects(prisma, accountId, ownerId, cfg) {
  const ids = Object.keys(cfg?.screenTime || {}).filter(isProfileSubject)
  const out = []
  for (const id of ids) {
    const s = await loadSubject(prisma, accountId, id, cfg).catch(() => null)
    if (s?.subject?.ownerId === ownerId) out.push(s)
  }
  return out
}

/**
 * A merged Nuvio profile's name and whether it uses the main profile's
 * addons, read from Nuvio through its person's sign-in and kept with the
 * account's settings (cfg.screenTimeProfiles). Returns what was kept, or null.
 */
async function refreshNuvioProfile(prisma, accountId, person) {
  const owner = await prisma.user.findFirst({ where: { id: person.subject.ownerId, accountId } })
  if (!owner) return null
  const { encrypt, decrypt } = require('./encryption')
  const provider = require('../providers').makeCreateProvider({ prisma, encrypt, getAccountId: () => accountId })(owner, { decrypt, req: { appAccountId: accountId } })
  if (!provider?.getProfiles) return null
  const profile = ((await provider.getProfiles()) || []).find((p) => Number(p.profile_index ?? p.profileIndex) === person.subject.index)
  if (!profile) return null
  const meta = { name: profile.name || null, sharesPrimary: profile.uses_primary_addons === true, at: new Date().toISOString() }
  await require('./screenTime').patchEntry(prisma, accountId, 'screenTimeProfiles', person.id, meta)
  return meta
}

/**
 * loadSubject, with a Nuvio profile's facts read from Nuvio first when the
 * copy kept is over an hour old - so whatever asks next (a popup's daily
 * limit or its age limit, whichever comes first) knows whether it shares the
 * main profile's addons. { person, cfg }, or person null when there is none.
 */
async function loadSubjectFresh(prisma, accountId, id, { refresh = refreshNuvioProfile } = {}) {
  const { readSync } = require('./screenTime')
  let { cfg } = await readSync(prisma, accountId)
  let person = await loadSubject(prisma, accountId, id, cfg)
  if (person?.subject?.kind === 'nuvio-profile') {
    const meta = cfg.screenTimeProfiles?.[id]
    if (!meta?.at || Date.parse(meta.at) + 60 * 60 * 1000 < Date.now()) {
      if (await refresh(prisma, accountId, person).catch(() => null)) {
        cfg = (await readSync(prisma, accountId)).cfg
        person = (await loadSubject(prisma, accountId, id, cfg)) || person
      }
    }
  }
  return { person, cfg }
}

module.exports = { nuvioProfileSubject, householdSubject, isProfileSubject, loadSubject, loadSubjectFresh, loadSubjects, ownLimitedSubjects, profileMeta, refreshNuvioProfile }
