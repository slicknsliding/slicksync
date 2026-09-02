// Stage 2 of "keys that only exist in the Vault": placeholder configs.
//
// A vaultified addon's stored manifest URL carries {{vault:<entryId>}} where
// the real secret used to be. Only the /proxy layer - server-side, with DB
// access - resolves placeholders back to live secrets, at request time. The
// user's provider account holds the PROXY url (sync enforces this for
// vaultified addons), so the real key never appears in any account, any
// synced manifest, or any URL a device ever sees. Rotation becomes a
// non-event: the placeholder never changes, so there is nothing to rewrite
// and nothing to re-sync - the next proxied request simply resolves the new
// secret.
//
// v1 scope, stated honestly: vaultify handles secrets that appear RAW in
// the URL (Torrentio-style path segments, query params). Keys buried inside
// base64-encoded config blobs (AIOStreams-style) are detected and reported
// but NOT vaultified - splicing placeholders into encoded blobs and
// re-encoding them at serve time is a different mechanism. Those addons
// keep full rotation-propagation coverage instead.

const PLACEHOLDER_RE = /\{\{vault:([A-Za-z0-9_-]+)\}\}/g
const MIN_SECRET_LENGTH = 12 // same floor as keyRotation.js, same reason

function hasVaultPlaceholders(url) {
  return typeof url === 'string' && url.includes('{{vault:')
}

/**
 * Swap each vault entry's secret for its placeholder. Returns what changed
 * and what was found-but-skipped (base64-buried keys).
 */
function insertPlaceholders(url, entries /* [{id, secret}] */) {
  let out = url
  const used = []
  for (const { id, secret } of entries) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue
    if (out.includes(secret)) {
      out = out.split(secret).join(`{{vault:${id}}}`)
      used.push(id)
    }
  }
  return { url: out, used }
}

/** Which entries' secrets are only reachable inside base64 blobs. */
function findBase64BuriedSecrets(url, entries) {
  const { replaceInBase64 } = require('./keyRotation')
  const buried = []
  for (const { id, secret } of entries) {
    if (!secret || secret.length < MIN_SECRET_LENGTH || url.includes(secret)) continue
    const found = url.split(/([/?&=])/).some((part) => {
      if (part.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(part)) return false
      return replaceInBase64(part, secret, secret) !== null
    })
    if (found) buried.push(id)
  }
  return buried
}

/**
 * Resolve placeholders back to live secrets. Entries are fetched fresh on
 * every call - that is the entire point: the resolved value is whatever the
 * Vault holds RIGHT NOW. Unknown/foreign ids resolve to nothing and the
 * fetch then fails loudly upstream rather than leaking a guess.
 */
async function resolvePlaceholders(prisma, accountId, url, decrypt) {
  if (!hasVaultPlaceholders(url)) return url
  const ids = [...url.matchAll(PLACEHOLDER_RE)].map((m) => m[1])
  const entries = await prisma.vaultEntry.findMany({
    where: { id: { in: [...new Set(ids)] }, accountId, isActive: true },
  })
  const byId = new Map(entries.map((e) => {
    let secret = ''
    try { secret = decrypt(e.encryptedSecret, { appAccountId: accountId }) } catch { secret = '' }
    return [e.id, secret]
  }))
  return url.replace(PLACEHOLDER_RE, (_m, id) => byId.get(id) || '')
}

module.exports = { hasVaultPlaceholders, insertPlaceholders, findBase64BuriedSecrets, resolvePlaceholders, PLACEHOLDER_RE, MIN_SECRET_LENGTH }
