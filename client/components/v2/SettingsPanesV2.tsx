'use client';

// Settings in the v2 page design, one pane per tab: General, Sync,
// Notifications, Features and Security. (Integrations, Themes and About have
// their own files.) Each pane gets the same state and handlers the Classic
// page uses - nothing is saved any differently - and lays them out as short
// rows and tiles in sections that can be moved, folded and hidden.

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import {
  CheckIcon, ClipboardDocumentIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, PencilIcon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { Avatar } from '@/components/ui';
import { ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { PushNotificationToggle } from '@/components/ui/PushNotificationToggle';
import { WatchTrackingSettings } from '@/components/settings/WatchTrackingSettings';
import { openOnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { invalidatePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { api, type PasskeyRow, type PushDevice, type SyncSettings } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import type { PageArrange } from '@/lib/arrange';
import { V2Tiles } from './V2Detail';
import { V2Button } from './V2Bits';
import { V2Rows, V2SetRow, V2Switch, V2ToggleTile, V2Word, V2_SELECT_CLASS } from './SettingsV2';

type Sync = Partial<SyncSettings>;
type SaveOne = (key: keyof SyncSettings, value: unknown) => Promise<void>;

/** Draws a pane's sections in the account's order, then what is hidden. */
function Sections({ arrange, sections, labels, note }: {
  arrange: PageArrange;
  sections: Record<string, ReactNode>;
  labels: Record<string, string>;
  note?: string;
}) {
  return (
    <>
      {arrange.shown.map((k) => sections[k] ?? null)}
      <HiddenTray arrange={arrange} labelOf={(k) => labels[k] ?? k} note={note} />
    </>
  );
}

/** The word on a button that does something risky. */
const DANGER = { color: 'var(--color-error, #ef4444)', borderColor: 'color-mix(in srgb, var(--color-error, #ef4444) 40%, transparent)' } as const;

function DangerButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="v2-btn" style={DANGER} disabled={disabled} onClick={onClick}>{children}</button>;
}

// ---------------------------------------------------------------- General

export const GENERAL_KEYS = ['you', 'privacy', 'time'];
const GENERAL_LABELS = { you: 'You', privacy: 'Privacy and display', time: 'Time and finishing' };

export function GeneralV2({ arrange, isPublic, accountInfo, onPickAvatar, nickname, beginner, hideSensitive, onToggleHideSensitive, sync, save, timezones }: {
  arrange: PageArrange;
  isPublic: boolean;
  accountInfo: { uuid?: string | null; email?: string | null; avatarUrl?: string | null } | null;
  onPickAvatar: () => void;
  nickname: { draft: string; setDraft: (v: string) => void; onSave: () => void; saving: boolean };
  beginner: { on: boolean; set: (v: boolean) => void };
  hideSensitive: boolean;
  onToggleHideSensitive: () => void;
  sync: Sync;
  save: SaveOne;
  timezones: string[];
}) {
  const name = isPublic ? (accountInfo?.uuid || accountInfo?.email || 'Admin') : 'Administrator';
  const sections: Record<string, ReactNode> = {
    you: (
      <ArrangeSection key="you" arrange={arrange} id="you" title="You" noun="section">
        <V2Rows>
          <V2SetRow
            title="Your picture"
            also="Profile Picture"
            line="Shown on your account button and its menu"
            control={<><Avatar name={name} src={accountInfo?.avatarUrl || undefined} email={accountInfo?.email || undefined} size="md" /><V2Button onClick={onPickAvatar}>Change</V2Button></>}
          />
          {isPublic && (
            <V2SetRow
              title="Nickname"
              line="Your own name for this account, shown next to your UUID wherever this instance needs to tell accounts apart."
              below={(
                <div className="flex items-center gap-2 max-w-sm">
                  <input
                    type="text"
                    value={nickname.draft}
                    onChange={(e) => nickname.setDraft(e.target.value)}
                    onBlur={nickname.onSave}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="e.g. Movie Night"
                    maxLength={60}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Nickname"
                    className="input-base w-full px-3 py-2 text-sm"
                  />
                  {nickname.saving && <span className="text-xs text-muted shrink-0">Saving…</span>}
                </div>
              )}
            />
          )}
          <V2SetRow title="Welcome tour" line="Walk through SlickSync again" control={<V2Button onClick={openOnboardingWizard}>Replay</V2Button>} />
        </V2Rows>
      </ArrangeSection>
    ),
    privacy: (
      <ArrangeSection key="privacy" arrange={arrange} id="privacy" title="Privacy and display" noun="section">
        <V2Rows>
          <V2SetRow title="Beginner mode" also="Beginner Mode" line="A short explanation on each page, linking to its guide. Only for this device."
            control={<V2Switch on={beginner.on} onChange={beginner.set} label="Toggle beginner mode" />} />
          <V2SetRow title="Private mode" also="Private Mode" line="Hide emails, addresses and keys on screen"
            control={<V2Switch on={hideSensitive} onChange={onToggleHideSensitive} label="Toggle private mode" />} />
          <V2SetRow title="Custom addon names" also="Custom Addon Names" line="Show the names you gave addons instead of the originals"
            control={<V2Switch on={sync.useCustomFields || false} onChange={(v) => save('useCustomFields', v)} label="Toggle custom addon names" />} />
        </V2Rows>
      </ArrangeSection>
    ),
    time: (
      <ArrangeSection key="time" arrange={arrange} id="time" title="Time and finishing" noun="section">
        <V2Rows>
          <V2SetRow
            title="Timezone"
            line="What counts as “today” for watch time and streaks. Found from this browser the first time; change it here if you travel or move."
            control={(
              <select
                value={sync.accountTimezone || ''}
                onChange={(e) => save('accountTimezone', e.target.value)}
                aria-label="Timezone"
                className={V2_SELECT_CLASS}
                style={{ width: '12rem' }}
              >
                {sync.accountTimezone && !timezones.includes(sync.accountTimezone) && (
                  <option value={sync.accountTimezone}>{sync.accountTimezone}</option>
                )}
                {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            )}
          />
          <WatchTrackingSettings rows />
        </V2Rows>
      </ArrangeSection>
    ),
  };
  return <Sections arrange={arrange} sections={sections} labels={GENERAL_LABELS} />;
}

// ------------------------------------------------------------------- Sync

export const SYNC_KEYS = ['push'];

export function SyncV2({ arrange, sync, save }: { arrange: PageArrange; sync: Sync; save: SaveOne }) {
  const sections: Record<string, ReactNode> = {
    push: (
      <ArrangeSection key="push" arrange={arrange} id="push" title="How addons are pushed" noun="section">
        <V2Rows>
          <V2SetRow
            title="Fresh manifests"
            also="Advanced Sync"
            line="Re-read each addon’s live manifest before every sync, so new catalogs and updated resources get pushed too, not just what’s saved. Slower, because it asks every addon."
            control={<V2Switch on={sync.mode === 'advanced'} onChange={(v) => save('mode', v ? 'advanced' : 'normal')} label="Toggle fresh manifests" />}
          />
          <V2SetRow
            title="Skip confirmations"
            also="Unsafe Mode"
            line="Do destructive things without asking first. Not recommended."
            control={(
              <>
                {!sync.safe && <V2Word tone="bad">On</V2Word>}
                <V2Switch on={!sync.safe} onChange={(v) => save('safe', !v)} label="Toggle skipping confirmations" />
              </>
            )}
          />
        </V2Rows>
      </ArrangeSection>
    ),
  };
  return <Sections arrange={arrange} sections={sections} labels={{ push: 'How addons are pushed' }} />;
}

// ---------------------------------------------------------- Notifications

export const NOTIFICATION_KEYS = ['where', 'people', 'syncing', 'safe', 'recaps', 'devices'];
const NOTIFICATION_LABELS = {
  where: 'Where they go', people: 'People', syncing: 'Syncing and addons', safe: 'Keeping safe', recaps: 'Recaps', devices: 'Devices',
};

type Tile = { key: keyof SyncSettings; title: string; also: string; line: string; hint?: string; def?: boolean };

const PEOPLE_TILES: Tile[] = [
  { key: 'notifyOnActivity', title: 'Someone starts watching', also: 'Activity notifications', line: 'When a person starts something' },
  { key: 'notifyOnConnectionHealth', title: 'Sign-in stopped working', also: 'Connection problem notifications', line: 'And again when it’s back', def: true,
    hint: 'When someone’s Stremio, Nuvio or Jellyfin sign-in stops working (and again when it’s back), so their watching doesn’t go untracked unnoticed.' },
  { key: 'notifyOnNewDevice', title: 'New device', also: 'New device notifications', line: 'A stream from somewhere new',
    hint: 'When a person’s stream is seen from an IP address we haven’t confirmed for them before.' },
  { key: 'notifyOnInvite', title: 'Invites', also: 'Invite notifications', line: 'Requests and joins' },
];
const SYNCING_TILES: Tile[] = [
  { key: 'notifyOnSync', title: 'Sync finished', also: 'Sync notifications', line: 'When a sync completes' },
  { key: 'notifyOnAddonHealth', title: 'Addon down', also: 'Addon health notifications', line: 'When an addon fails over to its backup, and when it’s back' },
  { key: 'notifyOnProxyHealth', title: 'Proxy unreachable', also: 'Proxy connectivity notifications', line: 'Now Playing stops updating, and when it recovers',
    hint: 'When the AIOStreams proxy (Now Playing polling) goes unreachable or recovers.' },
];
const SAFE_TILES: Tile[] = [
  { key: 'notifyOnVault', title: 'Vault', also: 'Vault notifications', line: 'A key ending soon or failing its check' },
  { key: 'notifyOnBackup', title: 'Backup failed', also: 'Backup notifications', line: 'A good backup stays quiet',
    hint: 'Only if an automatic backup fails its check. A good backup stays silent; see its badge on Tasks.' },
  { key: 'notifyOnRecoveryKitStale', title: 'Recovery kit reminder', also: 'Recovery Kit reminders', line: 'When it’s over 60 days old',
    hint: 'A reminder when the Disaster Recovery Kit is over 60 days old (or was never exported) while the Vault holds credentials. Nothing is uploaded; the kit is only made when you export it yourself.' },
  { key: 'notifyOnUpdateAvailable', title: 'Update available', also: 'Update available notifications', line: 'A new SlickSync release',
    hint: 'When a newer stable SlickSync release is published (checked every 6 hours). It is also always shown on Metrics → Health.' },
];

export function NotificationsV2({ arrange, sync, setSync, save, saveMany, webhook, mosaic, devices }: {
  arrange: PageArrange;
  sync: Sync;
  setSync: Dispatch<SetStateAction<Sync>>;
  save: SaveOne;
  saveMany: (patch: Sync) => Promise<void>;
  webhook: { testing: boolean; onTest: () => void };
  mosaic: { generating: boolean; onGenerate: () => void };
  devices: {
    list: PushDevice[];
    editingId: string | null;
    setEditingId: (id: string | null) => void;
    label: string;
    setLabel: (v: string) => void;
    onRename: (id: string) => void;
    onRevoke: (id: string) => void;
    nameOf: (d: PushDevice) => string;
    guessName: (d: PushDevice) => string;
    isMobile: (d: PushDevice) => boolean;
    seenOf: (d: PushDevice) => string;
  };
}) {
  const isOn = (t: Tile) => (t.def ? sync[t.key] !== false : !!sync[t.key]);
  const group = (id: string, title: string, tiles: Tile[], extraFor?: (t: Tile) => ReactNode) => (
    <ArrangeSection key={id} arrange={arrange} id={id} title={title} meta={`${tiles.filter(isOn).length} of ${tiles.length} on`} noun="section">
      <V2Tiles wide={2}>
        {tiles.map((t) => (
          <V2ToggleTile key={t.key} title={t.title} also={t.also} line={t.line} hint={t.hint} on={isOn(t)} onChange={(v) => save(t.key, v)} extra={extraFor?.(t)} />
        ))}
      </V2Tiles>
    </ArrangeSection>
  );

  const hasHook = !!sync.webhookUrl?.trim();
  const digest = !sync.notifyDigestEnabled ? 'off' : (sync.notifyDigestFrequency || 'daily');
  const onDigest = (v: string) => {
    if (v === 'off') save('notifyDigestEnabled', false);
    else saveMany({ notifyDigestEnabled: true, notifyDigestFrequency: v === 'weekly' ? 'weekly' : 'daily' });
  };

  const sections: Record<string, ReactNode> = {
    where: (
      <ArrangeSection key="where" arrange={arrange} id="where" title="Where they go" noun="section">
        <V2Rows>
          <V2SetRow
            title="This phone"
            also="Phone notifications (PWA)"
            line="Native notifications on this device, even when SlickSync is closed. Install SlickSync to your home screen first."
            below={<PushNotificationToggle />}
          />
          <V2SetRow
            title="Discord"
            also="Webhook URL"
            line="Also post to a Discord channel (optional). Create a webhook in your Discord server’s settings and paste it here."
            control={<V2Button onClick={webhook.onTest} disabled={webhook.testing || !hasHook}>{webhook.testing ? 'Sending…' : 'Test'}</V2Button>}
            below={(
              <input
                type="url"
                value={sync.webhookUrl || ''}
                onChange={(e) => setSync((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                onBlur={() => save('webhookUrl', sync.webhookUrl)}
                placeholder="https://discord.com/api/webhooks/..."
                aria-label="Webhook URL"
                className="input-base w-full px-3 py-2 text-sm"
              />
            )}
          />
          <V2SetRow
            title="Digest"
            also="Digest mode"
            line="Bundle everything into one summary on a schedule instead of right away (also posts to Discord if a webhook is set)."
            control={(
              <select value={digest} onChange={(e) => onDigest(e.target.value)} aria-label="Digest" className={V2_SELECT_CLASS}>
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            )}
          />
        </V2Rows>
      </ArrangeSection>
    ),
    people: group('people', 'People', PEOPLE_TILES),
    syncing: group('syncing', 'Syncing and addons', SYNCING_TILES),
    safe: group('safe', 'Keeping safe', SAFE_TILES),
    recaps: (
      <ArrangeSection key="recaps" arrange={arrange} id="recaps" title="Recaps" meta={`${sync.notifyOnMosaic ? 1 : 0} of 1 on`} noun="section">
        <V2Tiles wide={2}>
          <V2ToggleTile
            title="Monthly poster mosaic"
            also="Monthly poster mosaic"
            line={hasHook ? 'On the 1st, a poster collage of everything watched last month, posted to Discord' : 'On the 1st, a text recap of last month. Add a Discord webhook for the poster collage.'}
            on={!!sync.notifyOnMosaic}
            onChange={(v) => save('notifyOnMosaic', v)}
            extra={<V2Button onClick={mosaic.onGenerate} disabled={mosaic.generating}>{mosaic.generating ? 'Working…' : 'Generate now'}</V2Button>}
          />
        </V2Tiles>
      </ArrangeSection>
    ),
    devices: devices.list.length > 0 ? (
      <ArrangeSection key="devices" arrange={arrange} id="devices" title="Devices" meta={String(devices.list.length)} noun="section">
        <p className="text-muted text-[12.5px] mb-3">Every browser or phone currently subscribed to push notifications on this account.</p>
        <V2Tiles wide={3}>
          {devices.list.map((d) => {
            const editing = devices.editingId === d.id;
            return (
              <div key={d.id} className="v2-tool" style={{ alignItems: 'center' }}>
                <span className="v2-tool-icon">
                  {devices.isMobile(d) ? <DevicePhoneMobileIcon className="w-[18px] h-[18px]" /> : <ComputerDesktopIcon className="w-[18px] h-[18px]" />}
                </span>
                <span className="flex-1 min-w-0">
                  {editing ? (
                    <span className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={devices.label}
                        onChange={(e) => devices.setLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') devices.onRename(d.id);
                          if (e.key === 'Escape') devices.setEditingId(null);
                        }}
                        placeholder={devices.guessName(d)}
                        aria-label="Device name"
                        className="input-base px-2 py-1 text-xs w-full"
                      />
                      <button type="button" aria-label="Save name" onClick={() => devices.onRename(d.id)} className="shrink-0 text-success"><CheckIcon className="w-4 h-4" /></button>
                      <button type="button" aria-label="Cancel" onClick={() => devices.setEditingId(null)} className="shrink-0 text-subtle"><XMarkIcon className="w-4 h-4" /></button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { devices.setEditingId(d.id); devices.setLabel(d.label || ''); }}
                      className="flex items-center gap-1.5 text-left max-w-full"
                      title="Rename this device"
                    >
                      <span className="font-semibold text-[14.5px] text-default truncate">{devices.nameOf(d)}</span>
                      <PencilIcon className="w-3.5 h-3.5 text-subtle shrink-0" />
                    </button>
                  )}
                  <span className="block text-muted text-[12.5px] mt-0.5">{devices.seenOf(d)}</span>
                </span>
                <button type="button" className="arrange-icon" aria-label={`Revoke ${devices.nameOf(d)}`} title="Revoke this device" onClick={() => devices.onRevoke(d.id)}>
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </V2Tiles>
      </ArrangeSection>
    ) : null,
  };
  return <Sections arrange={arrange} sections={sections} labels={NOTIFICATION_LABELS} />;
}

// --------------------------------------------------------------- Features

export const FEATURE_KEYS = ['discover', 'details', 'catalogs'];

type FeatureTile = { key: keyof SyncSettings; title: string; also: string; line: string; hint: string; on: (s: Sync) => boolean };

const DISCOVER_TILES: FeatureTile[] = [
  { key: 'enableWatchlist', title: 'Watchlist', also: 'Watchlist', line: 'Save titles for later', on: (s) => s.enableWatchlist !== false,
    hint: 'Bookmark items to watch later. Adds a ★ Watchlist source in Discover and an Add-to-Watchlist button on every detail page. Off: everything watchlist-related is hidden; saved items stay until you turn it back on.' },
  { key: 'enableWatchedIndicators', title: 'Watched ticks', also: 'Watched indicators', line: 'Mark what someone here has seen', on: (s) => s.enableWatchedIndicators !== false,
    hint: 'Show ✓ badges on Discover posters for things already watched (from either provider), the Unwatched / Watched filter, and the Mark-as-watched menu option. Off: none of those.' },
  { key: 'enableRecommendations', title: 'Recommendations', also: 'Recommendations', line: '“Because you watched” rows', on: (s) => s.enableRecommendations !== false,
    hint: 'The “Because you watched X” rows on the Dashboard, computed from your watch-history genres. Off: no recommendations panel and no genre computation.' },
  { key: 'animeSeasonalRow', title: 'Seasonal anime', also: 'Seasonal anime row', line: 'What’s airing this season', on: (s) => s.animeSeasonalRow === true,
    hint: 'Adds an “Airing this season” row to Discover with each show’s next-episode countdown, from AniList. No API key needed. Off unless someone in the household watches anime.' },
  { key: 'enablePosterRatings', title: 'Poster ratings', also: 'Poster ratings', line: 'IMDb and Rotten Tomatoes on posters', on: (s) => s.enablePosterRatings === true,
    hint: 'Show IMDb, Rotten Tomatoes and Metacritic score badges on every poster in Discover and Catalogs. Also the master switch for RPDB’s rating-embedded posters, if you’ve set a key.' },
  { key: 'enableWatchProviders', title: 'Where to stream', also: 'Streaming availability', line: 'Which services carry a title', on: (s) => s.enableWatchProviders !== false,
    hint: 'The “Also streaming on” row in a title’s details, showing subscription and free services that carry it (via TMDb / JustWatch).' },
];
const DETAIL_TILES: FeatureTile[] = [
  { key: 'enableWatchTogether', title: 'Spoiler guard', also: 'Spoiler guard', line: 'Warn when someone watches ahead', on: (s) => s.enableWatchTogether !== false,
    hint: 'The watch-ahead alarm: say on a show’s details who is watching it together, and anyone starting an episode another member hasn’t seen triggers a household alert. Off: the section disappears and no alerts fire.' },
  { key: 'enableReactions', title: 'Reactions', also: 'Reactions', line: 'Thumbs up or down that shape picks', on: (s) => s.enableReactions !== false,
    hint: 'Thumbs up or down on a title’s details. It feeds what SlickTrax recommends: titles like the ones you liked go up, ones like what you didn’t go down.' },
  { key: 'enableAutoplayTrailer', title: 'Autoplay trailer', also: 'Autoplay trailer', line: 'Starts the trailer when you open a title', on: (s) => s.enableAutoplayTrailer === true,
    hint: 'When you open a title, its trailer starts playing instead of waiting for a Play Trailer click.' },
];

export function FeaturesV2({ arrange, sync, setSync, save }: { arrange: PageArrange; sync: Sync; setSync: Dispatch<SetStateAction<Sync>>; save: SaveOne }) {
  // Same saving as Classic: save it, then tell the rest of the app to re-read.
  const personal = async (key: keyof SyncSettings, v: boolean) => { await save(key, v); invalidatePersonalFeatures(); };
  const seasonal = async (v: boolean) => {
    setSync((prev) => ({ ...prev, animeSeasonalRow: v }));
    try {
      await api.updateSyncSettings({ animeSeasonalRow: v });
      toast.success(v ? 'Seasonal anime row added to Discover' : 'Seasonal anime row hidden');
    } catch {
      toast.error('Could not save that setting');
      setSync((prev) => ({ ...prev, animeSeasonalRow: !v }));
    }
  };
  const tile = (t: FeatureTile) => (
    <V2ToggleTile key={t.key} title={t.title} also={t.also} line={t.line} hint={t.hint} on={t.on(sync)}
      onChange={(v) => (t.key === 'animeSeasonalRow' ? seasonal(v) : personal(t.key, v))} />
  );
  const autoplayOn = sync.enableAutoplayTrailer === true;
  const sections: Record<string, ReactNode> = {
    discover: (
      <ArrangeSection key="discover" arrange={arrange} id="discover" title="Discover" meta={`${DISCOVER_TILES.filter((t) => t.on(sync)).length} of ${DISCOVER_TILES.length} on`} noun="section">
        <V2Tiles wide={3}>{DISCOVER_TILES.map(tile)}</V2Tiles>
      </ArrangeSection>
    ),
    details: (
      <ArrangeSection key="details" arrange={arrange} id="details" title="A title’s details" meta={`${DETAIL_TILES.filter((t) => t.on(sync)).length + (sync.autoplayTrailerStartMuted === false && autoplayOn ? 1 : 0)} of ${DETAIL_TILES.length + 1} on`} noun="section">
        <V2Tiles wide={3}>
          {DETAIL_TILES.map(tile)}
          <V2ToggleTile
            title="… with sound"
            also="Autoplay with sound"
            line="Only when autoplay is on"
            hint="Whether the autoplayed trailer starts muted (the default) or with sound. A Play Trailer click always has sound."
            on={sync.autoplayTrailerStartMuted === false}
            disabled={!autoplayOn}
            onChange={(v) => personal('autoplayTrailerStartMuted', !v)}
          />
        </V2Tiles>
      </ArrangeSection>
    ),
    catalogs: (
      <ArrangeSection key="catalogs" arrange={arrange} id="catalogs" title="Catalogs" meta={`${sync.enableAutoThemedCatalogs === true ? 1 : 0} of 1 on`} noun="section">
        <V2Tiles wide={3}>
          <V2ToggleTile
            title="Made from what you watch"
            also="Auto-generated catalogs"
            line="Real catalogs from your tastes, checked daily"
            hint="Finds a real taste cluster in your watch history (a genre, or a genre and decade like “90s Action”) and saves it as an actual Catalog, such as “Your 90s Action Pack”. Checked daily; deleting a generated catalog stops it coming back. Off by default."
            on={sync.enableAutoThemedCatalogs === true}
            onChange={(v) => personal('enableAutoThemedCatalogs', v)}
          />
        </V2Tiles>
      </ArrangeSection>
    ),
  };
  return <Sections arrange={arrange} sections={sections} labels={{ discover: 'Discover', details: 'A title’s details', catalogs: 'Catalogs' }} />;
}

// --------------------------------------------------------------- Security

export const SECURITY_KEYS = ['signin', 'danger'];

export type SecurityProps = {
  arrange: PageArrange;
  isPublic: boolean;
  accountUuid: string | null;
  passkeys: { list: PasskeyRow[]; rpId: string | null; busy: boolean; supported: boolean; onAdd: () => void; onRemove: (id: string) => void };
  twoFa: {
    enabled: boolean | null;
    setup: { secret: string; qrCodeDataUrl: string } | null;
    setupCode: string; setSetupCode: (v: string) => void;
    enabling: boolean; startingSetup: boolean;
    onStart: () => void; onConfirm: () => void; onCancel: () => void;
    disablePrompt: boolean; setDisablePrompt: (v: boolean) => void;
    disableCode: string; setDisableCode: (v: string) => void;
    disabling: boolean; onDisable: () => void;
    regenPrompt: boolean; setRegenPrompt: (v: boolean) => void;
    regenCode: string; setRegenCode: (v: string) => void;
    regenerating: boolean; onRegenerate: () => void;
  };
  uuidCopied: boolean;
  onCopyUuid: () => void;
  onReset: () => void;
  onDeleteAccount: () => void;
};

export function SecurityV2({ arrange, isPublic, accountUuid, passkeys, twoFa, uuidCopied, onCopyUuid, onReset, onDeleteAccount }: SecurityProps) {
  const digits = (setter: (v: string) => void, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setter(e.target.value.replace(/\D/g, '').slice(0, max));

  const passkeyRow = (
    <V2SetRow
      title="Passkeys"
      line="Face ID, a fingerprint, a PIN or a security key. A passkey never replaces the password, so losing a device can never lock you out."
      control={!passkeys.supported
        ? <V2Word tone="off">Not on this browser</V2Word>
        : (
          <>
            <V2Word tone={passkeys.list.length ? 'ok' : 'off'}>{passkeys.list.length ? `${passkeys.list.length} added` : 'None yet'}</V2Word>
            <V2Button onClick={passkeys.onAdd} disabled={passkeys.busy}>{passkeys.busy ? 'Adding…' : 'Add'}</V2Button>
          </>
        )}
      below={passkeys.supported ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            A passkey belongs to the exact address you made it on{passkeys.rpId ? <> (this one is <span className="font-mono">{passkeys.rpId}</span>)</> : null}, so add one on each address you sign in from.
          </p>
          {passkeys.list.map((pk) => (
            <div key={pk.id} className="flex items-center justify-between gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-default truncate">{pk.name}</p>
                <p className="text-xs text-muted">
                  {pk.rpId ? <span className="font-mono">{pk.rpId}</span> : 'unknown address'}
                  {pk.rpId && passkeys.rpId && pk.rpId !== passkeys.rpId ? ' - not offered on this address' : ''}
                  {pk.lastUsedAt ? ` - last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : ' - never used'}
                </p>
              </div>
              <V2Button onClick={() => passkeys.onRemove(pk.id)}>Remove</V2Button>
            </div>
          ))}
        </div>
      ) : undefined}
    />
  );

  const codeInput = (value: string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void, onEnter: () => void, placeholder: string, label: string) => (
    <input
      type="text"
      inputMode="numeric"
      autoFocus
      value={value}
      onChange={onChange}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
      placeholder={placeholder}
      aria-label={label}
      className="input-base px-3 py-2 text-sm font-mono w-40"
    />
  );

  let twoFaControl: ReactNode = null;
  let twoFaBelow: ReactNode = null;
  if (twoFa.enabled === null) {
    twoFaControl = <V2Word tone="off">Loading…</V2Word>;
  } else if (twoFa.setup) {
    twoFaBelow = (
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={twoFa.setup.qrCodeDataUrl} alt="2FA QR code" className="w-40 h-40 rounded-lg border border-default bg-white p-2 shrink-0" />
          <div className="space-y-2 min-w-0">
            <p className="text-sm text-default">Scan this with your authenticator app (Google Authenticator, Authy, 1Password, etc.), or enter the code manually:</p>
            <code className="block text-xs font-mono text-muted break-all px-2 py-1.5 rounded bg-subtle border border-default">{twoFa.setup.secret}</code>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-default mb-1.5">Enter the 6-digit code it shows</label>
          <div className="flex gap-2 flex-wrap items-center">
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={twoFa.setupCode}
              onChange={digits(twoFa.setSetupCode, 6)}
              onKeyDown={(e) => { if (e.key === 'Enter') twoFa.onConfirm(); }}
              placeholder="123456"
              className="input-base px-3 py-2 text-sm font-mono tracking-widest w-32"
            />
            <V2Button primary onClick={twoFa.onConfirm} disabled={twoFa.setupCode.length !== 6 || twoFa.enabling}>{twoFa.enabling ? 'Checking…' : 'Confirm'}</V2Button>
            <V2Button onClick={twoFa.onCancel} disabled={twoFa.enabling}>Cancel</V2Button>
          </div>
        </div>
      </div>
    );
  } else if (twoFa.enabled) {
    twoFaControl = (
      <>
        <V2Word>On</V2Word>
        {!twoFa.disablePrompt && !twoFa.regenPrompt && (
          <>
            <V2Button onClick={() => twoFa.setRegenPrompt(true)}>New backup codes</V2Button>
            <DangerButton onClick={() => twoFa.setDisablePrompt(true)}>Turn off</DangerButton>
          </>
        )}
      </>
    );
    if (twoFa.disablePrompt) {
      twoFaBelow = (
        <div className="flex gap-2 items-center flex-wrap">
          {codeInput(twoFa.disableCode, digits(twoFa.setDisableCode, 8), twoFa.onDisable, 'Code or backup code', 'Code or backup code')}
          <DangerButton onClick={twoFa.onDisable} disabled={!twoFa.disableCode.trim() || twoFa.disabling}>{twoFa.disabling ? 'Turning off…' : 'Confirm turn off'}</DangerButton>
          <V2Button onClick={() => { twoFa.setDisablePrompt(false); twoFa.setDisableCode(''); }} disabled={twoFa.disabling}>Cancel</V2Button>
        </div>
      );
    } else if (twoFa.regenPrompt) {
      twoFaBelow = (
        <div className="flex gap-2 items-center flex-wrap">
          {codeInput(twoFa.regenCode, digits(twoFa.setRegenCode, 8), twoFa.onRegenerate, 'Current code', 'Current code')}
          <V2Button primary onClick={twoFa.onRegenerate} disabled={!twoFa.regenCode.trim() || twoFa.regenerating}>{twoFa.regenerating ? 'Making…' : 'Confirm'}</V2Button>
          <V2Button onClick={() => { twoFa.setRegenPrompt(false); twoFa.setRegenCode(''); }} disabled={twoFa.regenerating}>Cancel</V2Button>
        </div>
      );
    }
  } else {
    twoFaControl = (
      <>
        <V2Word tone="off">Off</V2Word>
        <V2Button primary onClick={twoFa.onStart} disabled={twoFa.startingSetup}>{twoFa.startingSetup ? 'Starting…' : 'Turn on'}</V2Button>
      </>
    );
  }

  const sections: Record<string, ReactNode> = {
    signin: (
      <ArrangeSection key="signin" arrange={arrange} id="signin" title="Signing in" noun="section">
        <V2Rows>
          {passkeyRow}
          <V2SetRow
            title="Two-step sign-in"
            also="Two-Factor Authentication"
            line={twoFa.enabled ? 'You’ll be asked for a code from your authenticator app each time you sign in.' : 'Ask for a code from an authenticator app when you sign in, on top of your password.'}
            control={twoFaControl}
            below={twoFaBelow}
          />
          {isPublic && accountUuid && (
            <V2SetRow
              title="Account ID"
              line="What you sign in with. Keep it handy for support."
              control={(
                <V2Button onClick={onCopyUuid} icon={uuidCopied ? <CheckIcon className="w-4 h-4" /> : <ClipboardDocumentIcon className="w-4 h-4" />}>
                  {uuidCopied ? 'Copied' : 'Copy'}
                </V2Button>
              )}
              below={<div className="px-3 py-2 rounded-xl text-sm font-mono truncate text-default" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>{accountUuid}</div>}
            />
          )}
        </V2Rows>
      </ArrangeSection>
    ),
    danger: (
      <ArrangeSection key="danger" arrange={arrange} id="danger" title="Danger zone" meta={isPublic ? 'reset or delete' : 'reset'} noun="section">
        <V2Rows>
          <V2SetRow title="Reset all settings" also="Reset All Settings" line="Put every setting back to its default" control={<DangerButton onClick={onReset}>Reset</DangerButton>} />
          {isPublic && (
            <V2SetRow
              title="Delete account"
              also="Delete Account"
              line="Permanently delete your SlickSync account and everything in it"
              control={<DangerButton onClick={onDeleteAccount}>Delete account</DangerButton>}
            />
          )}
        </V2Rows>
      </ArrangeSection>
    ),
  };
  return <Sections arrange={arrange} sections={sections} labels={{ signin: 'Signing in', danger: 'Danger zone' }} />;
}
