// Off-box backup destinations + local retention.
//
// Scheduled backups already write JSON to data/backup/ on the same volume
// as the database they protect - which covers "I broke my config" but not
// "the VPS is gone", the case backups exist for. This ships every backup
// to a remote target as well, and bounds how many local copies pile up.
//
// Two protocols, chosen because between them they cover essentially every
// self-hosted setup with zero extra infrastructure:
//   s3      - AWS S3 and every S3-compatible service (Backblaze B2, Wasabi,
//             MinIO, Cloudflare R2, Storj...). Signed with SigV4 by hand;
//             no SDK dependency, since pulling aws-sdk in for one PUT would
//             add tens of megabytes to the image.
//   webdav  - Nextcloud/ownCloud, rsync.net, box.com, or any plain WebDAV
//             server. A PUT with basic auth.
//
// Settings live in the same instance-level JSON file pattern as
// dbMaintenance's (see its own comment for why a file rather than a schema
// column). The secret fields are stored as-is: this file already sits on
// the operator's own disk next to the backups themselves, and unlike the
// Vault (which holds OTHER people's credentials and is designed to survive
// a database leak) an instance's own backup-target key is only as
// protected as the box it runs on. Documented rather than pretended
// otherwise.
//
// Failure policy: a remote target failing NEVER fails the backup. The
// local copy is already written and validated by the time upload runs, and
// a backup that exists locally beats no backup because a bucket policy
// changed. Failures are logged and, when a prisma client is available,
// raised as a notification so it can't fail silently forever.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'backup-targets.json')

const DEFAULT_SETTINGS = {
  // 'none' | 's3' | 'webdav'
  type: 'none',
  // Local retention: how many backup files to keep in data/backup/. 0 = keep
  // everything (previous behaviour, still the default so an upgrade never
  // deletes anything an operator was relying on without them asking).
  keepLocal: 0,
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'slicksync/', accessKeyId: '', secretAccessKey: '' },
  webdav: { url: '', username: '', password: '' },
  // OPTIONAL passphrase: when set, uploads are AES-256-GCM encrypted under
  // a key scrypt-derived from it and land as .enc files; empty (the
  // default) uploads plain JSON exactly as before. Off-site copies carry
  // addon install URLs, which often embed API keys - encryption means a
  // leaked bucket leaks nothing. Local backups are NEVER encrypted (Time
  // Machine and per-user restore read them directly), so restores from
  // this box are unaffected; an .enc file is imported via the normal
  // config-import with its passphrase. Losing the passphrase makes the
  // remote copies unreadable - that's the deal, stated in the UI.
  encryptPassphrase: '',
}

/** Encrypts an upload body when a passphrase is configured; returns the
 * (possibly renamed) remote filename and (possibly encrypted) body. */
async function prepareUploadBody(settings, filePath, body) {
  const passphrase = String(settings.encryptPassphrase || '').trim()
  if (!passphrase) return { remotePath: filePath, body }
  const { scryptKey, aesGcmEncrypt } = require('./encryption')
  const salt = crypto.randomBytes(16).toString('base64')
  const key = await scryptKey(passphrase, salt)
  const payload = aesGcmEncrypt(key, body.toString('utf8'))
  return {
    remotePath: `${filePath}.enc`,
    body: Buffer.from(JSON.stringify({ slicksyncEncryptedBackup: 1, kdf: 'scrypt', salt, payload }), 'utf8'),
  }
}

function getSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      s3: { ...DEFAULT_SETTINGS.s3, ...(raw.s3 || {}) },
      webdav: { ...DEFAULT_SETTINGS.webdav, ...(raw.webdav || {}) },
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch }
  if (patch.s3) next.s3 = { ...getSettings().s3, ...patch.s3 }
  if (patch.webdav) next.webdav = { ...getSettings().webdav, ...patch.webdav }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

// --- S3 SigV4 -------------------------------------------------------------
// Minimal single-PUT signer. Only what an object upload needs: no
// multipart, no streaming payloads, no session tokens.
function sha256Hex(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex')
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

async function uploadToS3(cfg, filePath, body) {
  const { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey } = cfg
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 target is missing bucket or credentials')

  const key = `${(prefix || '').replace(/^\/+|\/+$/g, '')}${prefix ? '/' : ''}${path.basename(filePath)}`.replace(/^\/+/, '')
  // Path-style addressing against a custom endpoint (MinIO and friends
  // require it), virtual-host style against real AWS.
  const base = (endpoint || '').trim().replace(/\/+$/, '')
  const url = base
    ? `${base}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`
  const { host, pathname } = new URL(url)

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  // Each path segment is encoded, but the separators are not.
  const canonicalUri = pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/')
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return url
}

async function uploadToWebdav(cfg, filePath, body) {
  const { url, username, password } = cfg
  if (!url) throw new Error('WebDAV target is missing its URL')
  const target = `${url.replace(/\/+$/, '')}/${encodeURIComponent(path.basename(filePath))}`
  const headers = { 'content-type': 'application/json' }
  if (username) headers.authorization = `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`
  const res = await fetch(target, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`WebDAV upload failed (${res.status})`)
  return target
}

/** Ships one already-written backup file to the configured target. Never
 * throws - see the failure policy in this file's header. */
async function uploadBackup(filePath, prisma) {
  const settings = getSettings()
  if (settings.type === 'none') return { skipped: true }
  const QUIET = process.env.QUIET === 'true' || process.env.QUIET === '1'
  try {
    const raw = fs.readFileSync(filePath)
    const { remotePath, body } = await prepareUploadBody(settings, filePath, raw)
    const where = settings.type === 's3'
      ? await uploadToS3(settings.s3, remotePath, body)
      : await uploadToWebdav(settings.webdav, remotePath, body)
    if (!QUIET) console.log(`☁️  Backup uploaded to ${settings.type}: ${where}`)
    return { ok: true, location: where }
  } catch (e) {
    const message = e?.message || String(e)
    console.error(`⚠️ Remote backup upload failed (${settings.type}): ${message}`)
    if (prisma) {
      try {
        const { createNotification } = require('./notificationStore')
        await createNotification(prisma, 'default', {
          type: 'task',
          title: 'Off-site backup upload failed',
          body: `The local backup was written, but sending it to the ${settings.type} target failed: ${message}`,
          url: '/tasks',
          dedupeKey: 'backup-remote-failed',
        })
        // Same event surfaced to automation rules, so an operator can wire
        // their own action (webhook to an ops channel, etc.) rather than
        // relying only on the bell. Best-effort alongside the notification -
        // neither may break the caller, which has already written the local
        // backup successfully.
        const { emitAutomationEvent } = require('./automation/engine')
        await emitAutomationEvent(prisma, 'default', 'backup.failed', {
          target: settings.type,
          message,
        })
      } catch { /* notification is best-effort */ }
    }
    return { ok: false, error: message }
  }
}

/** Deletes the oldest local backups beyond `keepLocal`, with their sidecar
 * validation files. Only ever touches files this app itself wrote (the
 * config-backup*.json naming), never anything else sharing the directory. */
function pruneLocalBackups(backupDir) {
  const { keepLocal } = getSettings()
  if (!keepLocal || keepLocal < 1) return { pruned: 0 }
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => /^config-backup.*\.json$/.test(f) && !f.endsWith('.validation.json'))
      .map((f) => {
        const full = path.join(backupDir, f)
        return { full, mtime: fs.statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    let pruned = 0
    for (const file of files.slice(keepLocal)) {
      try {
        fs.unlinkSync(file.full)
        const sidecar = file.full.replace(/\.json$/, '.validation.json')
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
        pruned++
      } catch { /* leave anything we can't remove */ }
    }
    return { pruned }
  } catch {
    return { pruned: 0 }
  }
}

/** Round-trips a tiny object so an operator finds out the target is wrong
 * from a button press, not from a silent failure weeks later. */
async function testTarget(settings) {
  const type = settings?.type || getSettings().type
  if (type === 'none') return { ok: false, error: 'No target configured' }
  const probe = Buffer.from(JSON.stringify({ slicksync: 'backup-target-test', at: new Date().toISOString() }, null, 2))
  const name = `slicksync-target-test-${Date.now()}.json`
  const cfg = type === 's3' ? (settings.s3 || getSettings().s3) : (settings.webdav || getSettings().webdav)
  try {
    const where = type === 's3'
      ? await uploadToS3(cfg, name, probe)
      : await uploadToWebdav(cfg, name, probe)
    return { ok: true, location: where }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

module.exports = { getSettings, saveSettings, uploadBackup, pruneLocalBackups, testTarget, SETTINGS_FILE }
