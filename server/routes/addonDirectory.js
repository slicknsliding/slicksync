const express = require('express')
const fs = require('fs')
const path = require('path')

// Browse the public Stremio addon directory (stremio-addons.net) from inside
// SlickSync, so adding an addon is "search, pick, install" rather than "go
// find a manifest URL somewhere else and paste it".
//
// Proxied through the server rather than fetched from the browser: the
// directory sets no CORS headers for arbitrary origins, one shared cache
// means a household browsing addons hits the upstream once rather than once
// per person per keystroke, and it keeps the upstream host in one place.
//
// The upstream endpoint (confirmed live, undocumented - GET /api/v0/addons)
// returns results in NO meaningful order and ignores every sort parameter
// tried (sort/orderBy/order, ascending or descending - all return byte
// identical ordering). Verified consequence: page 1 tops out at 13 stars
// while page 12 holds a 52-star addon, so the most popular addons are
// scattered invisibly through 23 pages of results.
//
// Rather than present that as-is, this fetches the WHOLE directory once
// (544 addons at 100/page = 6 upstream requests, its own maximum page size),
// sorts by stars, and serves search/filter/pagination from that cached copy.
// The cost is 6 requests per cache period instead of 1; the payoff is
// correct ordering, plus instant search with no upstream round-trip at all.
//
// This is a READ-ONLY view of someone else's public listing. Installing from
// here goes through the app's existing addon-create path, which re-fetches
// the manifest from the addon's own URL - nothing in the directory response
// is trusted as the addon's real manifest.

const UPSTREAM = 'https://stremio-addons.net/api/v0/addons'
const UPSTREAM_PAGE_SIZE = 100 // the upstream's own cap; asking for more is silently clamped
const MAX_UPSTREAM_PAGES = 15 // hard stop so an upstream change can't spin this forever
const FETCH_TIMEOUT_MS = 12000
const CACHE_TTL_MS = 30 * 60 * 1000
// Where the sorted copy is kept between restarts. Without this the first
// person to open the directory after any restart - or after any half-hour
// gap - paid for the whole sweep (six upstream pages, about a megabyte and
// a half) while looking at an empty modal, which is nearly every time
// anyone opens it.
const DISK_PATH = path.join(process.cwd(), 'data', 'addon-directory.json')
// A copy older than this is not served even as a stopgap - by then enough
// of the listing could have changed that showing it would mislead.
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

module.exports = () => {
  const router = express.Router()

  let cache = null // { at, addons: [] }
  let inFlight = null // shared promise so concurrent first-loads fetch once
  let diskRead = false

  const readDisk = () => {
    diskRead = true
    try {
      const raw = JSON.parse(fs.readFileSync(DISK_PATH, 'utf8'))
      const at = Number(raw?.at) || 0
      const addons = Array.isArray(raw?.addons) ? raw.addons : []
      if (!addons.length || Date.now() - at > DISK_MAX_AGE_MS) return null
      return { at, addons }
    } catch {
      return null // no copy yet, or an unreadable one - fetch instead
    }
  }

  const writeDisk = (entry) => {
    try {
      fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true })
      fs.writeFileSync(DISK_PATH, JSON.stringify(entry))
    } catch {
      // A read-only or full data directory must not break browsing - it
      // only costs the between-restarts head start.
    }
  }

  const fetchPage = async (page) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${UPSTREAM}?page=${page}&limit=${UPSTREAM_PAGE_SIZE}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Addon directory returned ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  const normalize = (a) => {
    const m = a?.manifest || {}
    return {
      id: a?.uuid || a?.slug || m?.id || null,
      name: m?.name || 'Untitled addon',
      description: typeof m?.description === 'string' ? m.description.slice(0, 500) : '',
      version: m?.version || null,
      logo: m?.logo || null,
      manifestUrl: a?.manifestUrl || null,
      // Present when the addon must be configured on its own site before it
      // can be usefully installed - the UI links out instead of adding a
      // bare, unconfigured URL.
      configureUrl: a?.configureUrl || null,
      stars: Number.isFinite(a?.stars) ? a.stars : 0,
      types: Array.isArray(m?.types) ? m.types : [],
      // Resources arrive as either plain strings or {name} objects.
      resources: Array.isArray(m?.resources)
        ? m.resources.map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean)
        : [],
      categories: Array.isArray(a?.categories)
        ? a.categories.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
        : [],
    }
  }

  const loadAll = async () => {
    const first = await fetchPage(1)
    const totalPages = Math.min(Number(first?.pagination?.totalPages) || 1, MAX_UPSTREAM_PAGES)
    let raw = Array.isArray(first?.addons) ? [...first.addons] : []

    if (totalPages > 1) {
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2).catch(() => null))
      )
      for (const r of rest) {
        if (Array.isArray(r?.addons)) raw = raw.concat(r.addons)
      }
    }

    const addons = raw
      .map(normalize)
      .filter((a) => a.manifestUrl)
      // Most-starred first - the whole reason this route pre-fetches
      // everything. Ties fall back to name so ordering stays stable between
      // requests rather than reshuffling on every reload.
      .sort((a, b) => (b.stars - a.stars) || a.name.localeCompare(b.name))

    return addons
  }

  // Collapse concurrent sweeps into one, and keep whatever it returns.
  const refresh = () => {
    if (!inFlight) {
      inFlight = loadAll()
        .then((addons) => {
          cache = { at: Date.now(), addons }
          writeDisk(cache)
          return addons
        })
        .finally(() => { inFlight = null })
    }
    return inFlight
  }

  const getAddons = async () => {
    if (!cache && !diskRead) cache = readDisk()
    if (cache && cache.addons.length) {
      // A stale copy is served immediately and replaced in the background.
      // The listing changes on the order of days, so nobody needs to wait
      // on a sweep to see it - only the very first load on a new instance
      // has nothing to show, and that one still waits.
      if (Date.now() - cache.at >= CACHE_TTL_MS) refresh().catch(() => {})
      return { addons: cache.addons, cached: true }
    }
    return { addons: await refresh(), cached: false }
  }

  // Have it ready before anyone asks. Deliberately after a delay and
  // unref'd: it must not slow boot down, hold the process open, or race the
  // rest of startup for the network.
  const warmTimer = setTimeout(() => { getAddons().catch(() => {}) }, 8000)
  if (typeof warmTimer.unref === 'function') warmTimer.unref()

  // GET /api/addon-directory?page=&limit=&search=&category=
  router.get('/', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1)
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '24'), 10) || 24))
      const search = String(req.query.search || '').trim().slice(0, 100).toLowerCase()
      const category = String(req.query.category || '').trim().slice(0, 60).toLowerCase()

      const { addons: all, cached } = await getAddons()

      // Filtering happens here rather than upstream now that the full list is
      // local - same results, no network round-trip per keystroke, and it
      // keeps the star ordering that upstream filtering would not preserve.
      let filtered = all
      if (category) {
        filtered = filtered.filter((a) => a.categories.some((c) => String(c).toLowerCase() === category))
      }
      if (search) {
        filtered = filtered.filter((a) =>
          a.name.toLowerCase().includes(search) || a.description.toLowerCase().includes(search)
        )
      }

      const total = filtered.length
      const totalPages = Math.max(1, Math.ceil(total / limit))
      const safePage = Math.min(page, totalPages)
      const start = (safePage - 1) * limit

      return res.json({
        addons: filtered.slice(start, start + limit),
        pagination: {
          page: safePage,
          totalPages,
          total,
          hasNextPage: safePage < totalPages,
          hasPreviousPage: safePage > 1,
        },
        cached,
      })
    } catch (e) {
      const aborted = e?.name === 'AbortError'
      return res.status(aborted ? 504 : 502).json({
        error: aborted ? 'Addon directory timed out' : (e?.message || 'Failed to load the addon directory'),
      })
    }
  })

  return router
}
