'use client';

// The "Open titles with" list: pick the app this device opens titles in,
// "Any app (through a Shortcut)" and - on a real Jellyfin - "Play on a
// device". The inside of a panel, so the admin's title popup
// (OpenWithButton, in a ContextMenu) and a member's Continue Watching card
// (in an AnchoredPopup) show the very same thing.

import { useState } from 'react';
import { PlayIcon, CheckIcon } from '@heroicons/react/24/outline';
import {
  OPEN_WITH_APPS, WEB_APP, SHORTCUT_APP, rememberShortcut, rememberedShortcut,
  type OpenTargets, type OpenWithApp, type OpenWithAppId,
} from '@/lib/openWith';

const row = 'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-hover text-left';

export function OpenWithPicker({ targets, apps, currentId, onPick, onShortcutSaved, onPlayOn }: {
  targets: OpenTargets;
  /** The apps that can open this title (availableApps). */
  apps: OpenWithApp[];
  /** The one ticked: this device's pick, when it can open the title. */
  currentId: OpenWithAppId | null;
  onPick: (id: OpenWithAppId) => void;
  /** The Shortcut's names were just saved, so lists built from them are stale. */
  onShortcutSaved: () => void;
  onPlayOn: (device: OpenTargets['devices'][number]) => void;
}) {
  const [setup, setSetup] = useState(false);
  // The Shortcut's names while they're being typed.
  const [scDraft, setScDraft] = useState({ app: '', shortcut: '' });

  const startShortcut = () => {
    const sc = rememberedShortcut();
    setScDraft({ app: sc?.app || '', shortcut: sc?.shortcut || '' });
    setSetup(true);
  };
  const saveShortcut = () => {
    const app = scDraft.app.trim();
    const shortcut = scDraft.shortcut.trim() || (app ? `Open ${app}` : '');
    if (!shortcut) return;
    rememberShortcut({ app: app || 'your app', shortcut });
    onShortcutSaved();
    onPick('shortcut');
  };

  if (setup) {
    return (
      <div className="px-2 py-1">
        <div className="text-[15px] font-semibold text-default">Any app (through a Shortcut)</div>
        <div className="text-[13px] text-muted mb-2">Remembered on this device only</div>
        <label className="block text-[13px] text-muted mb-1">App name, for the button</label>
        <input className="input-base w-full px-3 py-2 text-[15px] mb-2.5" value={scDraft.app} placeholder="Odin"
          onChange={(e) => setScDraft((d) => ({ ...d, app: e.target.value }))} />
        <label className="block text-[13px] text-muted mb-1">Shortcut name</label>
        <input className="input-base w-full px-3 py-2 text-[15px]" value={scDraft.shortcut} placeholder={scDraft.app ? `Open ${scDraft.app}` : 'Open Odin'}
          onChange={(e) => setScDraft((d) => ({ ...d, shortcut: e.target.value }))} />
        <div className="text-[13px] text-muted mt-3 leading-relaxed">
          <span className="text-default font-medium">Make the Shortcut once:</span><br />
          1. Open the Shortcuts app and tap +.<br />
          2. Add the action <span className="text-default font-medium">Open App</span> and choose {scDraft.app.trim() || 'the app'}.<br />
          3. Name it <span className="text-default font-medium">{scDraft.shortcut.trim() || (scDraft.app.trim() ? `Open ${scDraft.app.trim()}` : 'Open Odin')}</span>.
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={() => setSetup(false)} className="px-3 rounded-lg text-default hover:bg-surface-hover">Back</button>
          <button type="button" onClick={saveShortcut} disabled={!scDraft.app.trim() && !scDraft.shortcut.trim()} className="px-3 rounded-lg font-semibold text-white disabled:opacity-50" style={{ background: 'var(--color-primary-solid)' }}>Use it</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="px-2 pt-1 pb-2">
        <div className="text-[15px] font-semibold text-default">Open titles with</div>
        <div className="text-[13px] text-muted">Your pick is remembered on this device only - each phone, tablet or TV keeps its own</div>
      </div>
      {[...OPEN_WITH_APPS, WEB_APP].filter((a) => apps.some((x) => x.id === a.id)).map((a) => (
        <button key={a.id} type="button" className={`${row} ${a.id === currentId ? 'bg-surface-hover' : ''}`} onClick={() => onPick(a.id)}>
          <span className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-xs font-extrabold text-white shrink-0" style={{ background: a.color }}>{a.letter}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] text-default truncate">{a.name}</span>
            <span className="block text-[13px] text-muted truncate">{a.platforms}</span>
          </span>
          {a.id === currentId && <CheckIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />}
        </button>
      ))}
      {(targets.servers?.length ?? 0) > 0 && (
        <button type="button" className={`${row} ${currentId === 'shortcut' ? 'bg-surface-hover' : ''}`} onClick={startShortcut}>
          <span className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-xs font-extrabold text-white shrink-0" style={{ background: SHORTCUT_APP.color }}>{SHORTCUT_APP.letter}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] text-default truncate">{currentId === 'shortcut' ? `${rememberedShortcut()?.app || 'Your app'} (through a Shortcut)` : SHORTCUT_APP.name}</span>
            <span className="block text-[13px] text-muted truncate">{SHORTCUT_APP.platforms}</span>
          </span>
          {currentId === 'shortcut' && <CheckIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />}
        </button>
      )}
      {targets.devices.length > 0 && (
        <>
          <div className="px-2 pt-2.5 pb-1 text-[12px] tracking-wide text-muted">PLAY ON A DEVICE · JELLYFIN</div>
          {targets.devices.map((d) => (
            <button key={`${d.address}|${d.sessionId}`} type="button" className={row} onClick={() => onPlayOn(d)}>
              <span className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-white shrink-0" style={{ background: 'var(--color-success)' }}><PlayIcon className="w-3.5 h-3.5" /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] text-default truncate">{d.device}</span>
                <span className="block text-[13px] text-muted truncate">{[d.client, d.person].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          ))}
        </>
      )}
      {apps.some((a) => a.id === 'swiftfin' || a.id === 'streamyfin') && (
        <div className="px-2 pt-2 mt-1.5 border-t border-default text-[13px] text-muted">The app needs to be signed in to that server already.</div>
      )}
    </>
  );
}
