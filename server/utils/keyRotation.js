// Key rotation that chases the key into every addon config - stage 1 of
// "keys that only exist in the Vault."
//
// The problem: a debrid/usenet key is baked into addon config URLs
// (Torrentio, AIOStreams, Comet - each carries a copy inside its manifest
// URL, raw or base64-encoded). Rotating the key in the Vault used to fix
// exactly nothing downstream: every user's addons kept the dead key until
// someone re-configured each addon by hand and re-synced.
//
// When a Vault entry's secret changes and the account has opted in
// (keyRotationPropagation in AppAccount.sync - OFF by default, the user's
// explicit requirement), this finds every addon whose decrypted manifest URL
// embeds the OLD secret - as a raw substring or inside a base64 path
// segment - rewrites it to the new secret, and re-syncs every user whose
// groups carry an affected addon. One paste in the Vault heals the
// household.
//
// Safety rules, each deliberate:
//  - A secret shorter than MIN_SECRET_LENGTH never propagates. Replacing a
//    short string is how "abc123" rewrites half a URL by coincidence.
//  - Base64 segments are re-encoded in the SAME style they were found in
//    (standard vs url-safe alphabet, padded vs not) - an addon server that
//    decodes its own config is entitled to get back exactly the framing it
//    produced.
//  - Only the manifestUrl + its HMAC are updated. The stored manifest JSON
//    is the addon's CONTENT, which a key swap does not change.
//  - Propagation failure never fails the Vault save that triggered it - the
//    new secret is already safely stored either way.

const MIN_SECRET_LENGTH = 12

function looksLikeBase64(seg) {
  return seg.length >= 16 && /^[A-Za-z0-9+/_=-]+$/.test(seg)
}

/** Replace oldSecret inside one base64-ish string, preserving its framing. */
function replaceInBase64(seg, oldSecret, newSecret) {
  const urlSafe = /[-_]/.test(seg)
  const padded = seg.endsWith('=')
  const normalized = seg.replace(/-/g, '+').replace(/_/g, '/')
  let decoded
  try {
    decoded = Buffer.from(normalized, 'base64').toString('utf8')
  } catch {
    return null
  }
  // Round-trip check: base64 is permissive enough that binary junk still
  // "decodes" - only treat it as text config if re-encoding reproduces the
  // input (modulo padding), so we never corrupt a segment that merely
  // happened to match the alphabet.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64')
  const normNoPad = normalized.replace(/=+$/, '')
  if (reencoded.replace(/=+$/, '') !== normNoPad) return null
  if (!decoded.includes(oldSecret)) return null

  const replaced = decoded.split(oldSecret).join(newSecret)
  let out = Buffer.from(replaced, 'utf8').toString('base64')
  if (!padded) out = out.replace(/=+$/, '')
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_')
  return out
}

/**
 * Rewrite every occurrence of oldSecret in a manifest URL - raw, and inside
 * base64 path/query segments. Returns { url, changed }.
 */
function replaceSecretInUrl(url, oldSecret, newSecret) {
  if (!url || !oldSecret || !newSecret || oldSecret === newSecret) return { url, changed: false }
  if (oldSecret.length < MIN_SECRET_LENGTH) return { url, changed: false }

  let out = url
  let changed = false

  if (out.includes(oldSecret)) {
    out = out.split(oldSecret).join(newSecret)
    changed = true
  }

  // Path and query segments that might be base64-encoded config blobs.
  out = out.split(/([/?&=])/).map((part) => {
    if (!looksLikeBase64(part)) return part
    const swapped = replaceInBase64(part, oldSecret, newSecret)
    if (swapped !== null) { changed = true; return swapped }
    return part
  }).join('')

  return { url: out, changed }
}

/**
 * The full propagation: rewrite affected addons, then re-sync every user
 * whose groups carry one. All deps injected so this runs from the Vault
 * route with no HTTP request of its own beyond reqLike.
 */
async function propagateSecretRotation(prisma, reqLike, deps, { accountId, oldSecret, newSecret }) {
  const { encrypt, getDecryptedManifestUrl, manifestUrlHmac, decrypt } = deps
  const summary = { addonsUpdated: [], usersSynced: 0, userFailures: [] }
  if (!oldSecret || !newSecret || oldSecret === newSecret || oldSecret.length < MIN_SECRET_LENGTH) return summary

  const addons = await prisma.addon.findMany({ where: { accountId } })
  const changedIds = []
  for (const addon of addons) {
    const url = getDecryptedManifestUrl(addon, reqLike)
    if (!url) continue
    const { url: nextUrl, changed } = replaceSecretInUrl(url, oldSecret, newSecret)
    if (!changed) continue
    await prisma.addon.update({
      where: { id: addon.id },
      data: {
        manifestUrl: encrypt(nextUrl, reqLike),
        manifestUrlHash: manifestUrlHmac(reqLike, nextUrl),
      },
    })
    changedIds.push(addon.id)
    summary.addonsUpdated.push({ id: addon.id, name: addon.name })
  }
  if (changedIds.length === 0) return summary

  // Users to re-sync: anyone whose group carries a changed addon. The sync
  // itself recomputes each user's real desired set (exclusions, protected
  // addons), so over-selecting here costs a no-op sync, never a wrong one.
  const groups = await prisma.group.findMany({
    where: { accountId },
    include: { addons: { select: { addonId: true } } },
  })
  const userIds = new Set()
  for (const g of groups) {
    if (!g.addons.some((ga) => changedIds.includes(ga.addonId))) continue
    let ids = []
    try { ids = JSON.parse(g.userIds || '[]') } catch { ids = [] }
    for (const id of ids) userIds.add(id)
  }
  if (userIds.size === 0) return summary

  const activeUsers = await prisma.user.findMany({
    where: { id: { in: [...userIds] }, accountId, isActive: true },
    select: { id: true, username: true },
  })
  const { syncUserAddons } = require('../routes/users')
  for (const u of activeUsers) {
    try {
      const result = await syncUserAddons(prisma, u.id, [], false, reqLike, decrypt, () => accountId, true)
      if (result && result.success) summary.usersSynced++
      else summary.userFailures.push({ username: u.username, error: (result && result.error) || 'unknown' })
    } catch (e) {
      summary.userFailures.push({ username: u.username, error: e?.message || 'unknown' })
    }
  }
  return summary
}

module.exports = { replaceSecretInUrl, replaceInBase64, propagateSecretRotation, MIN_SECRET_LENGTH }
