/**
 * A per-user mirror of Cinemeta, with the parts they removed left out.
 *
 * Why this exists at all: on Stremio, patching Cinemeta means editing the
 * manifest stored in the account's own addon collection, and the app reads
 * that. Nuvio does not work that way - it stores only the addon's ADDRESS
 * and a name, then fetches the manifest from that address itself. Verified
 * on a live account, where the stored entry is:
 *
 *   {"transportUrl":"https://v3-cinemeta.strem.io/manifest.json",
 *    "manifest":{"id":"…the url…","name":"Cinemeta","catalogs":[],"resources":[]}}
 *
 * So the only thing that can change what a Nuvio device sees is the address.
 * This serves one: the real Cinemeta manifest with the removed parts taken
 * out, and every other request passed straight through upstream so anything
 * kept still works.
 *
 * The trade, stated plainly because it is real: while a Nuvio account points
 * at this address, metadata for every title travels through this instance.
 * If the instance is down, those lookups fail - which is not true of the
 * Stremio path, where the patched manifest lives on the account itself. That
 * is why patching only swaps the address for Nuvio, and why Reset puts the
 * official Cinemeta address back rather than leaving a mirror in place.
 *
 * The version segment in the path is a cache-buster, for the same reason
 * SlickTrax carries one: a Nuvio client will not re-fetch a manifest whose
 * URL has not changed, so changing which parts are removed has to change the
 * address.
 */

const express = require('express')
const { applyPatch } = require('../utils/cinemetaPatch')

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io'
const UPSTREAM_TIMEOUT_MS = 10000

module.exports = ({ prisma }) => {
  const router = express.Router()

  const findUser = async (token) => {
    if (!token || !/^[a-f0-9]{16,}$/i.test(token)) return null
    return prisma.user.findFirst({ where: { cinemetaToken: token } })
  }

  const readPatch = (user) => {
    try {
      const state = user?.cinemetaPatchJson ? JSON.parse(user.cinemetaPatchJson) : null
      return state?.patch || { removeSearch: false, removeCatalogs: false, removeMeta: false }
    } catch {
      return { removeSearch: false, removeCatalogs: false, removeMeta: false }
    }
  }

  // The manifest, patched. Everything else about it - id, name, logo,
  // version - is Cinemeta's own, because this is Cinemeta with parts
  // removed, not a new addon pretending to be one.
  router.get('/:token/v:version/manifest.json', async (req, res) => {
    try {
      const user = await findUser(req.params.token)
      if (!user) return res.status(404).json({ err: 'Unknown mirror' })

      const upstream = await fetch(`${CINEMETA_BASE}/manifest.json`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      if (!upstream.ok) return res.status(502).json({ err: 'Cinemeta did not respond' })
      const manifest = await upstream.json()

      const patched = applyPatch(manifest, readPatch(user))
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.json(patched)
    } catch (e) {
      return res.status(502).json({ err: 'Cinemeta could not be reached' })
    }
  })

  // Everything else - catalog, meta, whatever Cinemeta adds later - passes
  // through untouched. Removing a part from the manifest is what stops a
  // client asking for it; refusing the request here as well would only break
  // clients that ask anyway.
  router.get('/:token/v:version/*', async (req, res) => {
    try {
      const user = await findUser(req.params.token)
      if (!user) return res.status(404).json({ err: 'Unknown mirror' })

      const rest = req.params[0] || ''
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
      const upstream = await fetch(`${CINEMETA_BASE}/${rest}${qs}`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      const body = await upstream.text()
      res.status(upstream.status)
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.send(body)
    } catch (e) {
      return res.status(502).json({ err: 'Cinemeta could not be reached' })
    }
  })

  return router
}

module.exports.CINEMETA_BASE = CINEMETA_BASE
