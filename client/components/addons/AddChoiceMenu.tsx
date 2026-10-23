'use client';

// What "+ Add" on the Addons page adds: an addon, or a Jellyfin server that
// everyone in a group gets an account on. Opens under the button (above it
// when there's no room, as from the phone's floating button), right edges
// lined up; on a phone it spans the screen less a margin either side.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { JellyfinLogo } from '@/components/jellyfin/JellyfinLogo';
import { TVFocusable } from '@/components/tv/TVFocusable';

export function AddChoiceMenu({ anchor, anchorEl, isTV, onClose, onAddon, onServer }: {
  /** The button it opened from. */
  anchor: DOMRect;
  /** That button: a press on it is its own toggle, not a press outside. */
  anchorEl?: Element | null;
  isTV: boolean;
  onClose: () => void;
  onAddon: () => void;
  onServer: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 12;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = vw < 640 ? vw - pad * 2 : Math.min(340, vw - pad * 2);
    const left = vw < 640 ? pad : Math.max(pad, Math.min(anchor.right - width, vw - width - pad));
    const h = el.offsetHeight;
    const below = anchor.bottom + 8 + h <= vh - pad;
    const top = below ? anchor.bottom + 8 : Math.max(pad, anchor.top - 8 - h);
    setPlace({ left, top, width });
  }, [anchor]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- placed before paint, measured from the drawn menu
  useLayoutEffect(() => { fit(); }, [fit]);

  useEffect(() => {
    if (isTV) setFocus('add-choice-addon');
  }, [isTV]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchorEl?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || (e.key === 'Backspace' && isTV)) onClose(); };
    // The press that opened it is still finishing: listen from the next tick.
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', down);
      window.addEventListener('resize', onClose);
    }, 0);
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('keydown', key);
    };
  }, [onClose, isTV, anchorEl]);

  const item = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hov-surface transition-colors';
  const icon = 'w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 bg-surface-hover';
  // What was picked opens first; the menu goes on the next tick, so on a TV
  // the remote's key press finishes before the item it landed on is gone.
  const choose = (fn: () => void) => () => { fn(); setTimeout(onClose, 0); };

  const rows = [
    {
      key: 'add-choice-addon',
      run: choose(onAddon),
      body: (
        <>
          <span className={icon}><PuzzlePieceIcon className="w-5 h-5 text-muted" /></span>
          <span className="min-w-0">
            <span className="block text-[15px] font-medium text-default">Addon</span>
            <span className="block text-[12.5px] text-muted leading-snug">Paste an addon&apos;s link</span>
          </span>
        </>
      ),
    },
    {
      key: 'add-choice-server',
      run: choose(onServer),
      body: (
        <>
          <span className={icon}><JellyfinLogo size={20} /></span>
          <span className="min-w-0">
            <span className="block text-[15px] font-medium text-default">Jellyfin server</span>
            <span className="block text-[12.5px] text-muted leading-snug">An account for everyone in a group</span>
          </span>
        </>
      ),
    },
  ];

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[10000] p-1.5 rounded-2xl bg-surface border border-default shadow-2xl"
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, width: place?.width ?? 320 }}
    >
      {rows.map((r) => (isTV ? (
        <TVFocusable key={r.key} focusKey={r.key} onEnterPress={r.run}>
          <button type="button" role="menuitem" className={item} onClick={r.run}>{r.body}</button>
        </TVFocusable>
      ) : (
        <button key={r.key} type="button" role="menuitem" className={item} onClick={r.run}>{r.body}</button>
      )))}
    </div>,
    document.body,
  );
}
