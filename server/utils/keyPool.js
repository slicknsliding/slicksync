// The Key Pool - N keys per metadata provider, health-aware selection.
//
// Primary + backup (the failover pair) stay exactly what they are. This adds
// an optional list of EXTRA keys per provider (<field>Pool in the account's
// sync JSON), and when any exist, lookups rotate round-robin across every
// healthy key instead of hammering the primary alone. A household where
// three people each grab a free MDBList key stops being three separate
// 1,000/day allowances and becomes one pooled one.
//
// Two modes, deliberately distinct:
//  - No pool keys configured: nothing changes. Primary, with failover to
//    backup when the health check has found the primary bad - the exact
//    semantics shipped with the failover work.
//  - Pool keys present: round-robin across [primary, backup, ...pool],
//    skipping keys the daily per-key check has marked failing or
//    rate-limited. Spreading IS the point in this mode, so the primary
//    holds no special place beyond being first in the ring.
//
// Selection state (ring position) is in-memory per process - it spreads
// load, it is not billing-grade bookkeeping, and resetting on deploy is
// harmless. Per-key health comes from the daily check, which tests every
// key in the ring and stores results under keyHealth[provider].pool keyed
// by a hash prefix of the key (never the key itself - keyHealth travels in
// the same JSON config exports are built from).

const crypto = require('crypto')

function keyTag(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12)
}

function readPool(cfg, settingsField) {
  const raw = cfg?.[`${settingsField}Pool`]
  if (!Array.isArray(raw)) return []
  return raw.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)
}

/** Every key configured for a provider, ring-ordered, deduped. */
function buildRing(cfg, settingsField) {
  const read = (f) => (typeof cfg?.[f] === 'string' ? cfg[f].trim() : '')
  const ring = []
  for (const k of [read(settingsField), read(`${settingsField}Backup`), ...readPool(cfg, settingsField)]) {
    if (k && !ring.includes(k)) ring.push(k)
  }
  return ring
}

function isKeyHealthy(cfg, provider, key) {
  const perKey = cfg?.keyHealth?.[provider]?.pool
  if (!Array.isArray(perKey)) return true // never checked - eligible
  const rec = perKey.find((r) => r && r.tag === keyTag(key))
  if (!rec) return true
  return rec.ok !== false && rec.rateLimited !== true
}

// accountId:provider -> next ring index
const ringPositions = new Map()

/**
 * Pick the next healthy key from the ring. Falls back to the primary when
 * every key is marked unhealthy - a marked-bad key is still better than no
 * key at all, and the daily check will unmark it the moment it recovers.
 */
function pickFromRing(cfg, settingsField, provider, accountId) {
  const ring = buildRing(cfg, settingsField)
  if (ring.length === 0) return ''
  if (ring.length === 1) return ring[0]
  const healthy = ring.filter((k) => isKeyHealthy(cfg, provider, k))
  let candidates = healthy.length > 0 ? healthy : [ring[0]]

  // Quota-aware weighting (opt-in, keyPoolQuotaWeighting): instead of blind
  // alternation, traffic goes to the healthy key(s) with the most remaining
  // allowance - a key at 80% used rests while one at 20% carries the load.
  // Selection narrows to a BAND (least-used +5 points) rather than a single
  // winner, and round-robins inside it, so near-equal keys still alternate
  // instead of ping-ponging one key to exhaustion. Only providers whose
  // check reports usage participate (MDBList today); for the rest this is
  // a no-op and plain round-robin continues - unknown headroom is not a
  // license to guess.
  if (cfg?.keyPoolQuotaWeighting === true && candidates.length > 1) {
    const perKey = cfg?.keyHealth?.[provider]?.pool
    if (Array.isArray(perKey)) {
      const usedOf = (k) => {
        const rec = perKey.find((r) => r && r.tag === keyTag(k))
        return rec && Number.isFinite(rec.percentUsed) ? rec.percentUsed : null
      }
      const known = candidates.filter((k) => usedOf(k) !== null)
      if (known.length > 0) {
        const minUsed = Math.min(...known.map(usedOf))
        const band = known.filter((k) => usedOf(k) <= minUsed + 5)
        if (band.length > 0) candidates = band
      }
    }
  }

  const posKey = `${accountId}:${provider}`
  const pos = ringPositions.get(posKey) || 0
  ringPositions.set(posKey, (pos + 1) % candidates.length)
  return candidates[pos % candidates.length]
}

module.exports = { keyTag, readPool, buildRing, isKeyHealthy, pickFromRing }
