// The catalog of what an automation rule can actually listen for and do.
//
// This file is the ONLY source of truth for that - the DB columns are
// stringified JSON and can hold anything, so every read path validates against
// these definitions rather than trusting what's stored. That matters because
// actions here are genuinely destructive (removing a user from a group changes
// which addons their device receives), and a malformed/stale rule row must fail
// closed rather than half-execute.
//
// Adding a trigger = add an entry here + call emitAutomationEvent() from
// wherever that thing actually happens. Adding an action = add an entry here
// with a run() implementation. Nothing else needs touching, including the UI,
// which builds its dropdowns from GET /api/automation/registry.

// ---- Triggers --------------------------------------------------------------
//
// `fields` is what the event payload carries, and doubles as the condition
// builder's field list in the UI. Keep field names stable - existing saved
// rules reference them by name.
const TRIGGERS = {
  'addon.offline': {
    label: 'An addon goes offline',
    description: 'Fires when the health checker sees an addon stop responding (once per transition, not once per check).',
    fields: [
      { name: 'addonName', label: 'Addon name', type: 'string' },
      { name: 'addonId', label: 'Addon ID', type: 'string' },
      { name: 'error', label: 'Error message', type: 'string' },
      { name: 'hasBackup', label: 'Has a backup addon', type: 'boolean' },
    ],
  },
  'addon.online': {
    label: 'An addon comes back online',
    description: 'Fires when an addon recovers after being offline.',
    fields: [
      { name: 'addonName', label: 'Addon name', type: 'string' },
      { name: 'addonId', label: 'Addon ID', type: 'string' },
    ],
  },
  'vault.expiring': {
    label: 'A vault credential is expiring',
    description: 'Fires from the vault monitor when an entry is inside its notify-days-before window.',
    fields: [
      { name: 'entryName', label: 'Entry name', type: 'string' },
      { name: 'entryId', label: 'Entry ID', type: 'string' },
      { name: 'category', label: 'Category', type: 'string' },
      { name: 'daysLeft', label: 'Days until expiry', type: 'number' },
    ],
  },
  'vault.check_failed': {
    label: 'A vault credential stops working',
    description: 'Fires when an entry\'s automated check goes from passing to failing.',
    fields: [
      { name: 'entryName', label: 'Entry name', type: 'string' },
      { name: 'entryId', label: 'Entry ID', type: 'string' },
      { name: 'category', label: 'Category', type: 'string' },
      { name: 'message', label: 'Failure message', type: 'string' },
      { name: 'hasBackup', label: 'Has a backup key', type: 'boolean' },
      { name: 'backupName', label: 'Backup key name', type: 'string' },
    ],
  },
  'vault.failover_activated': {
    label: 'A backup credential takes over',
    description: 'Fires when a credential fails its check and a working backup is configured, so the backup is what gets used from now on. Distinct from "stops working": this one means the spare picked up the slack, which is usually a quieter kind of news - but still worth knowing, because you are now running on your last key.',
    fields: [
      { name: 'entryName', label: 'Failed entry name', type: 'string' },
      { name: 'entryId', label: 'Failed entry ID', type: 'string' },
      { name: 'category', label: 'Category', type: 'string' },
      { name: 'backupName', label: 'Backup entry name', type: 'string' },
      { name: 'backupId', label: 'Backup entry ID', type: 'string' },
      { name: 'message', label: 'Why the primary failed', type: 'string' },
    ],
  },
  'user.expired': {
    label: 'A user\'s access expires',
    description: 'Fires when the expiration job retires a user whose expiresAt has passed.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'providerType', label: 'Provider', type: 'string' },
    ],
  },
  'user.sync_reverted': {
    label: 'A user\'s addons get reverted externally',
    description: 'Fires when Sync Guardian detects another client overwrote a synced user\'s addons outside SlickSync.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'providerType', label: 'Provider', type: 'string' },
    ],
  },
  'watch.started': {
    label: 'Someone starts watching',
    description: 'Fires when a live stream starts (the same event as the "started watching" notification). With the webhook action this is scrobble-out to anything that accepts HTTP.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'itemName', label: 'Title', type: 'string' },
      { name: 'itemId', label: 'IMDb ID', type: 'string' },
      { name: 'contentType', label: 'Type (movie/series)', type: 'string' },
    ],
  },
  'watch.finished': {
    label: 'A title is finished',
    description: 'Fires once when a watch crosses the real-completion threshold - the same playback-position test the history record uses, so it means genuinely finished, not merely stopped. Fires once per title per user - finishing cannot un-finish, so it cannot repeat.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'itemName', label: 'Title', type: 'string' },
      { name: 'itemId', label: 'IMDb ID', type: 'string' },
      { name: 'contentType', label: 'Type (movie/series)', type: 'string' },
      { name: 'season', label: 'Season (episodes only)', type: 'number' },
      { name: 'episode', label: 'Episode (episodes only)', type: 'number' },
    ],
  },
  'invite.accepted': {
    label: 'An invitation is accepted',
    description: 'Fires when someone completes an invite and their user is created.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'inviteCode', label: 'Invite code', type: 'string' },
      { name: 'providerType', label: 'Provider', type: 'string' },
    ],
  },
  // Broader than invite.accepted - fires for ANY new user, including ones
  // created directly from the Users page (Add User), which invite.accepted
  // never sees since there's no invite involved. Also fires for invited
  // users (both emit on the same creation), so a rule that genuinely only
  // cares about invites should still use invite.accepted for its inviteCode
  // field - this one carries no invite context at all.
  'user.created': {
    label: 'A new user is created',
    description: 'Fires for any new user - via an invitation or created directly from the Users page.',
    fields: [
      { name: 'username', label: 'Username', type: 'string' },
      { name: 'userId', label: 'User ID', type: 'string' },
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'providerType', label: 'Provider', type: 'string' },
    ],
  },
  'metadata_key.failed': {
    label: 'A metadata provider key stops working',
    description: 'Fires when a TMDb/OMDb/MDBList/RPDB key goes from working to failing (revoked, rate-limited, or otherwise rejected).',
    fields: [
      { name: 'provider', label: 'Provider', type: 'string' },
      { name: 'providerLabel', label: 'Provider name', type: 'string' },
      { name: 'message', label: 'Failure message', type: 'string' },
      { name: 'rateLimited', label: 'Rate limited', type: 'boolean' },
      { name: 'hasBackup', label: 'Has a backup key', type: 'boolean' },
    ],
  },
  'metadata_key.failover_activated': {
    label: 'A backup metadata key takes over',
    description: 'Fires when a TMDb/OMDb/MDBList/RPDB key fails its check and a backup key is configured for it, so lookups switch to the backup. Posters and ratings keep working - this is the alert that says you are now down to your spare.',
    fields: [
      { name: 'provider', label: 'Provider', type: 'string' },
      { name: 'providerLabel', label: 'Provider name', type: 'string' },
      { name: 'message', label: 'Why the primary failed', type: 'string' },
      { name: 'rateLimited', label: 'Rate limited', type: 'boolean' },
    ],
  },
  'metadata_key.recovered': {
    label: 'A metadata provider key starts working again',
    description: 'Fires when a previously-failing TMDb/OMDb/MDBList/RPDB key passes its check again.',
    fields: [
      { name: 'provider', label: 'Provider', type: 'string' },
      { name: 'providerLabel', label: 'Provider name', type: 'string' },
    ],
  },
  'metadata_key.quota_low': {
    label: 'A metadata provider key is running low on its quota',
    description: 'Fires when a provider that reports usage (currently MDBList) crosses a percentage of its allowance. Lets you react before it runs out and posters/ratings quietly stop appearing, rather than after.',
    fields: [
      { name: 'provider', label: 'Provider', type: 'string' },
      { name: 'providerLabel', label: 'Provider name', type: 'string' },
      { name: 'percentUsed', label: 'Percent used', type: 'number' },
      { name: 'used', label: 'Requests used', type: 'number' },
      { name: 'limit', label: 'Request limit', type: 'number' },
    ],
  },
  'backup.failed': {
    label: 'An off-site backup upload fails',
    description: 'Fires when a scheduled backup was written locally but could not be sent to the configured S3/WebDAV target. The local copy still exists - this is about the off-site copy not arriving.',
    fields: [
      { name: 'target', label: 'Target type', type: 'string' },
      { name: 'message', label: 'Failure message', type: 'string' },
    ],
  },
  'update.available': {
    label: 'A new SlickSync release is available',
    description: 'Fires once per new released version, when the running instance is behind the latest published release.',
    fields: [
      { name: 'latestVersion', label: 'Latest version', type: 'string' },
      { name: 'runningVersion', label: 'Running version', type: 'string' },
    ],
  },
  // Fires on a recurring daily schedule rather than in response to
  // something happening elsewhere in the app - the odd one out among these
  // triggers, which is why it's the only one with its own triggerConfig
  // (hour/minute, account-timezone aware) instead of relying purely on
  // conditions. See automation/scheduler.js for the tick that fires this.
  'time.daily': {
    label: 'At a scheduled time',
    description: 'Fires at the time you set below, in your account\'s timezone (Settings -> Privacy & Display). Pick days to run only on those days - leave them all off for every day.',
    fields: [
      { name: 'hour', label: 'Hour (0-23)', type: 'number' },
      { name: 'minute', label: 'Minute (0-59)', type: 'number' },
      // Which day it actually fired on, so a rule scheduled for several
      // days can still branch per-day with a condition (0 = Sunday).
      { name: 'weekday', label: 'Day of week (0=Sun)', type: 'number' },
    ],
    // Distinct from `fields` (the event payload/condition fields) - this
    // describes the trigger's OWN configuration, only meaningful for a
    // schedule-driven trigger like this one. The rule builder shows a time
    // picker writing into rule.triggerConfig when this trigger is selected;
    // every other trigger type has no use for triggerConfig at all.
    triggerConfigFields: [
      { name: 'hour', label: 'Hour (0-23)', type: 'number', required: true },
      { name: 'minute', label: 'Minute (0-59)', type: 'number', required: true },
      // Optional on purpose: an empty/absent list means every day, which is
      // exactly what every rule saved before this field existed has stored.
      // Keeping the trigger key as 'time.daily' rather than adding a separate
      // weekly trigger is what lets those rules keep working untouched.
      { name: 'days', label: 'Days', type: 'weekdays', hint: 'Leave all off to run every day.' },
    ],
  },
}

// ---- Condition operators ---------------------------------------------------

const OPERATORS = {
  eq: { label: 'is', apply: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() },
  neq: { label: 'is not', apply: (a, b) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase() },
  contains: { label: 'contains', apply: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()) },
  not_contains: { label: 'does not contain', apply: (a, b) => !String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()) },
  // Numeric comparisons coerce explicitly and refuse non-numbers rather than
  // falling through to JS's string comparison, which would make "10" < "9".
  lt: { label: 'is less than', apply: (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) < Number(b) },
  gt: { label: 'is greater than', apply: (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) > Number(b) },
  is_true: { label: 'is true', unary: true, apply: (a) => a === true || a === 'true' },
  is_false: { label: 'is false', unary: true, apply: (a) => a === false || a === 'false' || a === undefined || a === null },
}

// ---- Actions ---------------------------------------------------------------
//
// Each run() gets ({ prisma, accountId, config, payload }) and returns a short
// human-readable string describing what it did - that string is what lands in
// the run log, so it should name the actual thing acted on, not just "ok".
// Throwing is fine and expected: the engine records the failure per-action and
// keeps going with the rest of the rule.

const ACTIONS = {
  notify: {
    label: 'Send a notification',
    description: 'Sends through the same channels as everything else (push/bell primary, Discord if configured).',
    configFields: [
      { name: 'title', label: 'Title', type: 'string', required: true },
      { name: 'message', label: 'Message', type: 'text', required: true, hint: 'Use {{fieldName}} to insert values from the trigger, e.g. {{addonName}}.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const title = interpolate(config.title, payload)
      const message = interpolate(config.message, payload)
      const { notifyGeneric } = require('./notify')
      await notifyGeneric(prisma, accountId, title, message)
      return `Sent notification "${title}"`
    },
  },

  webhook: {
    label: 'Call a webhook',
    description: 'POSTs the trigger\'s data as JSON to a URL you choose - for reaching anything outside SlickSync\'s built-in channels (Home Assistant, ntfy, a custom script, n8n/Zapier, etc).',
    configFields: [
      { name: 'url', label: 'URL', type: 'string', required: true },
      { name: 'headers', label: 'Extra headers (optional)', type: 'text', hint: 'One per line, e.g. Authorization: Bearer xxx' },
    ],
    // Same trust model as the Discord webhook URL already configurable in
    // Settings - only an account admin can create/edit an automation rule,
    // so a URL pointed at an internal address is exactly as much (and no
    // more) of a concern as that existing feature already is. Not treating
    // this as a new attack surface requiring SSRF guarding the Discord path
    // never needed either.
    async run({ config, payload }) {
      const url = typeof config.url === 'string' ? config.url.trim() : ''
      if (!url) throw new Error('No webhook URL configured')
      let parsed
      try { parsed = new URL(url) } catch { throw new Error('Invalid webhook URL') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Webhook URL must be http or https')

      const headers = { 'Content-Type': 'application/json' }
      for (const line of String(config.headers || '').split('\n')) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const key = line.slice(0, idx).trim()
        const value = line.slice(idx + 1).trim()
        if (key) headers[key] = value
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload || {}), signal: controller.signal })
        if (!res.ok) throw new Error(`Webhook returned ${res.status}`)
        return `Called webhook (${res.status})`
      } finally {
        clearTimeout(timeoutId)
      }
    },
  },

  'addon.disable': {
    label: 'Disable an addon',
    description: 'Turns off a specific addon.',
    configFields: [
      { name: 'addonId', label: 'Addon', type: 'addon', required: true, hint: 'Leave blank to act on the addon from the trigger.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const addonId = config.addonId || payload.addonId
      if (!addonId) throw new Error('No addon specified and the trigger carried none')
      const addon = await prisma.addon.findFirst({ where: { id: addonId, accountId } })
      if (!addon) throw new Error('Addon not found on this account')
      await prisma.addon.update({ where: { id: addon.id }, data: { isActive: false } })
      return `Disabled addon "${addon.name}"`
    },
  },

  'addon.enable': {
    label: 'Enable an addon',
    description: 'Turns an addon back on.',
    configFields: [
      { name: 'addonId', label: 'Addon', type: 'addon', required: true, hint: 'Leave blank to act on the addon from the trigger.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const addonId = config.addonId || payload.addonId
      if (!addonId) throw new Error('No addon specified and the trigger carried none')
      const addon = await prisma.addon.findFirst({ where: { id: addonId, accountId } })
      if (!addon) throw new Error('Addon not found on this account')
      await prisma.addon.update({ where: { id: addon.id }, data: { isActive: true } })
      return `Enabled addon "${addon.name}"`
    },
  },

  'keys.check': {
    label: 'Run an API key check now',
    description: 'Tests the configured TMDb/OMDb/MDBList/RPDB keys immediately and records the results - the same check "Check keys now" and the daily sweep run. Pairs with "At a scheduled time" for more-than-daily checking, or with a recovery trigger to confirm a fix.',
    configFields: [],
    async run({ prisma, accountId }) {
      const { checkAndPersistAccountKeys } = require('../metadataKeyHealth')
      const keyHealth = await checkAndPersistAccountKeys(prisma, accountId, { notify: true })
      const checked = Object.keys(keyHealth || {})
      const failing = checked.filter((k) => keyHealth[k] && keyHealth[k].ok === false)
      if (checked.length === 0) return 'No API keys configured to check'
      return failing.length === 0
        ? `Checked ${checked.length} key(s) - all working`
        : `Checked ${checked.length} key(s) - failing: ${failing.join(', ')}`
    },
  },

  // Failover already happens on its own the moment a primary key goes bad -
  // requests quietly use the backup. What failover does NOT do is make that
  // permanent: the dead key stays "primary", every lookup keeps consulting
  // health state to route around it, and addons that embed the key keep
  // carrying a corpse. This action completes the succession: the backup
  // becomes the primary, the failed key becomes the (dead) backup - nothing
  // is discarded, so it is fully reversible by hand - and rotation
  // propagation rewrites any addon still embedding the old key.
  //
  // Previously shelved as "promotion semantics too ambiguous to automate";
  // the swap definition above is the disambiguation, and the user asked for
  // exactly this pairing (2026-09-02).
  'keys.promote_backup': {
    label: 'Promote the backup key to primary',
    description: 'Makes a failover permanent: swaps the failed key with its backup (for a Settings metadata key or a Vault credential), so the working key IS the primary instead of being routed to around a dead one. The old key is kept as the new backup - nothing is thrown away. Addons that embed the old key are rewritten and re-synced automatically. Acts on the key named by the trigger; pair it with "A backup key/credential takes over".',
    configFields: [],
    async run({ prisma, accountId, payload }) {
      const reqLike = { appAccountId: accountId }
      const { encrypt, decrypt, getDecryptedManifestUrl } = require('../encryption')
      const { manifestUrlHmac } = require('../hashing')
      const { propagateSecretRotation } = require('../keyRotation')
      const rotationDeps = { encrypt, decrypt, getDecryptedManifestUrl, manifestUrlHmac }

      // Vault credential path (vault.failover_activated / vault.check_failed)
      if (payload?.entryId) {
        const entry = await prisma.vaultEntry.findFirst({ where: { id: payload.entryId, accountId } })
        if (!entry) throw new Error('The failed Vault entry no longer exists')
        const backupId = payload.backupId || entry.backupEntryId
        if (!backupId) throw new Error(`"${entry.name}" has no backup credential to promote`)
        const backup = await prisma.vaultEntry.findFirst({ where: { id: backupId, accountId } })
        if (!backup) throw new Error('The backup credential no longer exists')

        let oldSecret = null, newSecret = null
        try { oldSecret = decrypt(entry.encryptedSecret, reqLike) } catch {}
        try { newSecret = decrypt(backup.encryptedSecret, reqLike) } catch {}
        if (!newSecret) throw new Error('Could not decrypt the backup credential')

        // Swap the SECRETS, not the rows: everything that references the
        // primary entry (vault-injected addons, failover pairs) keeps
        // pointing at the same entry id, which now carries the working key.
        await prisma.$transaction([
          prisma.vaultEntry.update({ where: { id: entry.id }, data: { encryptedSecret: backup.encryptedSecret, lastCheckStatus: 'unknown', lastCheckMessage: 'Promoted from backup - awaiting first check' } }),
          prisma.vaultEntry.update({ where: { id: backup.id }, data: { encryptedSecret: entry.encryptedSecret, lastCheckStatus: 'unknown', lastCheckMessage: 'Demoted failed primary - replace this key' } }),
        ])

        let rotated = 0
        if (oldSecret && oldSecret !== newSecret) {
          try {
            const rotation = await propagateSecretRotation(prisma, reqLike, rotationDeps, { accountId, oldSecret, newSecret })
            rotated = rotation.addonsUpdated?.length || 0
          } catch (e) {
            console.warn('[Automation] promote_backup rotation failed:', e?.message)
          }
        }
        return `Promoted "${backup.name}" over "${entry.name}"${rotated ? ` and rewrote ${rotated} addon(s)` : ''} - the failed key is kept as the backup`
      }

      // Settings metadata-key path (metadata_key.failed / failover_activated)
      const FIELD_BY_PROVIDER = { tmdb: 'tmdbApiKey', omdb: 'omdbApiKey', mdblist: 'mdblistApiKey', rpdb: 'rpdbApiKey' }
      const provider = payload?.provider
      const field = FIELD_BY_PROVIDER[provider]
      if (!field) throw new Error('The trigger named no key to promote - pair this action with a key-failure or failover trigger')

      const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
      let cfg = acc?.sync
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
      if (!cfg || typeof cfg !== 'object') cfg = {}
      const primary = typeof cfg[field] === 'string' ? cfg[field].trim() : ''
      const backupKey = typeof cfg[`${field}Backup`] === 'string' ? cfg[`${field}Backup`].trim() : ''
      if (!backupKey) throw new Error(`No backup ${payload?.providerLabel || provider} key is configured to promote`)

      cfg[field] = backupKey
      cfg[`${field}Backup`] = primary // the dead key becomes the backup - kept, not discarded
      // Reset this provider's health so lookups stop routing around a
      // "failed primary" that is now the working key, and the next check
      // records the truth fresh.
      if (cfg.keyHealth && cfg.keyHealth[provider]) delete cfg.keyHealth[provider]
      await prisma.appAccount.update({ where: { id: accountId }, data: { sync: JSON.stringify(cfg) } })

      let rotated = 0
      if (primary && primary !== backupKey) {
        try {
          const rotation = await propagateSecretRotation(prisma, reqLike, rotationDeps, { accountId, oldSecret: primary, newSecret: backupKey })
          rotated = rotation.addonsUpdated?.length || 0
        } catch (e) {
          console.warn('[Automation] promote_backup rotation failed:', e?.message)
        }
      }
      return `Promoted the backup ${payload?.providerLabel || provider} key to primary${rotated ? ` and rewrote ${rotated} addon(s)` : ''} - the failed key is kept as the backup`
    },
  },

  'backup.run': {
    label: 'Run a backup now',
    description: 'Writes a backup immediately, in addition to the nightly schedule - and uploads it off-site if a remote target is configured. Pairs with "At a scheduled time" for an extra daily backup at an hour you choose.',
    configFields: [],
    async run({ prisma }) {
      // Private-instance action: performBackupOnce with no public-mode deps
      // backs up the single account this instance is. On a public instance
      // one tenant's rule must not trigger instance-wide backup work, so it
      // declines rather than half-working - the nightly schedule covers
      // tenants there.
      const { INSTANCE_TYPE } = require('../config')
      if (INSTANCE_TYPE === 'public') throw new Error('Not available on this instance - nightly backups already cover it')
      const { performBackupOnce } = require('../backup')
      const result = await performBackupOnce(prisma, {})
      return result === false ? 'Backup failed - see server logs' : 'Backup written'
    },
  },

  'user.add_to_group': {
    label: 'Add a user to a group',
    description: 'Adds the user from the trigger (or a specific one) to a group.',
    configFields: [
      { name: 'groupId', label: 'Group', type: 'group', required: true },
      { name: 'userId', label: 'User', type: 'user', hint: 'Leave blank to act on the user from the trigger.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const userId = config.userId || payload.userId
      if (!userId) throw new Error('No user specified and the trigger carried none')
      const [group, user] = await Promise.all([
        prisma.group.findFirst({ where: { id: config.groupId, accountId } }),
        prisma.user.findFirst({ where: { id: userId, accountId } }),
      ])
      if (!group) throw new Error('Group not found on this account')
      if (!user) throw new Error('User not found on this account')
      const ids = parseIdList(group.userIds)
      if (ids.includes(userId)) return `${user.username} was already in "${group.name}"`
      await prisma.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify([...ids, userId]) } })
      return `Added ${user.username} to "${group.name}"`
    },
  },

  // The action this feature was most conspicuously missing. Syncing is
  // SlickSync's core operation, yet an automation could notify you about
  // things, flip addons and shuffle group membership - and not actually push
  // addons to anyone. Together with day-of-week scheduling on time.daily,
  // this is what makes "every Sunday at 3am, sync everyone" expressible.
  'user.sync': {
    label: 'Sync users',
    description: "Runs the same sync as the Sync button - pushes each user's assigned addons to their provider.",
    configFields: [
      {
        name: 'scope', label: 'Who to sync', type: 'select', required: true,
        options: [
          { value: 'trigger', label: 'The user from the trigger' },
          { value: 'user', label: 'A specific user' },
          { value: 'group', label: 'Everyone in a group' },
          { value: 'all', label: 'Every active user' },
        ],
        hint: 'A scheduled trigger carries no user, so pick a specific user, a group, or everyone.',
      },
      { name: 'userId', label: 'User', type: 'user', hint: 'Used when "A specific user" is selected.' },
      { name: 'groupId', label: 'Group', type: 'group', hint: 'Used when "Everyone in a group" is selected.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const { syncUserAddons } = require('../../routes/users')
      const { decrypt } = require('../encryption')

      const scope = config.scope || 'trigger'
      let userIds = []
      let what = ''

      if (scope === 'all') {
        const users = await prisma.user.findMany({ where: { accountId, isActive: true }, select: { id: true } })
        userIds = users.map((u) => u.id)
        what = 'every active user'
      } else if (scope === 'group') {
        const group = await prisma.group.findFirst({ where: { id: config.groupId, accountId } })
        if (!group) throw new Error('Group not found on this account')
        // Re-check against the users table: userIds is a JSON blob that can
        // still name someone deleted or deactivated since it was written.
        const users = await prisma.user.findMany({
          where: { id: { in: parseIdList(group.userIds) }, accountId, isActive: true },
          select: { id: true },
        })
        userIds = users.map((u) => u.id)
        what = '"' + group.name + '"'
      } else {
        const userId = scope === 'user' ? config.userId : payload.userId
        if (!userId) throw new Error('No user specified and the trigger carried none')
        const user = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { id: true } })
        if (!user) throw new Error('User not found on this account')
        userIds = [user.id]
        what = 'the user'
      }

      if (userIds.length === 0) return 'Nothing to sync - ' + what + ' has no active users'

      // There is no HTTP request behind a scheduled run, so hand syncUserAddons
      // the same minimal req-like shape invitations.js already uses for its
      // sync-on-join. appAccountId is what it scopes every query by.
      const reqLike = { appAccountId: accountId, headers: {} }
      let synced = 0
      const failures = []
      for (const id of userIds) {
        try {
          const result = await syncUserAddons(prisma, id, [], false, reqLike, decrypt, () => accountId, true)
          if (result && result.success) synced++
          else failures.push((result && result.error) || 'unknown error')
        } catch (e) {
          failures.push((e && e.message) || 'unknown error')
        }
      }

      // Partial failure is reported, not thrown: the run log should say what
      // actually happened rather than hiding the successes behind an
      // exception. A total failure does throw, so the rule is marked failed.
      if (synced === 0) throw new Error('Sync failed for all ' + userIds.length + ' user(s): ' + (failures[0] || 'unknown error'))
      return 'Synced ' + synced + '/' + userIds.length + ' user(s) in ' + what + (failures.length ? ', ' + failures.length + ' failed' : '')
    },
  },

  'user.remove_from_group': {
    label: 'Remove a user from a group',
    description: 'Removes the user from the trigger (or a specific one) from a group.',
    configFields: [
      { name: 'groupId', label: 'Group', type: 'group', required: true },
      { name: 'userId', label: 'User', type: 'user', hint: 'Leave blank to act on the user from the trigger.' },
    ],
    async run({ prisma, accountId, config, payload }) {
      const userId = config.userId || payload.userId
      if (!userId) throw new Error('No user specified and the trigger carried none')
      const [group, user] = await Promise.all([
        prisma.group.findFirst({ where: { id: config.groupId, accountId } }),
        prisma.user.findFirst({ where: { id: userId, accountId } }),
      ])
      if (!group) throw new Error('Group not found on this account')
      if (!user) throw new Error('User not found on this account')
      const ids = parseIdList(group.userIds)
      if (!ids.includes(userId)) return `${user.username} was not in "${group.name}"`
      await prisma.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(ids.filter((i) => i !== userId)) } })
      return `Removed ${user.username} from "${group.name}"`
    },
  },
}

// ---- Helpers ---------------------------------------------------------------

function parseIdList(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/**
 * {{field}} substitution for notification text. Deliberately dumb: only
 * replaces known top-level payload keys, leaves an unknown {{token}} visibly
 * intact rather than blanking it - a notification reading "addon {{addnName}}
 * is down" is a typo the admin can see and fix; one reading "addon  is down"
 * looks like a bug in the app.
 */
function interpolate(template, payload) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(payload || {}, key) ? String(payload[key] ?? '') : whole
  ))
}

/** Shape returned to the client so the rule builder's dropdowns stay in lockstep with this file. */
function describeRegistry() {
  return {
    triggers: Object.entries(TRIGGERS).map(([type, t]) => ({
      type, label: t.label, description: t.description, fields: t.fields,
      ...(t.triggerConfigFields ? { triggerConfigFields: t.triggerConfigFields } : {}),
    })),
    operators: Object.entries(OPERATORS).map(([op, o]) => ({ op, label: o.label, unary: !!o.unary })),
    actions: Object.entries(ACTIONS).map(([type, a]) => ({
      type, label: a.label, description: a.description, configFields: a.configFields,
    })),
  }
}

module.exports = { TRIGGERS, OPERATORS, ACTIONS, describeRegistry, interpolate, parseIdList }
