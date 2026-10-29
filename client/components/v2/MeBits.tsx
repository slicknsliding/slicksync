'use client';

// Pieces a person's own v2 pages (Library, Activity, Addons, Shares, Settings)
// share: the header, the poster tile and its grid, the two-way switch, and the
// short settings row.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FilmIcon, TvIcon, CheckIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { V2MoreMenu, type V2MenuItem } from './V2Detail';
import { PAGE_HEADER_CSS, useIconifyActions, usePageHeader } from '@/lib/pageHeader';

/** The page's name, one line under it, and its buttons (the obvious one first, the rest in ⋯). */
export function MeHead({ title, sub, actions, more }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  more?: V2MenuItem[];
}) {
  // Themes → Layout → Page header. Full is the layout below; Compact is one
  // slim row with icon-only buttons; Minimal drops the title and keeps the buttons.
  const { mode } = usePageHeader();
  const actionsRef = useRef<HTMLDivElement>(null);
  useIconifyActions(actionsRef, mode === 'compact');
  if (mode !== 'full') {
    const compact = mode === 'compact';
    const hasButtons = !!actions || (!!more && more.length > 0);
    return (
      <div data-page-header={mode} className={`flex items-center gap-x-2 gap-y-2 flex-wrap ${compact ? 'mt-1.5 mb-4' : 'mt-1.5 mb-3 pb-2.5'}`} style={compact ? undefined : { borderBottom: '1px solid var(--color-surface-border)' }}>
        <style>{PAGE_HEADER_CSS}</style>
        {compact ? (
          <div className="min-w-[8rem] flex-1">
            <h1 className="text-xl md:text-2xl font-bold leading-tight text-default line-clamp-3 break-words">{title}</h1>
            {sub && <div className="text-muted text-xs md:text-[13.5px] leading-snug mt-0.5 line-clamp-2">{sub}</div>}
          </div>
        ) : (
          <h1 className="sr-only">{title}</h1>
        )}
        {hasButtons && (
          <div ref={actionsRef} data-ph-actions={compact ? 'icons' : 'slim'} className={`flex items-center flex-wrap gap-2 ${compact ? 'shrink-0 ml-auto' : 'flex-1 min-w-0'}`}>
            {actions}
            {more && <V2MoreMenu items={more} />}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="v2-detail-head">
      <div className="v2-detail-id">
        <h1 className="v2-detail-title">{title}</h1>
        {sub && <div className="text-muted text-[13.5px] mt-1.5">{sub}</div>}
      </div>
      {(actions || (more && more.length > 0)) && (
        <div className="v2-detail-actions">
          {actions}
          {more && <V2MoreMenu items={more} />}
        </div>
      )}
    </div>
  );
}

/** A small two-or-three-way switch (Everything / Shows / Movies, Sent to you / You sent). */
export function MeSeg<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: ReactNode }[];
}) {
  return (
    <div className="flex p-1 rounded-xl w-fit max-w-full" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }} role="tablist">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors whitespace-nowrap ${value === o.key ? 'seg-on' : 'seg-off'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The columns poster tiles sit in: three on a phone, up to thirteen on the widest screens. */
export const POSTER_GRID = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 min-[1700px]:grid-cols-9 min-[2300px]:grid-cols-11 min-[3000px]:grid-cols-13 gap-3';

/** One poster with its title and a line under it; a bar along the foot shows how far in. */
export function MePoster({ poster, name, type, line, progress, selected, selecting, href, onSelect, badge }: {
  poster?: string | null;
  name: string;
  type?: string;
  line?: ReactNode;
  /** 0-100; no bar when empty. */
  progress?: number;
  selected?: boolean;
  /** Selecting: a click ticks it instead of opening it. */
  selecting?: boolean;
  /** Where a click opens it, when not selecting. */
  href?: string | null;
  onSelect?: () => void;
  badge?: ReactNode;
}) {
  const [bad, setBad] = useState(false);
  const art = (
    <span
      className="relative block aspect-[2/3] rounded-[10px] overflow-hidden"
      style={{ background: 'var(--color-surface-elevated)', outline: selected ? '2px solid var(--color-primary)' : undefined, outlineOffset: selected ? 2 : undefined }}
    >
      {poster && !bad ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" className="w-full h-full object-cover" onError={() => setBad(true)} />
      ) : (
        <span className="w-full h-full flex items-center justify-center">
          {type === 'movie' ? <FilmIcon className="w-9 h-9 text-subtle" /> : <TvIcon className="w-9 h-9 text-subtle" />}
        </span>
      )}
      {progress != null && progress > 0 && (
        <span className="absolute left-0 right-0 bottom-0 h-[5px]" style={{ background: 'rgba(0,0,0,.5)' }}>
          <span className="block h-full" style={{ width: `${Math.min(100, progress)}%`, background: 'var(--color-primary)' }} />
        </span>
      )}
      {badge && <span className="absolute top-1.5 left-1.5">{badge}</span>}
      {selected && (
        <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: 'var(--color-primary)' }}>
          <CheckIcon className="w-4 h-4 text-white" />
        </span>
      )}
    </span>
  );
  const body = (
    <>
      {art}
      <span className="block text-[13px] font-semibold mt-1.5 line-clamp-3 break-words leading-tight text-default">{name}</span>
      {line && <span className="block text-muted text-[12px] mt-0.5 truncate">{line}</span>}
    </>
  );
  if (selecting) {
    return <button type="button" className="block text-left min-w-0" aria-pressed={!!selected} onClick={onSelect}>{body}</button>;
  }
  return href
    ? <a href={href} className="block min-w-0" title="Open in your app">{body}</a>
    : <div className="min-w-0">{body}</div>;
}

/** Rows in one box: the setting, one line on what it does, and its control on the right. */
export function MeRows({ children }: { children: ReactNode }) {
  return <div className="v2-box" style={{ padding: '2px 18px' }}>{children}</div>;
}

export function MeRow({ title, line, children, stack }: {
  title: ReactNode;
  line?: ReactNode;
  children?: ReactNode;
  /** The control goes under the words (a long field). */
  stack?: boolean;
}) {
  return (
    <div className={`py-3 flex gap-x-4 gap-y-2.5 border-t first:border-t-0 ${stack ? 'flex-col' : 'items-center flex-wrap'}`} style={{ borderColor: 'var(--color-surface-border)' }}>
      <div className="flex-1 min-w-[180px]">
        <div className="font-semibold text-[14.5px] text-default">{title}</div>
        {line && <div className="text-muted text-[12.5px] mt-0.5">{line}</div>}
      </div>
      {children != null && <div className={`flex items-center gap-2 flex-wrap ${stack ? '' : 'min-w-0 max-w-full'}`}>{children}</div>}
    </div>
  );
}

/**
 * A "Filters" button that opens a small menu of choices under it (one group,
 * one pick). The button shows how many filters are on; "Clear filters" resets.
 */
export function FiltersMenu({ title, options, value, onChange, all }: {
  /** The group's small heading, e.g. "From". */
  title: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  /** The key meaning no filter. */
  all: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const count = value !== all ? 1 : 0;
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return null;
    const width = 250;
    return { top: Math.round(r.bottom + 6), left: Math.round(Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)) };
  };
  useLayoutEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(place());
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
    const follow = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
      setPos(place());
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="v2-btn shrink-0"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={count > 0}
        onClick={() => setOpen((v) => !v)}
        style={count > 0 ? { borderColor: 'var(--color-primary)' } : undefined}
      >
        <FunnelIcon className="w-4 h-4" />
        Filters
        {count > 0 && <span className="v2-chip" style={{ marginLeft: 2, padding: '0 7px', background: 'var(--color-primary)', color: '#fff', borderColor: 'transparent' }}>{count}</span>}
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" className="arrange-menu" style={{ position: 'fixed', top: pos.top, left: pos.left, right: 'auto', width: 250, zIndex: 60 }}>
          <div className="text-muted" style={{ fontSize: 11.5, padding: '6px 12px 2px', letterSpacing: '.04em', textTransform: 'uppercase' }}>{title}</div>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={value === o.key}
              onClick={() => { onChange(o.key); setOpen(false); }}
              className={`arrange-menu-item ${value === o.key ? 'font-semibold' : ''}`}
              style={{ justifyContent: 'space-between' }}
            >
              {o.label}
              {value === o.key && <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />}
            </button>
          ))}
          {count > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--color-surface-border)', margin: '6px 0' }} />
              <button type="button" role="menuitem" className="arrange-menu-item text-muted" onClick={() => { onChange(all); setOpen(false); }}>Clear filters</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
