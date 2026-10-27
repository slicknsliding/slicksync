'use client';

// The pieces every v2 detail page (a person, a group, an addon, an invite, a
// catalog) is built from: the header that says who or what it is with one
// status and the one obvious button (the rest in ⋯), the numbers strip, the
// tool tiles for things used now and then, and the box sections sit in.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline';

export type V2MenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** The ⋯ button and its menu, drawn over the page so nothing clips it. */
export function V2MoreMenu({ items, label = 'More' }: { items: V2MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = 240;
    const height = menuRef.current?.offsetHeight || 220;
    const below = r.bottom + 6 + height <= window.innerHeight - 8;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({
      top: Math.round(below ? r.bottom + 6 : Math.max(8, r.top - 6 - height)),
      left: Math.round(Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)),
    });
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
    // Scrolling moves the menu with its button (a tap often nudges the page);
    // it closes only once the button has left the screen.
    const follow = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
      const height = menuRef.current?.offsetHeight || 220;
      const below = r.bottom + 6 + height <= window.innerHeight - 8;
      setPos({
        top: Math.round(below ? r.bottom + 6 : Math.max(8, r.top - 6 - height)),
        left: Math.round(Math.min(Math.max(8, r.right - 240), window.innerWidth - 240 - 8)),
      });
    };
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="v2-btn"
        style={{ padding: '7px 10px' }}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setPos(null); setOpen((v) => !v); }}
      >
        <EllipsisHorizontalIcon className="w-5 h-5" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="arrange-menu"
          style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, right: 'auto', zIndex: 60, visibility: pos ? 'visible' : 'hidden' }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className="arrange-menu-item"
              style={it.danger ? { color: 'var(--color-error, #ef4444)' } : undefined}
              onClick={() => { setOpen(false); it.onClick(); }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Who or what this page is about: its picture, its name (and a pill), one
 * status in words with a short line of facts, and the buttons - the obvious
 * one first, everything else in ⋯.
 */
export function V2DetailHead({ lead, title, pill, status, facts, actions, more, below, style }: {
  lead: ReactNode;
  title: ReactNode;
  pill?: ReactNode;
  status?: ReactNode;
  facts?: ReactNode;
  actions?: ReactNode;
  more?: V2MenuItem[];
  /** Anything under the header, full width (a banner, a warning). */
  below?: ReactNode;
  /** A wash of colour behind the header. */
  style?: React.CSSProperties;
}) {
  return (
    <div className={style ? "v2-detail-head v2-detail-head-wash" : "v2-detail-head"} style={style}>
      <div className="v2-detail-lead">{lead}</div>
      <div className="v2-detail-id">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <h1 className="v2-detail-title">{title}</h1>
          {pill}
        </div>
        {(status || facts) && (
          <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1.5">
            {status}
            {facts && <span className="text-muted text-[13.5px]">{facts}</span>}
          </div>
        )}
      </div>
      {(actions || (more && more.length > 0)) && (
        <div className="v2-detail-actions">
          {actions}
          {more && <V2MoreMenu items={more} />}
        </div>
      )}
      {below && <div className="basis-full">{below}</div>}
    </div>
  );
}

/** A row of numbers in one box: label, value, an optional small line under it. */
export function V2Numbers({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <div className="v2-numbers" style={{ ['--v2-n' as string]: items.length }}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <div className="text-muted text-[12.5px]">{it.label}</div>
          <div className="v2-number">{it.value}</div>
          {it.sub && <div className="text-muted text-[12px] truncate">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** A tile for a tool used now and then: icon, name, one line, and what happens on a click. */
export function V2ToolTile({ icon, title, line, state, onClick, children }: {
  icon: ReactNode;
  title: string;
  line?: ReactNode;
  state?: ReactNode;
  onClick?: () => void;
  /** Rendered instead of a click target (a tool that needs its own controls). */
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="v2-tool-icon">{icon}</span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block font-semibold text-[14.5px] text-default">{title}</span>
        {line && <span className="block text-muted text-[12.5px] mt-0.5">{line}</span>}
        {children}
      </span>
      {state && <span className="shrink-0 text-muted text-[12.5px]">{state}</span>}
    </>
  );
  return onClick
    ? <button type="button" className="v2-tool" onClick={onClick}>{body}</button>
    : <div className="v2-tool">{body}</div>;
}

/** A plain v2 box for a section's content. */
export function V2Box({ children, className = '', pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`v2-box${pad ? ' v2-box-pad' : ''} ${className}`}>{children}</div>;
}

/** Tiles in columns: one on a phone, `wide` from tablets up (more on big screens). */
export function V2Tiles({ children, wide = 2 }: { children: ReactNode; wide?: 2 | 3 | 4 }) {
  return <div className={`v2-tiles v2-tiles-${wide}`}>{children}</div>;
}
