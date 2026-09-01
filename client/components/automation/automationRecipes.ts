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
];
