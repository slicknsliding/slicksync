import type { AutomationCondition, AutomationActionConfig } from '@/lib/api';

// One-click starting points for automation rules.
//
// The rule builder is genuinely capable, which also makes it a blank form
// with a trigger dropdown, a condition list and an action list - and nobody
// new to it knows what a good rule looks like. These are the rules people
// actually want, pre-filled, so the first useful automation costs one click
// and a save instead of an afternoon of reading.
//
// Deliberately NOT a separate execution path: picking a recipe opens the
// SAME rule editor with fields pre-populated, using the same prefill
// mechanism the addon page's "Automate" button already uses. Every recipe is
// therefore fully editable before saving, and produces an ordinary rule with
// nothing special about it afterwards.
//
// Every trigger referenced here is registered in
// server/utils/automation/registry.js - keep them in step; an unknown
// triggerType would leave the editor's trigger dropdown unset.

export interface AutomationRecipe {
  id: string;
  title: string;
  /** Plain-language description of what the finished rule does. */
  description: string;
  name: string;
  triggerType: string;
  conditions?: AutomationCondition[];
  actions?: AutomationActionConfig[];
  /** Shown when the recipe needs something filled in before it can be saved. */
  needs?: string;
}

export const AUTOMATION_RECIPES: AutomationRecipe[] = [
  {
    id: 'addon-down-notify',
    title: 'Tell me when an addon goes down',
    description: 'Sends a notification the moment any addon stops responding, so you find out before someone reports that streams stopped working.',
    name: 'Addon went offline',
    triggerType: 'addon.offline',
    actions: [{ type: 'notify', config: { title: 'Addon offline', body: 'An addon stopped responding.' } }],
  },
  {
    id: 'addon-back-notify',
    title: 'Tell me when an addon recovers',
    description: 'The other half of the pair - confirms an addon is working again without you having to go and check.',
    name: 'Addon back online',
    triggerType: 'addon.online',
    actions: [{ type: 'notify', config: { title: 'Addon back online', body: 'An addon is responding again.' } }],
  },
  {
    id: 'key-failed-notify',
    title: 'Tell me when an API key stops working',
    description: 'TMDb, OMDb, MDBList and RPDB keys fail silently - posters and ratings just quietly stop appearing. This turns that into an actual alert.',
    name: 'Metadata key failed',
    triggerType: 'metadata_key.failed',
    actions: [{ type: 'notify', config: { title: 'API key not working', body: 'A metadata provider key stopped working.' } }],
  },
  {
    id: 'backup-failed-notify',
    title: 'Tell me when an off-site backup fails',
    description: 'The local backup still gets written, but the copy going to S3/WebDAV did not arrive. Worth knowing immediately rather than the day you need it.',
    name: 'Off-site backup failed',
    triggerType: 'backup.failed',
    actions: [{ type: 'notify', config: { title: 'Off-site backup failed', body: 'The backup was written locally but did not reach the remote target.' } }],
  },
  {
    id: 'vault-expiring-notify',
    title: 'Tell me before a subscription expires',
    description: 'Fires on the lead time set for each Vault entry, so a debrid subscription never lapses without warning.',
    name: 'Vault entry expiring',
    triggerType: 'vault.expiring',
    actions: [{ type: 'notify', config: { title: 'Subscription expiring soon', body: 'A Vault entry is approaching its renewal date.' } }],
  },
  {
    id: 'new-user-sync',
    title: 'Sync every new user automatically',
    description: 'When someone new is added, push their addons straight away so they are ready to watch without a manual sync.',
    name: 'Sync new users',
    triggerType: 'user.created',
    actions: [{ type: 'user.sync', config: {} }],
  },
  {
    id: 'update-available-notify',
    title: 'Tell me when a SlickSync update is out',
    description: 'Fires once per new release when this instance is behind the latest published version.',
    name: 'Update available',
    triggerType: 'update.available',
    actions: [{ type: 'notify', config: { title: 'SlickSync update available', body: 'A newer release has been published.' } }],
  },
  {
    id: 'addon-down-webhook',
    title: 'Post to a webhook when an addon goes down',
    description: 'Same trigger as the first recipe, but sends it to Discord or any other webhook instead of the in-app bell.',
    name: 'Addon offline webhook',
    triggerType: 'addon.offline',
    actions: [{ type: 'webhook', config: { url: '' } }],
    needs: 'Add your webhook URL before saving.',
  },
  {
    id: 'key-failed-no-backup',
    title: 'Alert me only when a failed key has no spare',
    description: 'The louder half of the pair. Fires when a metadata key stops working and no backup key is set for it, so posters and ratings really have stopped. A key that fails with a backup behind it is handled by the quieter recipe below.',
    name: 'Metadata key failed with no backup',
    triggerType: 'metadata_key.failed',
    conditions: [{ field: 'hasBackup', op: 'is_false' }],
    actions: [{ type: 'notify', config: { title: 'API key down, no backup', body: 'A metadata provider key stopped working and has no backup key configured.' } }],
  },
  {
    id: 'key-failover-notify',
    title: 'Tell me when a backup key takes over',
    description: 'Nothing is broken for anyone using the app - the spare picked up the slack. Worth knowing anyway, because you are now running on your last key for that provider.',
    name: 'Backup metadata key took over',
    triggerType: 'metadata_key.failover_activated',
    actions: [{ type: 'notify', config: { title: 'Running on the backup key', body: 'A metadata key failed and its backup is now being used. Replace the primary when you can.' } }],
  },
  {
    id: 'vault-failover-notify',
    title: 'Tell me when a backup credential takes over',
    description: 'The Vault version of the same thing - a stored credential failed its check and its configured backup is now in use.',
    name: 'Backup credential took over',
    triggerType: 'vault.failover_activated',
    actions: [{ type: 'notify', config: { title: 'Running on the backup credential', body: 'A Vault credential failed its check and its backup is now being used.' } }],
  },
  {
    id: 'vault-failed-no-backup',
    title: 'Alert me when a credential fails with nothing to fall back on',
    description: 'Fires when a Vault credential stops working and no backup is set for it. Pair it with the recipe above to keep the urgent alerts separate from the informational ones.',
    name: 'Credential failed with no backup',
    triggerType: 'vault.check_failed',
    conditions: [{ field: 'hasBackup', op: 'is_false' }],
    actions: [{ type: 'notify', config: { title: 'Credential down, no backup', body: 'A Vault credential stopped working and has no backup configured.' } }],
  },
  {
    id: 'key-quota-failover-webhook',
    title: 'Post to a webhook when a key runs low',
    description: 'Sends quota warnings to Discord or anywhere else, so whoever tops the key up sees it without needing an admin login. Fires before the key runs out, not after.',
    name: 'Key quota low webhook',
    triggerType: 'metadata_key.quota_low',
    actions: [{ type: 'webhook', config: { url: '' } }],
    needs: 'Add your webhook URL before saving.',
  },
  {
    id: 'watch-finished-webhook',
    title: 'Send every finished title to a webhook',
    description: 'Fires once when something is genuinely finished (the real playback-position test, not just stopped) and posts it wherever you point it. Scrobble-out to anything that accepts HTTP - a dashboard, a Discord thread, your own script.',
    name: 'Finished title webhook',
    triggerType: 'watch.finished',
    actions: [{ type: 'webhook', config: { url: '' } }],
    needs: 'Add your webhook URL before saving.',
  },
  {
    id: 'nightly-extra-backup',
    title: 'Run an extra backup at an hour you choose',
    description: 'The nightly backup already runs on its own schedule; this adds another at whatever hour you set - useful before a nightly maintenance window, or just for belt-and-braces.',
    name: 'Extra scheduled backup',
    triggerType: 'time.daily',
    actions: [{ type: 'backup.run', config: {} }],
  },
];
