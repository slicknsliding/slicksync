'use client';

// A person's Settings in the v2 page design: short rows grouped into You,
// Appearance, Privacy, Notifications and Apps that track for you. Deleting the
// account sits folded at the bottom, still behind its confirmation. Each group
// can be moved, folded and hidden.

import { useState, type ReactNode } from 'react';
import { ArrowPathIcon, BeakerIcon, ClipboardDocumentIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { ToggleSwitch } from '@/components/ui';
import { ArrangeButton, ArrangeBar, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { useCwTime, useFoldArrows, useNowPlayingProgress, useNowPlayingWho, usePageDesign, type PageArrange } from '@/lib/arrange';
import { useLayoutMode } from '@/lib/layout-mode';
import { MeHead, MeRow, MeRows, MeSeg } from './MeBits';
import { V2Button } from './V2Bits';

export const SETTINGS_SECTIONS = ['you', 'appearance', 'privacy', 'notifications', 'apps', 'leave'] as const;
const LABELS: Record<string, string> = {
  you: 'You', appearance: 'Appearance', privacy: 'Privacy', notifications: 'Notifications', apps: 'Apps that track for you', leave: 'Leave SlickSync',
};

export type SettingsV2Props = {
  arrange: PageArrange;
  providerLabel: string;
  // You
  picture: ReactNode;
  groupName?: string | null;
  memberSince: string;
  expires: string | null;
  // Appearance
  themeName: string;
  themeGrid: ReactNode;
  // Privacy
  visibility: { loaded: boolean; isPublic: boolean; busy: boolean; toggle: () => void };
  publicStats: { loaded: boolean; enabled: boolean; busy: boolean; url: string | null; toggle: () => void; copy: () => void };
  exportData: { busy: boolean; run: () => void };
  historyImport: ReactNode;
  // Notifications
  pushRow: ReactNode;
  watchNotify: { loaded: boolean; on: boolean; busy: boolean; toggle: () => void };
  webhook: { url: string; setUrl: (v: string) => void; save: () => void; test: () => void; testing: boolean };
  // Apps that track for you
  apiKey: { value: string | null; masked: string; visible: boolean; toggleVisible: () => void; copy: () => void; generate: () => void; generating: boolean; scrobbleUrl: string };
  // Leave
  onDelete: () => void;
};

export function MeSettingsV2(p: SettingsV2Props) {
  const { layoutMode, setLayoutMode } = useLayoutMode();
  const { design, setDesign } = usePageDesign();
  const { where, setWhere } = useNowPlayingWho();
  const { where: cwWhere, setWhere: setCwWhere } = useCwTime();
  const { where: npProgress, setWhere: setNpProgress } = useNowPlayingProgress();
  const { shown: arrows, setShown: setArrows } = useFoldArrows();
  const [themesOpen, setThemesOpen] = useState(false);

  const section = (key: string): ReactNode => {
    switch (key) {
      case 'you':
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="You" noun="section">
            <MeRows>
              <MeRow title="Your picture" line="Shown on your account button">{p.picture}</MeRow>
              <MeRow title="Group" line={`Member since ${p.memberSince}`}><b className="text-[14px]">{p.groupName || 'No group'}</b></MeRow>
              <MeRow title="Access" line={p.expires ? 'When your access ends' : 'Your access doesn’t run out'}>
                {p.expires ? <b className="text-[14px]" style={{ color: 'var(--color-warning)' }}>{p.expires}</b> : <span className="text-muted text-[13px]">Never ends</span>}
              </MeRow>
            </MeRows>
            <p className="text-muted text-[12.5px] mt-2.5">Your name and email come from your {p.providerLabel} account. To change them, change them in {p.providerLabel}.</p>
          </ArrangeSection>
        );
      case 'appearance':
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="Appearance" noun="section">
            <MeRows>
              <MeRow title="Colours" line={p.themeName}>
                <V2Button onClick={() => setThemesOpen((v) => !v)}>{themesOpen ? 'Done' : 'Change'}</V2Button>
              </MeRow>
              {themesOpen && <div className="py-3 border-t" style={{ borderColor: 'var(--color-surface-border)' }}>{p.themeGrid}</div>}
              <MeRow title="Layout" line="Top Navi or the sidebar">
                <MeSeg value={layoutMode} onChange={setLayoutMode} options={[{ key: 'nebula', label: 'Top Navi' }, { key: 'current', label: 'Sidebar' }]} />
              </MeRow>
              <MeRow title="Now Playing" line="Your app and room: under the picture, or on it">
                <MeSeg value={where} onChange={(w) => setWhere(w === 'on' ? 'on' : 'under')} options={[{ key: 'under', label: 'Under' }, { key: 'on', label: 'On the picture' }]} />
              </MeRow>
              <MeRow title="Now Playing progress" line="How far in and when it ends: on the picture, or under it">
                <MeSeg value={npProgress} onChange={(w) => setNpProgress(w === 'under' ? 'under' : 'on')} options={[{ key: 'on', label: 'On the picture' }, { key: 'under', label: 'Under' }]} />
              </MeRow>
              <MeRow title="Fold arrows" line="The arrow beside each section’s name. Hidden, tap a name to fold or unfold it">
                <MeSeg value={arrows} onChange={(v) => setArrows(v === 'hide' ? 'hide' : 'show')} options={[{ key: 'show', label: 'Show' }, { key: 'hide', label: 'Hide' }]} />
              </MeRow>
              <MeRow title="Continue Watching" line="Time left: on the picture, or under it with the episode name">
                <MeSeg value={cwWhere} onChange={(w) => setCwWhere(w === 'under' ? 'under' : 'on')} options={[{ key: 'on', label: 'On the picture' }, { key: 'under', label: 'Under' }]} />
              </MeRow>
              <MeRow title="Page design" line="Classic, or v2’s grouped sections">
                <MeSeg value={design} onChange={(d) => setDesign(d === 'v2' ? 'v2' : 'classic')} options={[{ key: 'classic', label: 'Classic' }, { key: 'v2', label: 'v2' }]} />
              </MeRow>
            </MeRows>
          </ArrangeSection>
        );
      case 'privacy':
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="Privacy" noun="section">
            <MeRows>
              {p.visibility.loaded && (
                <MeRow title="Who sees what you watch" line={p.visibility.isPublic ? 'Everyone in your household' : 'Only you'}>
                  <MeSeg
                    value={p.visibility.isPublic ? 'household' : 'me'}
                    onChange={(v) => { if ((v === 'household') !== p.visibility.isPublic && !p.visibility.busy) p.visibility.toggle(); }}
                    options={[{ key: 'me', label: 'Only me' }, { key: 'household', label: 'Household' }]}
                  />
                </MeRow>
              )}
              {p.publicStats.loaded && (
                <MeRow
                  title="Public stats page"
                  line={p.publicStats.enabled ? 'Anyone with the link can see your watch stats, no sign-in needed' : 'A link anyone can open, no sign-in needed'}
                >
                  {p.publicStats.enabled && p.publicStats.url && (
                    <>
                      <code className="text-xs px-2 py-1 rounded truncate max-w-[200px]" style={{ background: 'var(--color-subtle)', color: 'var(--color-text)' }}>{p.publicStats.url}</code>
                      <V2Button onClick={p.publicStats.copy}>Copy</V2Button>
                    </>
                  )}
                  <ToggleSwitch checked={p.publicStats.enabled} onChange={p.publicStats.toggle} disabled={p.publicStats.busy} title="Public stats page" />
                </MeRow>
              )}
              <MeRow title="Your data" line="Download your watch history and the household watchlist as a file">
                <V2Button onClick={p.exportData.run} disabled={p.exportData.busy}>{p.exportData.busy ? 'Exporting…' : 'Download'}</V2Button>
              </MeRow>
            </MeRows>
            {p.historyImport}
          </ArrangeSection>
        );
      case 'notifications':
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="Notifications" noun="section">
            {p.pushRow}
            <div className="mt-3">
              <MeRows>
                {p.watchNotify.loaded && (
                  <MeRow title="Watch notifications" line="Tell people (Discord and push) when you start or finish something">
                    <span className="text-[13px] font-medium" style={{ color: p.watchNotify.on ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted)' }}>{p.watchNotify.on ? 'On' : 'Off'}</span>
                    <ToggleSwitch checked={p.watchNotify.on} onChange={p.watchNotify.toggle} disabled={p.watchNotify.busy} title="Watch notifications" />
                  </MeRow>
                )}
                <MeRow title="Discord" line="Your own channel for share notifications. Set it and your watch notifications go here too; leave it blank to keep the shared channel." stack>
                  <div className="flex gap-2 w-full">
                    <input
                      type="url"
                      value={p.webhook.url}
                      onChange={(e) => p.webhook.setUrl(e.target.value)}
                      onBlur={() => { if (p.webhook.url) p.webhook.save(); }}
                      placeholder="https://discord.com/api/webhooks/…"
                      aria-label="Discord webhook"
                      className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg"
                      style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                    />
                    <V2Button onClick={p.webhook.test} disabled={p.webhook.testing || !p.webhook.url.trim()} icon={p.webhook.testing ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <BeakerIcon className="w-4 h-4" />}>Test</V2Button>
                  </div>
                </MeRow>
              </MeRows>
            </div>
          </ArrangeSection>
        );
      case 'apps':
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="Apps that track for you" noun="section">
            <MeRows>
              <MeRow title="Your API key" line="For your metrics and for scrobbling from other apps" stack>
                <div className="flex gap-2 w-full flex-wrap">
                  <div className="flex-1 min-w-[200px] flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-surface-border)' }}>
                    <code className="flex-1 text-sm font-mono truncate text-muted">{p.apiKey.masked}</code>
                    <button type="button" className="p-1 rounded text-muted" title={p.apiKey.visible ? 'Hide' : 'Show'} aria-label={p.apiKey.visible ? 'Hide key' : 'Show key'} onClick={p.apiKey.toggleVisible}>
                      {p.apiKey.visible ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                    <button type="button" className="p-1 rounded text-muted" title="Copy" aria-label="Copy key" disabled={!p.apiKey.value} onClick={p.apiKey.copy}>
                      <ClipboardDocumentIcon className="w-4 h-4" />
                    </button>
                  </div>
                  <V2Button onClick={p.apiKey.generate} disabled={p.apiKey.generating} icon={<ArrowPathIcon className={`w-4 h-4 ${p.apiKey.generating ? 'animate-spin' : ''}`} />}>{p.apiKey.value ? 'Rotate' : 'Generate'}</V2Button>
                </div>
              </MeRow>
              <MeRow title="Scrobble from other apps" line={<>Apps that can scrobble to a Trakt-compatible server (Infuse, Kodi’s Trakt add-on and others) can write into your SlickTrax history. Point the app’s custom Trakt server at <code className="px-1 py-0.5 rounded" style={{ background: 'var(--color-surface-elevated)' }}>{p.apiKey.scrobbleUrl}</code> and use your API key as the token.</>} />
            </MeRows>
          </ArrangeSection>
        );
      default:
        return (
          <ArrangeSection key={key} arrange={p.arrange} id={key} title="Leave SlickSync" meta="delete your account" noun="section">
            <div className="v2-box v2-box-pad flex items-center gap-4 flex-wrap" style={{ background: 'var(--color-error-muted)' }}>
              <div className="flex-1 min-w-[200px]">
                <div className="font-semibold text-[14.5px] text-default">Delete my account</div>
                <div className="text-muted text-[12.5px] mt-0.5">Deletes your own watch history, watchlist and account. It doesn’t touch the shared addons, groups or anyone else’s data. There is no undo.</div>
              </div>
              <button type="button" className="v2-btn" style={{ color: 'var(--color-error, #ef4444)' }} onClick={p.onDelete}>Delete account</button>
            </div>
          </ArrangeSection>
        );
    }
  };

  return (
    <div>
      <MeHead title="Settings" sub="Your own preferences" actions={<ArrangeButton arrange={p.arrange} />} />
      <ArrangeBar arrange={p.arrange} />
      {p.arrange.shown.map((k) => section(k))}
      <HiddenTray arrange={p.arrange} labelOf={(id) => LABELS[id] || id} />
    </div>
  );
}
