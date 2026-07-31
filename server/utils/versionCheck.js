// "What's actually running" + "is a newer stable release out" for the
// Health page - answers a question this session's own deploy confusion kept
// running into by hand (docker exec-ing into the container to check which
// commit actually landed). APP_VERSION is baked into the image at build
// time (see Dockerfile + each release workflow's --build-arg) from the
// pushed tag name, e.g. "beta-v1.60.52" or "v1.60.0" - "dev" for a manual
// build with no tag context.

const REPO = 'slicknsliding/slicksync'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // GitHub's release feed changes rarely; avoid hitting their API on every Health load

let cache = { at: 0, latestRelease: null }

// Bare numeric parts only, e.g. "beta-v1.60.52" -> [1, 60, 52]. Returns null
// for anything that doesn't look like a version at all (a "dev" build).
function parseVersion(raw) {
  if (!raw) return null
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

async function fetchLatestStableRelease() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.latestRelease
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    clearTimeout(timeoutId)
    if (!res.ok) return cache.latestRelease // keep serving the last good value on a transient failure/rate-limit
    const data = await res.json()
    cache = { at: Date.now(), latestRelease: data?.tag_name || null }
    return cache.latestRelease
  } catch {
    return cache.latestRelease
  }
}

async function getVersionStatus() {
  const running = process.env.APP_VERSION || 'dev'
  const latestRelease = await fetchLatestStableRelease()
  const runningParsed = parseVersion(running)
  const latestParsed = parseVersion(latestRelease)
  const updateAvailable = !!(runningParsed && latestParsed && isNewer(latestParsed, runningParsed))
  return { running, latestRelease, updateAvailable }
}

module.exports = { getVersionStatus }
