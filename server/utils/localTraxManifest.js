/**
 * SlickTrax's own manifest, built in-process instead of fetched over HTTP.
 *
 * Every catalog check in the app - "does this addon still serve the catalog
 * this collection is linked to" - answers itself by fetching the addon's
 * manifest. For third-party addons that is the only way to know. For
 * SlickTrax it is absurd: this instance GENERATES that manifest, and then
 * asks itself for it over the network.
 *
 * It is also fragile in a way that has nothing to do with SlickSync. An
 * instance sitting behind a whole-host auth gate (Authelia, basic auth,
 * Cloudflare Access, a VPN-only hostname) answers its own /trax/ request
 * with a redirect to a login page, so the manifest comes back empty and a
 * perfectly good linked catalog reports itself broken. Building it locally
 * works on every setup, needs no reverse-proxy configuration at all, and is
 * instant.
 *
 * NOTE this fixes what SLICKSYNC knows. A device - the phone or TV running
 * Nuvio or Stremio - still fetches /trax/ over the network and still needs
 * that path reachable without a login, exactly like any other addon URL.
 */

// The token is the addon's credential and is unique per user, so it
// identifies the owner on its own - no account scoping needed.
const TRAX_URL = /\/trax\/([A-Za-z0-9]{16,})(?:\/|$)/

async function localTraxManifest(prisma, transportUrl) {
  if (!prisma || !transportUrl) return null
  const match = TRAX_URL.exec(String(transportUrl))
  if (!match) return null
  try {
    const user = await prisma.user.findFirst({ where: { traxToken: match[1] } })
    if (!user) return null
    // Required lazily: traxAddon is a route module, and the route modules
    // pull in utils. Requiring it at load time would close the circle.
    const { buildTraxManifest, getListsForAccount } = require('../routes/traxAddon')
    const lists = await getListsForAccount(prisma, user.accountId)
    return buildTraxManifest(user, lists)
  } catch {
    // A trax URL we cannot resolve locally falls back to the network path,
    // which is no worse than before this existed.
    return null
  }
}

/**
 * The same URL, pointed straight at this process instead of at the public
 * hostname - for the places that genuinely need to READ a trax response
 * (a catalog's items, say) rather than just its manifest.
 *
 * The public address round-trips through whatever sits in front of this
 * instance, which is how a catalog preview of our OWN addon ended up
 * fetching a login page. Loopback skips all of it: no reverse proxy, no
 * auth gate, no TLS, no DNS. Null for anything that is not a trax URL
 * belonging to a user on THIS instance, so a foreign trax address is still
 * fetched normally rather than being answered with our own data.
 */
async function loopbackTraxUrl(prisma, rawUrl) {
  if (!prisma || !rawUrl) return null
  const match = TRAX_URL.exec(String(rawUrl))
  if (!match) return null
  try {
    const owner = await prisma.user.findFirst({ where: { traxToken: match[1] }, select: { id: true } })
    if (!owner) return null
    const parsed = new URL(String(rawUrl))
    const port = process.env.PORT || 4000
    return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search || ''}`
  } catch {
    return null
  }
}

module.exports = { localTraxManifest, loopbackTraxUrl }
