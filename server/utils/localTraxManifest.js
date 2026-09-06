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

module.exports = { localTraxManifest }
