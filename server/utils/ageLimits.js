// An age limit: the highest rating someone may play.
//
// A real Jellyfin server has its own, set on the server (jellyfinParental.js).
// For Stremio, Nuvio, a merged Nuvio profile and AIOMetadata, SlickSync keeps
// it (the account's cfg.ageLimits, by person or profile id - see
// screenSubjects.js) and its stream gate (streamGate.js) answers "nothing to
// play" for a title rated above it. Catalogs stay. AIOStreams has nothing
// per title that SlickSync could set, so it has no age limit here.
//
// Ratings are OMDb's "Rated" field - US film and TV ratings - cached by
// omdb.js, so each title is looked up once. Without an OMDb key nothing has a
// rating, so everything counts as unrated.

const LEVELS = [
  { value: 0, label: 'G, TV-Y, TV-G' },
  { value: 7, label: 'TV-Y7' },
  { value: 10, label: 'PG, TV-PG' },
  { value: 13, label: 'PG-13' },
  { value: 14, label: 'TV-14' },
  { value: 17, label: 'R' },
]

// The age each rating is for. NC-17 and TV-MA are above every level offered,
// so only "No limit" lets them through. Anything else ("Not Rated",
// "Approved", "N/A") is unrated.
const AGE_OF = {
  G: 0, 'TV-Y': 0, 'TV-G': 0,
  'TV-Y7': 7, 'TV-Y7-FV': 7,
  PG: 10, 'TV-PG': 10,
  'PG-13': 13,
  'TV-14': 14,
  R: 17,
  'NC-17': 18, 'TV-MA': 18, X: 18,
}

function ageOfRating(rated) {
  const key = String(rated || '').trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(AGE_OF, key) ? AGE_OF[key] : null
}

/** An age limit as stored, cleaned: { maxAge, blockUnrated? }, or null for none. */
function cleanAgeLimit(raw) {
  if (!raw || typeof raw !== 'object') return null
  const maxAge = Number(raw.maxAge)
  if (!LEVELS.some((l) => l.value === maxAge)) return null
  return raw.blockUnrated === true ? { maxAge, blockUnrated: true } : { maxAge }
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

/** The IMDb id a stream request is for: "stream/series/tt0903747:1:2.json" -> tt0903747. */
function imdbIdOf(resourcePath) {
  const m = /^stream\/[^/]+\/([^/]+?)\.json$/.exec(String(resourcePath || ''))
  if (!m) return null
  let id = m[1]
  try { id = decodeURIComponent(id) } catch { /* as it came */ }
  return /^(tt\d+)/.exec(id)?.[1] || null
}

/**
 * Whether someone with this age limit may play the title a stream request is
 * for. A title with no rating - no IMDb id, no OMDb key, or OMDb has none -
 * plays unless they block unrated titles.
 */
async function mayPlay(prisma, accountId, age, resourcePath, deps = {}) {
  if (!age) return true
  const imdbId = imdbIdOf(resourcePath)
  let rated = null
  if (imdbId) {
    const ratingOf = deps.ratingOf || (async (id) => {
      const key = await require('./listImport').resolveOmdbKeyForAccount(prisma, accountId)
      if (!key) return null
      return (await require('./omdb').fetchOmdbRatings(id, key).catch(() => null))?.rated || null
    })
    rated = await ratingOf(imdbId)
  }
  const ageOf = ageOfRating(rated)
  if (ageOf === null) return !age.blockUnrated
  return ageOf <= age.maxAge
}

/** Which age limit applies to someone: 'jellyfin' (the server's), 'streams' (SlickSync's), or null with why not. */
function sourceFor(person) {
  if (person.subject?.sharesPrimary) return { source: null, reason: `${person.username || 'This profile'} uses the main profile’s addons in Nuvio, so it can’t have an age limit of its own. Give it its own addons in Nuvio first.` }
  if (person.providerType !== 'jellyfin') return { source: 'streams' }
  const kind = person.jellyfinServerKind
  if (!kind || kind === 'jellyfin') return person.subject ? { source: null, reason: 'Set an age limit on their own Jellyfin account.' } : { source: 'jellyfin' }
  if (kind === 'aiometadata') return { source: 'streams' }
  return { source: null, reason: 'AIOStreams has no way to limit one person by age.' }
}

async function getAgeLimit(prisma, decrypt, accountId, id) {
  const { person } = await require('./screenSubjects').loadSubjectFresh(prisma, accountId, id)
  if (!person) throw fail('User not found', 404)
  const { source, reason } = sourceFor(person)
  if (source === 'jellyfin') return { ...(await require('./jellyfinParental').getAgeLimit(prisma, decrypt, accountId, id)), source }
  if (!source) return { available: false, source: null, reason }
  const { readSync } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  const age = cleanAgeLimit(cfg.ageLimits?.[id])
  const key = await require('./listImport').resolveOmdbKeyForAccount(prisma, accountId).catch(() => null)
  const usable = await require('./streamGate').gateUsable(prisma, accountId).catch(() => null)
  return {
    available: true,
    source,
    needsAdmin: false,
    levels: LEVELS,
    current: age ? age.maxAge : null,
    blockUnrated: !!age?.blockUnrated,
    // Without an OMDb key no title has a rating.
    needsKey: !key,
    // Without a gate devices can reach, it can't be held to.
    needsAddress: !usable?.ok,
    // Why, in words.
    addressProblem: require('./streamGate').gateProblem(usable),
  }
}

/** value null = no limit. */
async function setAgeLimit(prisma, decrypt, accountId, id, { value, blockUnrated }) {
  const { person } = await require('./screenSubjects').loadSubjectFresh(prisma, accountId, id)
  if (!person) throw fail('User not found', 404)
  const { source, reason } = sourceFor(person)
  if (source === 'jellyfin') {
    return { ...(await require('./jellyfinParental').setAgeLimit(prisma, decrypt, accountId, id, { value, blockUnrated })), source }
  }
  if (!source) throw fail(reason)
  const { readSync, patchEntry } = require('./screenTime')
  const { cfg } = await readSync(prisma, accountId)
  const before = cleanAgeLimit(cfg.ageLimits?.[id])
  let next = null
  if (value !== null && value !== undefined && value !== '') {
    next = cleanAgeLimit({ maxAge: value, blockUnrated: blockUnrated === undefined ? !!before?.blockUnrated : blockUnrated })
    if (!next) throw fail('Pick a rating from the list')
  } else if (blockUnrated === true) {
    throw fail('Pick a rating first')
  }
  await patchEntry(prisma, accountId, 'ageLimits', id, next)
  return getAgeLimit(prisma, decrypt, accountId, id)
}

module.exports = { LEVELS, ageOfRating, cleanAgeLimit, imdbIdOf, mayPlay, sourceFor, getAgeLimit, setAgeLimit }
