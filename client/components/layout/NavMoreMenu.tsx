'use client';

// "More" at the end of the top bar: the pages someone hid from their menu
// (Themes → Layout → Arrange the menu). Opens below the pill, outside the
// nav row's scroll box so it isn't clipped.

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import type { MenuItem } from '@/lib/adminMenu';

export function NavMoreMenu({ items, isActive, onNavigate, compact, tight }: {
  items: MenuItem[];
  isActive: (href: string) => boolean;
  onNavigate?: () => void;
  compact?: boolean;
  /** The one-row bar's narrower pills. */
  tight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anyActive = items.some((i) => isActive(i.href));

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = 220;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({ top: Math.round(r.bottom + 6), left: Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8)) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${compact ? 'nav-item-hover-pill flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap' : `nav-item-hover-pill flex items-center gap-1.5 text-sm font-semibold ${tight ? 'px-3' : 'px-4'} py-2 rounded-full whitespace-nowrap`} ${anyActive ? 'nebula-link-on' : 'text-muted'}`}
      >
        <EllipsisHorizontalIcon className="w-4 h-4 shrink-0" />
        More
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" className="arrange-menu" style={{ position: 'fixed', top: pos.top, left: pos.left, right: 'auto', width: 220, zIndex: 60 }}>
          {items.map((i) => {
            const Icon = i.icon;
            return (
              <Link
                key={i.href}
                href={i.href}
                role="menuitem"
                onClick={() => { setOpen(false); onNavigate?.(); }}
                aria-current={isActive(i.href) ? 'page' : undefined}
                className={`arrange-menu-item ${isActive(i.href) ? 'font-semibold' : ''}`}
              >
                <Icon className="w-4 h-4" />
                {i.label}
              </Link>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
