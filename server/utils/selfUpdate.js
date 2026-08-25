// Applying an update from inside the app, for operators who opt into it.
//
// The NOTIFY half of "one-click updates" already existed before this file:
// versionCheck.js compares running-vs-latest, the Health page's Version
// card shows it, and updateCheckNotifier.js pushes it. What was missing is
// actually doing something about it without SSHing into the box.
//
// Why this is opt-in and off by default: applying an update needs the
// Docker socket, and a container with the Docker socket mounted can do
// anything the host's Docker daemon can - which is effectively root on the
// host. That is a real, permanent security trade the operator must choose
// deliberately, not something a feature switches on for them. Without the
// socket, this module still does the genuinely useful, zero-risk half:
// reports what version is available and hands over the exact command.
//
// The update itself is deliberately ordered so the risky step is last and
// the recoverable state is established first:
//   1. Back up (the existing backup path, including any off-site target)
//   2. Pull the new image - network work only, nothing running changes; a
//      failed or interrupted pull leaves the current container untouched
//   3. Recreate the container from the new image
//
// Step 3 can't be done by this process directly: recreating the container
// kills the process issuing the request halfway through. So it is handed
// to a short-lived helper container that runs `docker compose up -d` for
// this container's own compose project and then exits - the same technique
// Watchtower uses, minus running a permanent extra service. The compose
// project/working-dir come from the labels Compose already writes onto
// every container it creates.

const http = require('http')

const DOCKER_SOCKET = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock'
const HELPER_IMAGE = process.env.SLICKSYNC_UPDATE_HELPER_IMAGE || 'docker:cli'

// Minimal Docker Engine API client over the unix socket - no dockerode
// dependency for what amounts to four calls.
function dockerRequest(method, path, body, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null) } catch { resolve(data) }
        } else {
          reject(new Error(`Docker API ${method} ${path} -> ${res.statusCode}: ${String(data).slice(0, 300)}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('Docker API request timed out')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** What this instance can actually do about an update right now. Safe to
 * call always - never throws, never changes anything. */
async function getUpdateCapability() {
  const result = {
    socketAvailable: false,
    canSelfUpdate: false,
    containerId: null,
    image: null,
    composeProject: null,
    composeWorkingDir: null,
    reason: '',
  }
  try {
    // Reading our own container: /proc/self/mountinfo and hostname both lie
    // in some runtimes, so ask Docker to identify the container whose id
    // matches this host's hostname (Compose sets it to the container id).
    const hostname = require('os').hostname()
    const info = await dockerRequest('GET', `/containers/${hostname}/json`, null, { timeoutMs: 5000 })
    result.socketAvailable = true
    result.containerId = info?.Id || hostname
    result.image = info?.Config?.Image || null
    const labels = info?.Config?.Labels || {}
    result.composeProject = labels['com.docker.compose.project'] || null
    result.composeWorkingDir = labels['com.docker.compose.project.working_dir'] || null

    if (!result.composeProject || !result.composeWorkingDir) {
      result.reason = 'This container was not created by Docker Compose, so it cannot be recreated automatically.'
    } else {
      result.canSelfUpdate = true
    }
  } catch (e) {
    result.reason = /ENOENT|EACCES/.test(e?.message || '')
      ? 'The Docker socket is not mounted into this container.'
      : `Could not talk to Docker: ${e?.message || e}`
  }
  return result
}

/** Pulls the newest image for this container's tag. Network-only: nothing
 * running is touched, so this is safe to offer even without self-update. */
async function pullLatestImage(image) {
  if (!image) throw new Error('No image name to pull')
  const [name, tag = 'latest'] = image.includes('@') ? [image, ''] : image.split(':')
  const path = `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag || 'latest')}`
  await dockerRequest('POST', path, null, { timeoutMs: 900000 })
  return { pulled: `${name}:${tag || 'latest'}` }
}

/** Backs up, pulls, then hands the recreate to a detached helper container.
 * Resolves as soon as the helper is running - this process is about to be
 * replaced by the recreate, so there is nothing to wait for. */
async function performSelfUpdate(prisma, opts = {}) {
  const cap = await getUpdateCapability()
  if (!cap.canSelfUpdate) {
    const err = new Error(cap.reason || 'Self-update is not available on this instance')
    err.status = 400
    throw err
  }

  // 1. Backup first. A failure here aborts the update - updating without a
  // fallback is exactly the situation backups exist to prevent.
  try {
    const { performBackupOnce } = require('./backup')
    await performBackupOnce(prisma, opts.backupOpts || {})
  } catch (e) {
    const err = new Error(`Refusing to update: the pre-update backup failed (${e?.message || e})`)
    err.status = 500
    throw err
  }

  // 2. Pull. Still non-destructive - on failure the running container is
  // untouched and the operator is exactly where they started.
  await pullLatestImage(cap.image)

  // 3. Recreate, via a helper that outlives us. `--no-deps <service>` so a
  // multi-service stack only recreates this app, and the working dir is
  // mounted at the same path so relative paths inside the compose file
  // still resolve.
  const service = cap.composeProject && cap.image ? (process.env.SLICKSYNC_COMPOSE_SERVICE || 'slicksync') : 'slicksync'
  const helper = await dockerRequest('POST', '/containers/create', {
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', `sleep 2; docker compose up -d --no-deps ${service}`],
    WorkingDir: cap.composeWorkingDir,
    HostConfig: {
      AutoRemove: true,
      Binds: [
        `${DOCKER_SOCKET}:/var/run/docker.sock`,
        `${cap.composeWorkingDir}:${cap.composeWorkingDir}`,
      ],
    },
  })
  await dockerRequest('POST', `/containers/${helper.Id}/start`, null, { timeoutMs: 15000 })

  return {
    started: true,
    helperId: helper.Id,
    image: cap.image,
    note: 'Update started - this instance will restart momentarily.',
  }
}

module.exports = { getUpdateCapability, pullLatestImage, performSelfUpdate }
