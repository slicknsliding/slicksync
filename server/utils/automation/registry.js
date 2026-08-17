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
  // Fires on a recurring daily schedule rather than in response to
  // something happening elsewhere in the app - the odd one out among these
  // triggers, which is why it's the only one with its own triggerConfig
  // (hour/minute, account-timezone aware) instead of relying purely on
  // conditions. See automation/scheduler.js for the tick that fires this.
  'time.daily': {
    label: 'At a scheduled time each day',
    description: 'Fires once a day at the time you set below, in your account\'s timezone (Settings -> Privacy & Display).',
    fields: [
      { name: 'hour', label: 'Hour (0-23)', type: 'number' },
      { name: 'minute', label: 'Minute (0-59)', type: 'number' },
    ],
    // Distinct from `fields` (the event payload/condition fields) - this
    // describes the trigger's OWN configuration, only meaningful for a
    // schedule-driven trigger like this one. The rule builder shows a time
    // picker writing into rule.triggerConfig when this trigger is selected;
    // every other trigger type has no use for triggerConfig at all.
    triggerConfigFields: [
      { name: 'hour', label: 'Hour (0-23)', type: 'number', required: true },
      { name: 'minute', label: 'Minute (0-59)', type: 'number', required: true },
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
