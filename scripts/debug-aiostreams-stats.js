// Read-only diagnostic - logs into AIOStreams the same way the proxy
// monitor does and dumps the RAW /api/v1/proxy/stats response, so we can
// see exactly what AIOStreams reports for a given setup while something is
// playing. Answers empirically: does this account's usenet / non-proxied
// debrid stream actually show up in the built-in proxy stats at all, or is
// it invisible to the only live signal SlickSync can poll?
//
// Run it WHILE a stream is actively playing. Makes no changes.
//
// Usage (env vars are already set inside the container):
//   docker exec -it slicksync node scripts/debug-aiostreams-stats.js

async function loginToAiostreams(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${res.statusText}`)
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('login ok but no Set-Cookie header')
  return setCookie.split(';')[0]
}

async function main() {
  const baseUrl = process.env.AIOSTREAMS_URL
  const username = process.env.AIOSTREAMS_AUTH_USERNAME
  const password = process.env.AIOSTREAMS_AUTH_PASSWORD

  if (!baseUrl || !username || !password) {
    console.error('Missing AIOSTREAMS_URL / AIOSTREAMS_AUTH_USERNAME / AIOSTREAMS_AUTH_PASSWORD env vars.')
    process.exit(1)
  }

  console.log(`AIOStreams base URL: ${baseUrl}`)
  const cookie = await loginToAiostreams(baseUrl, username, password)
  console.log('Logged in OK. Fetching /api/v1/proxy/stats ...\n')

  const res = await fetch(`${baseUrl}/api/v1/proxy/stats`, { headers: { Cookie: cookie } })
  if (!res.ok) throw new Error(`/proxy/stats failed: ${res.status} ${res.statusText}`)
  const stats = await res.json()

  console.log('=== RAW /api/v1/proxy/stats RESPONSE ===')
  console.log(JSON.stringify(stats, null, 2))

  // Quick summary of what the proxy monitor would actually see.
  const users = stats.users ?? []
  console.log('\n=== SUMMARY (what SlickSync\'s poller sees) ===')
  if (users.length === 0) {
    console.log('No users / no active connections reported. If something is playing right now,')
    console.log('it is NOT routing through AIOStreams\' built-in proxy - so SlickSync\'s live')
    console.log('proxy detection cannot see it (only the checkpoint-lagged native pipeline can).')
  }
  for (const u of users) {
    const active = u.active ?? []
    const history = u.history ?? []
    console.log(`user="${u.username}"  active=${active.length}  history=${history.length}`)
    for (const c of active) {
      console.log(`   ACTIVE  ip=${c.ip}  count=${c.count}  file="${c.filename || c.url}"`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
