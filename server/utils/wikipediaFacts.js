/**
 * Fills the gaps in a person's card from Wikidata and Wikipedia. TMDb stays
 * first: it is only asked past when it has no birthday, no biography, or a
 * birthplace that is just a country, and nothing TMDb already says is ever
 * replaced. See utils/personFacts.js for the TMDb side.
 *
 * Lookups are remembered for about a month per person, misses included, in
 * memory and in a small file so a restart does not forget them. The lookup is
 * time-boxed - a slow Wikidata never holds the page, it just leaves the
 * card as TMDb had it.
 */

const fs = require('fs')
const path = require('path')
const { shortBiography } = require('./personFacts')

const REPO_URL = 'https://github.com/slicknsliding/slicksync'
// Wikimedia asks for a descriptive agent with a way to reach the project.
const USER_AGENT = `SlickSync/1.0 (${REPO_URL}; person facts)`
const SPARQL_URL = 'https://query.wikidata.org/sparql'
const SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/'

const LOOKUP_TIMEOUT_MS = 4000
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
// A failed lookup (Wikidata down, rate-limited) is retried soon, not in a month.
const FAILURE_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 5000
const SAVE_DELAY_MS = 5000

// ---- Cache --------------------------------------------------------------

// key -> { at, failed?, facts: {...} | null }. `facts: null` is a remembered miss.
const cache = new Map()
let loaded = false
let saveTimer = null

const cacheFile = () => (process.env.PERSON_FACTS_CACHE_FILE !== undefined
  ? process.env.PERSON_FACTS_CACHE_FILE
  : path.join(process.cwd(), 'data', 'cache', 'person-facts.json'))

function loadCache() {
  if (loaded) return
  loaded = true
  const file = cacheFile()
  if (!file) return
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!rows || typeof rows !== 'object') return
    for (const [key, row] of Object.entries(rows)) {
      if (row && typeof row.at === 'number' && !row.failed) cache.set(key, row)
    }
  } catch { /* no file yet, or unreadable: start empty */ }
}

function scheduleSave() {
  const file = cacheFile()
  if (!file || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const out = {}
      for (const [key, row] of cache) if (!row.failed) out[key] = row
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(out))
      fs.renameSync(tmp, file)
    } catch { /* a cache that cannot be saved is still a cache in memory */ }
  }, SAVE_DELAY_MS)
  if (saveTimer.unref) saveTimer.unref()
}

function remember(key, row) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), ...row })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  if (!row.failed) scheduleSave()
}

function recall(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= (hit.failed ? FAILURE_TTL_MS : HIT_TTL_MS)) { cache.delete(key); return null }
  return hit
}

// ---- Wikidata and Wikipedia ----------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const isLabel = (s) => typeof s === 'string' && s.trim() && !/^Q\d+$/.test(s.trim())

function sparqlFor({ imdbId, tmdbId }) {
  const match = imdbId ? `?p wdt:P345 "${imdbId}" .` : `?p wdt:P4985 "${tmdbId}" .`
  return `SELECT ?birth ?bprec ?death ?dprec ?placeLabel ?countryLabel ?article WHERE {
  ${match}
  OPTIONAL { ?p p:P569/psv:P569 ?bv . ?bv wikibase:timeValue ?birth ; wikibase:timePrecision ?bprec . }
  OPTIONAL { ?p p:P570/psv:P570 ?dv . ?dv wikibase:timeValue ?death ; wikibase:timePrecision ?dprec . }
  OPTIONAL { ?p wdt:P19 ?place . OPTIONAL { ?place wdt:P17 ?country . } }
  OPTIONAL { ?article schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
} LIMIT 10`
}

// A date Wikidata knows to the day, as YYYY-MM-DD; a bare year or month is not a birthday.
function dayOf(value, precision) {
  if (Number(precision) < 11 || typeof value !== 'string') return null
  const day = value.slice(0, 10)
  return ISO_DAY.test(day) ? day : null
}

/** One SPARQL answer, as { birthday, deathday, placeOfBirth, article } (each possibly null). */
function readBindings(bindings) {
  const out = { birthday: null, deathday: null, placeOfBirth: null, article: null }
  for (const row of bindings || []) {
    const v = (name) => row?.[name]?.value
    out.birthday = out.birthday || dayOf(v('birth'), v('bprec'))
    out.deathday = out.deathday || dayOf(v('death'), v('dprec'))
    if (!out.placeOfBirth && isLabel(v('placeLabel'))) {
      const place = v('placeLabel').trim()
      const country = isLabel(v('countryLabel')) ? v('countryLabel').trim() : ''
      out.placeOfBirth = country && country !== place ? `${place}, ${country}` : place
    }
    const article = v('article')
    if (!out.article && typeof article === 'string' && /^https:\/\/en\.wikipedia\.org\/wiki\/[^?#\s]+$/.test(article)) out.article = article
  }
  return out
}

async function getJson(url, signal, accept) {
  const res = await fetch(url, { signal, headers: { 'User-Agent': USER_AGENT, Accept: accept } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * What Wikidata and Wikipedia know of a person, by IMDb id (else TMDb id):
 * { birthday, deathday, placeOfBirth, bio }, or null when they know no one by
 * that id. Throws when it could not find out (down, slow, refused).
 */
async function fetchWikiFacts({ imdbId, tmdbId }, signal) {
  const query = sparqlFor({ imdbId, tmdbId })
  const data = await getJson(`${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`, signal, 'application/sparql-results+json')
  const bindings = data?.results?.bindings
  if (!Array.isArray(bindings)) throw new Error('Unexpected Wikidata answer')
  if (!bindings.length) return null
  const { article, ...facts } = readBindings(bindings)
  let bio = null
  if (article) {
    const title = article.slice('https://en.wikipedia.org/wiki/'.length)
    // A summary that cannot be had still leaves the dates and place.
    const summary = await getJson(`${SUMMARY_URL}${title}`, signal, 'application/json').catch((e) => { if (signal.aborted) throw e; return null })
    if (summary && summary.type !== 'disambiguation') bio = shortBiography(summary.extract)
  }
  return { ...facts, bio }
}

// ---- Filling ------------------------------------------------------------

/** A birthplace that is only a country ("United States"): TMDb writes the rest as "City, Region, Country". */
const countryOnly = (place) => !!place && !String(place).includes(',')

function needsLookup(facts) {
  return !facts.birthday || !facts.bio || countryOnly(facts.placeOfBirth)
}

/**
 * TMDb's facts with the gaps filled from `wiki`. Never changes a fact TMDb
 * has; a country-only birthplace counts as missing when Wikipedia has a city.
 * Returns { facts, filled } - `filled` names what came from Wikipedia, in
 * the order a line would say it: 'bio', 'birthday', 'birthplace'.
 */
function fillFacts(facts, wiki) {
  const out = { ...facts }
  const filled = []
  if (!wiki) return { facts: out, filled }
  if (!out.bio && wiki.bio) { out.bio = wiki.bio; filled.push('bio') }
  if (!out.birthday && wiki.birthday) { out.birthday = wiki.birthday; filled.push('birthday') }
  if (!out.deathday && wiki.deathday && out.birthday) {
    out.deathday = wiki.deathday
    if (!filled.includes('birthday')) filled.push('birthday')
  }
  const wikiPlace = wiki.placeOfBirth
  if (wikiPlace && (!out.placeOfBirth || (countryOnly(out.placeOfBirth) && String(wikiPlace).includes(',')))) {
    out.placeOfBirth = wikiPlace
    filled.push('birthplace')
  }
  return { facts: out, filled }
}

/**
 * The card's facts with Wikipedia's gaps filled in, never slower than the time-box.
 * `facts` is personFacts() output (or the like); ids are TMDb's person id and/or an IMDb nm id.
 * Returns { facts, factsFrom: 'wikipedia' | null, factsFilled: string[] }.
 */
async function enrichFacts({ tmdbId, imdbId, facts }, { timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const base = facts || {}
  const unchanged = { facts: base, factsFrom: null, factsFilled: [] }
  const nm = /^nm\d+$/.test(String(imdbId || '')) ? String(imdbId) : ''
  const tm = /^\d+$/.test(String(tmdbId || '')) ? String(tmdbId) : ''
  if ((!nm && !tm) || !needsLookup(base)) return unchanged
  loadCache()
  const key = tm ? `tmdb:${tm}` : `imdb:${nm}`

  let entry = recall(key)
  if (!entry) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Wikidata lookup timed out')) }, timeoutMs)
    })
    try {
      const found = await Promise.race([fetchWikiFacts({ imdbId: nm, tmdbId: tm }, controller.signal), deadline])
      entry = { facts: found }
      remember(key, entry)
    } catch {
      remember(key, { failed: true, facts: null })
      return unchanged
    } finally {
      clearTimeout(timer)
    }
  }
  if (entry.failed || !entry.facts) return unchanged
  const { facts: filledFacts, filled } = fillFacts(base, entry.facts)
  return { facts: filledFacts, factsFrom: filled.length ? 'wikipedia' : null, factsFilled: filled }
}

module.exports = {
  enrichFacts,
  fillFacts,
  needsLookup,
  USER_AGENT,
  _test: { cache, sparqlFor, readBindings, reset: () => { cache.clear(); loaded = false } },
}
