'use client';

// "Open in …" on a title popup, for anyone here on Jellyfin, AIOStreams or
// AIOMetadata: the main part opens the title in the app this device chose
// (lib/openWith.ts), the arrow picks the app - and on a real Jellyfin, "Play
// on a device" starts it on a device that has a Jellyfin app open. The picker
// uses the shared ContextMenu, so it always stays whole on screen. In TV mode
// only "Play on a device" shows (TVPlayOnDevice).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PlayIcon, ChevronDownIcon, TvIcon } from '@heroicons/react/24/outline';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { OpenWithPicker, PlayOnDeviceList } from '@/components/ui/OpenWithPicker';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { useTVModal } from '@/components/tv/useTVModal';
import { placeAtPill, popupStyle, useFitPopup, useFollowAnchor, type OutsidePlacement } from '@/lib/anchoredPopup';
import { AppOpenNote } from '@/components/ui/AppOpenNote';
import { toast } from '@/components/ui/Toast';
import { useAppOpenCheck } from '@/lib/useAppOpenCheck';
import { api } from '@/lib/api';
import {
  availableApps, linksFor, rememberApp, rememberedApp, rememberedShortcut, type OpenTargets, type OpenWithAppId,
} from '@/lib/openWith';

const cache = new Map<string, Promise<OpenTargets>>();
function loadTargets(id: string, type: 'movie' | 'series') {
  const key = `${type}:${id}`;
  if (!cache.has(key)) cache.set(key, api.getOpenTargets(id, type).catch(() => ({ servers: [], devices: [], tmdbId: null })));
  return cache.get(key)!;
}

const STYLE = {
  background: 'linear-gradient(110deg, rgba(212, 208, 255, 0.13), rgba(124, 111, 240, 0.22))',
  color: 'rgb(212, 208, 255)',
  border: '1px solid rgba(159, 146, 255, 0.25)',
};

type Device = OpenTargets['devices'][number];
const SPOT = ['left', 'width', 'top', 'bottom', 'maxHeight', 'side', 'tipX', 'tipY'] as const;

/** The TV title popup's "Play on a device": OK opens the devices as a popup
 *  pointing at the button, the remote moves through them, OK plays on one
 *  and Back closes it (useTVModal). */
function TVPlayOnDevice({ devices, onPlayOn }: { devices: Device[]; onPlayOn: (d: Device) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<OutsidePlacement | null>(null);
  const open = !!at;
  const close = useCallback(() => setAt(null), []);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    return r ? placeAtPill(r, 340, panel.current?.scrollHeight) : null;
  };
  // Unchanged spot: keep the old one so React skips the redraw.
  const replace = () => { const p = place(); if (p) setAt((old) => (old && SPOT.every((k) => old[k] === p[k]) ? old : p)); };
  useFitPopup(panel, open, replace);
  // The remote stays in the list and Back closes it. Escape closes only the
  // list, stopped before the title window behind it hears it and closes too.
  useTVModal(open, panel, close, true);
  useFollowAnchor(open, () => [button.current?.getBoundingClientRect() ?? null], replace);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
    return () => {
      window.removeEventListener('resize', replace);
      window.removeEventListener('scroll', replace, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const toggle = () => (open ? close() : replace());

  return (
    <>
      <TVFocusable onEnterPress={toggle}>
        <button ref={button} type="button" tabIndex={-1} onClick={toggle} aria-expanded={open} className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium" style={STYLE}>
          <TvIcon className="w-4 h-4" /><span className="whitespace-nowrap">Play on a device</span>
        </button>
      </TVFocusable>
      {at && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div ref={panel} role="dialog" aria-label="Play on a device" className="popup-panel fixed z-[9999] rounded-2xl p-1.5" style={popupStyle(at)}>
            <PlayOnDeviceList devices={devices} onPlayOn={(d) => { close(); onPlayOn(d); }} />
          </div>
          {(at.side === 'below' || at.side === 'above') && at.tipX != null && at.tipY != null && (
            <span
              aria-hidden
              className="popup-caret fixed z-[10000] w-3.5 h-3.5 bg-surface pointer-events-none"
              style={{ left: at.tipX - 7, top: at.tipY - 7, transform: 'rotate(45deg)', borderStyle: 'solid', borderWidth: at.side === 'below' ? '1px 0 0 1px' : '0 1px 1px 0' }}
            />
          )}
        </>,
        document.body,
      )}
    </>
  );
}

export function OpenWithButton({ imdbId, type, isTV = false }: { imdbId: string; type: 'movie' | 'series'; isTV?: boolean }) {
  const [targets, setTargets] = useState<OpenTargets | null>(null);
  // Read straight away: nothing renders until the targets load, on the client.
  const [chosen, setChosen] = useState<OpenWithAppId | null>(() => (typeof window === 'undefined' ? null : rememberedApp()));
  const [menu, setMenu] = useState<{ x: number; y: number; aboveY: number; mode: 'apps' | 'which' } | null>(null);
  // A counter that makes the list re-read the Shortcut's names once saved.
  const [scSaved, setScSaved] = useState(0);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const { watch, shown: noteShown, hide: hideNote } = useAppOpenCheck(isTV);

  useEffect(() => {
    let cancelled = false;
    loadTargets(imdbId, type).then((t) => { if (!cancelled) setTargets(t); });
    return () => { cancelled = true; };
  }, [imdbId, type]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- scSaved re-reads the saved Shortcut
  const apps = useMemo(() => (targets ? availableApps(targets, type) : []), [targets, type, scSaved]);
  if (!targets || (!apps.length && !targets.devices.length)) return null;

  // This device's pick when it can open this title; otherwise the first that can.
  const current = apps.find((a) => a.id === chosen) || apps[0] || null;
  const links = current ? linksFor(current.id, targets, type) : [];
  const go = (url: string) => { watch(url); window.location.href = url; };
  const note = noteShown ? <AppOpenNote onClose={hideNote} isTV={isTV} /> : null;
  const openMenuAt = (el: HTMLElement | null, mode: 'apps' | 'which') => {
    const r = el?.getBoundingClientRect();
    // Under the button; with no room there, over it (never on top of it).
    setMenu({ x: r ? r.left : 16, y: r ? r.bottom + 6 : 80, aboveY: r ? r.top - 6 : 80, mode });
  };
  // A second press on what opened a list closes it again.
  const onArrow = () => (menu?.mode === 'apps' ? setMenu(null) : openMenuAt(arrowRef.current, 'apps'));
  const onMain = () => {
    if (menu?.mode === 'which') return setMenu(null);
    if (!current) return openMenuAt(arrowRef.current, 'apps');
    if (links.length === 1) return go(links[0].url);
    openMenuAt(mainRef.current, 'which');
  };
  const pick = (id: OpenWithAppId) => { rememberApp(id); setChosen(id); setMenu(null); };
  const playOn = async (d: OpenTargets['devices'][number]) => {
    setMenu(null);
    try {
      await api.playOnDevice({ personId: d.personId, credentialId: d.credentialId, sessionId: d.sessionId, itemId: d.itemId });
      toast.success(`Playing on ${d.device}`);
    } catch (e) {
      toast.error((e as Error)?.message || 'That device did not answer');
    }
  };

  const label = current?.id === 'aiostreams'
    ? <>Open in <span style={{ color: '#ffffff', fontWeight: 600 }}>AIO</span>Streams</>
    : current?.id === 'shortcut' ? <>Open in {rememberedShortcut()?.app || 'your app'}</>
    : current ? <>Open in {current.id === 'web' ? 'browser' : current.name}</> : <>Play on…</>;

  // TV: only Play on a device. The apps the picker opens (Swiftfin,
  // Streamyfin, Infuse, a Shortcut) don't run on a TV box.
  if (isTV) return targets.devices.length ? <TVPlayOnDevice devices={targets.devices} onPlayOn={playOn} /> : null;

  const row = 'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-hover text-left';
  return (
    <>
      {/* On a phone the button is full width with the arrow laid over its right
          end, so the icon-and-text block centres exactly like Stremio's and
          Nuvio's above it and the play icons line up. */}
      <div className="relative flex w-full sm:w-auto rounded-lg">
        <button
          ref={mainRef}
          type="button"
          onClick={onMain}
          className="flex-1 flex items-center justify-center px-4 sm:pr-3 py-2 rounded-lg sm:rounded-r-none text-sm font-medium whitespace-nowrap"
          style={STYLE}
        >
          <span className="inline-flex items-center gap-1.5 w-[11rem] sm:w-auto">
            <PlayIcon className="w-4 h-4 shrink-0" /><span>{label}</span>
          </span>
        </button>
        <button
          ref={arrowRef}
          type="button"
          aria-label="Choose the app"
          aria-expanded={menu?.mode === 'apps'}
          onClick={onArrow}
          className="absolute right-0 inset-y-0 sm:static flex items-center px-3 rounded-r-lg border-l"
          style={{ ...STYLE, borderLeft: '1px solid rgba(159, 146, 255, 0.35)' }}
        >
          <ChevronDownIcon className="w-4 h-4" />
        </button>
      </div>

      <ContextMenu isOpen={!!menu} position={{ x: menu?.x ?? 0, y: menu?.y ?? 0, aboveY: menu?.aboveY }} onClose={() => setMenu(null)}>
        <div className="w-[min(320px,calc(100vw-1.5rem))] p-1.5">
          {menu?.mode === 'which' && current ? (
            <>
              <div className="px-2 pt-1 pb-2 text-[15px] font-semibold text-default">Open in {current.id === 'web' ? 'a browser' : current.name} on…</div>
              {links.map((l) => (
                <button key={l.url} type="button" className={row} onClick={() => { setMenu(null); go(l.url); }}>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px] text-default truncate">{l.label}</span>
                    <span className="block text-[13px] text-muted truncate">{l.detail}</span>
                  </span>
                </button>
              ))}
            </>
          ) : (
            <OpenWithPicker
              targets={targets}
              apps={apps}
              currentId={current?.id ?? null}
              onPick={pick}
              onShortcutSaved={() => setScSaved((n) => n + 1)}
              onPlayOn={playOn}
            />
          )}
        </div>
      </ContextMenu>
      {note}
    </>
  );
}
