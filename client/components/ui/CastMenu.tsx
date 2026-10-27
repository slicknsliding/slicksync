'use client';

// What you can do with one cast member, from holding them (phone) or
// right-clicking them (computer): a bubble above and to the right of their
// photo, like a message, with a tail pointing back at them. Kept on screen:
// near the right edge it moves left (the tail still points at the photo),
// and without room above it opens below instead.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BellIcon, BellSlashIcon, RectangleStackIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';

export interface CastMenuTarget {
  id: string;
  name: string;
  character: string | null;
  photo: string | null;
  /** The held photo's box on screen. */
  anchor: DOMRect;
}

export function CastMenu({ target, title, follow, titlesOpen, onClose, onSeeEverything, onShowHere, onFollow }: {
  target: CastMenuTarget;
  title: string | null;
  /** Their titles are already showing under the cast: the option hides them. */
  titlesOpen: boolean;
  follow: { muted: boolean } | null;
  onClose: () => void;
  onSeeEverything: () => void;
  onShowHere: () => void;
  onFollow: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; tail: number; below: boolean } | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 12;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const a = target.anchor;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(pad, Math.min(a.right - 12, vw - w - pad));
    const below = a.top - h - 10 < pad;
    const top = below ? Math.min(a.bottom + 10, vh - h - pad) : a.top - h - 10;
    // The tail aims at the photo's top-right, wherever the bubble ended up.
    const tail = Math.max(14, Math.min(a.right - 22 - left, w - 28));
    setPlace({ left, top, tail, below });
  }, [target.anchor]);
  useLayoutEffect(() => { fit(); }, [fit]);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // The finger that opened it is still down: listen from the next tick.
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', down);
      window.addEventListener('scroll', onClose, true);
    }, 0);
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('scroll', onClose, true);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const item = 'w-full flex items-center gap-3 px-3.5 py-2.5 text-[15px] text-left text-default hover:bg-surface-hover transition-colors';
  const icon = 'w-[18px] h-[18px] shrink-0 text-muted';

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="popup-panel fixed z-[10000] w-[min(300px,calc(100vw-1.5rem))] py-1.5 rounded-2xl select-none"
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, WebkitTouchCallout: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span
        aria-hidden
        className="popup-caret absolute w-3.5 h-3.5 bg-surface"
        style={place?.below
          ? { left: place.tail, top: -8, borderLeftWidth: 1, borderTopWidth: 1, transform: 'rotate(45deg)' }
          : { left: place?.tail ?? 14, bottom: -8, borderLeftWidth: 1, borderBottomWidth: 1, transform: 'rotate(-45deg)' }}
      />
      <div className="flex items-center gap-2.5 px-3.5 pt-2 pb-2.5 mb-1 border-b border-default">
        {target.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={target.photo} alt="" className="w-[30px] h-[30px] rounded-full object-cover shrink-0" />
        ) : (
          <span className="w-[30px] h-[30px] rounded-full bg-surface-hover flex items-center justify-center text-sm font-semibold text-muted shrink-0">{target.name.charAt(0)}</span>
        )}
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold truncate" style={{ color: 'color-mix(in srgb, var(--color-primary) 45%, #ffffff)' }}>{target.name}</span>
          {target.character && (
            <span className="block text-[13px] truncate" style={{ color: 'color-mix(in srgb, var(--color-text) 78%, transparent)' }}>
              plays {target.character}{title ? ` in ${title}` : ''}
            </span>
          )}
        </span>
      </div>
      <button type="button" role="menuitem" className={item} onClick={() => { onClose(); onSeeEverything(); }}>
        <RectangleStackIcon className={icon} /><span className="min-w-0 truncate">See more about {target.name}</span>
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => { onClose(); onShowHere(); }}>
        {titlesOpen ? <ChevronUpIcon className={icon} /> : <ChevronDownIcon className={icon} />}
        {titlesOpen ? 'Hide their titles' : 'Show their titles here'}
      </button>
      <div className="h-px bg-[var(--color-surface-border)] my-1" />
      <button type="button" role="menuitem" className={item} onClick={() => { onClose(); onFollow(); }}>
        {follow && !follow.muted ? <BellSlashIcon className={icon} /> : <BellIcon className={icon} />}
        {/* The name is at the top already, so the options don't repeat it. */}
        <span className="min-w-0">
          {!follow ? 'Follow' : follow.muted ? 'Turn alerts back on' : 'Mute alerts'}
          {!follow && <span className="block text-[12.5px] text-muted leading-snug">Hear when they have something new out</span>}
        </span>
      </button>
    </div>,
    document.body,
  );
}
