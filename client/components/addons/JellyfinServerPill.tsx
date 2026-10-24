'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { JellyfinLogo } from '@/components/jellyfin/JellyfinLogo';
import type { ConfigServerLink } from '@/lib/api';

const POPUP_WIDTH = 288; // px
const EDGE = 8; // px kept clear of the screen edge

/**
 * "Jellyfin server" on an AIOStreams or AIOMetadata addon whose configuration
 * someone here also signs in to as a Jellyfin server (it's both: an addon for
 * Stremio and Nuvio, a server for Jellyfin apps). Clicking it opens a small
 * popup with the address and a way to its profiles on the Users page - closed
 * by its X, the chip again, a tap elsewhere, Escape or scrolling. Placed like
 * SharedConfigPill; on TV a plain label.
 */
export function JellyfinServerPill({ link, isTV = false, className = '' }: { link: ConfigServerLink; isTV?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (open || !buttonRef.current) { setOpen(false); return; }
    const r = buttonRef.current.getBoundingClientRect();
    const width = Math.min(POPUP_WIDTH, window.innerWidth - EDGE * 2);
    const left = Math.min(Math.max(r.left, EDGE), window.innerWidth - width - EDGE);
    const roomBelow = window.innerHeight - r.bottom;
    setPlace(roomBelow > 200 || roomBelow > r.top
      ? { left, width, top: r.bottom + 8 }
      : { left, width, bottom: window.innerHeight - r.top + 8 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    const shut = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  const pillClass = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium hover:brightness-125';
  const pillStyle = {
    color: 'rgb(212, 208, 255)',
    background: 'linear-gradient(rgba(0, 11, 37, 0.94), rgba(6, 16, 46, 0.94)) padding-box, linear-gradient(115deg, rgba(170, 92, 195, 0.75), rgba(0, 164, 220, 0.75)) border-box',
    border: '1px solid transparent',
  };
  const label = <><JellyfinLogo size={11} /><span className="truncate max-w-[12rem]">Jellyfin server · {link.personName}</span></>;

  if (isTV) {
    return <span className={`${pillClass} ${className}`} style={pillStyle}>{label}</span>;
  }

  // The card around this opens the addon on click and starts drags on press.
  const keep = (e: React.SyntheticEvent) => e.stopPropagation();
  const profiles = link.profiles === 1 ? '1 profile' : `${link.profiles} profiles`;

  return (
    <span className={`inline-flex min-w-0 ${className}`} onClick={keep} onPointerDown={keep} onMouseDown={keep} onContextMenu={keep}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.preventDefault(); toggle(); }}
        className={`${pillClass} transition min-w-0`}
        style={pillStyle}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {label}
      </button>
      {open && place && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          role="dialog"
          onClick={keep}
          onPointerDown={keep}
          onMouseDown={keep}
          style={{ position: 'fixed', left: place.left, width: place.width, top: place.top, bottom: place.bottom, zIndex: 60 }}
          className="rounded-xl border border-default bg-surface p-3 text-xs leading-relaxed text-default shadow-lg text-left"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">Also a Jellyfin server</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="-mt-1 -mr-1 p-1 rounded-md text-muted hover:text-default hover:bg-surface-hover transition-colors">
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-1 text-muted break-words">{link.address}</p>
          <p className="mt-0.5 text-muted">
            Signed in here as <span className="text-default font-medium">{link.personName}</span> · {profiles}
          </p>
          <Link href="/users" onClick={() => setOpen(false)} className="inline-block mt-2 px-2 py-1 rounded-lg bg-surface-hover hover:text-primary transition-colors">
            Open its profiles →
          </Link>
        </div>,
        document.body,
      )}
    </span>
  );
}
