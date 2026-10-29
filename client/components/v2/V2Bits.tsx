'use client';

// Shared pieces of the v2 page design (Themes → Page design → v2): one status
// in plain words with its dot, the section heading, and the card and row
// shells every v2 page builds from. V2Item is the one shell every list card
// and row goes through: it opens the thing, carries the ⋯ menu (also opened by
// a long press or a right click), the select circle, and drag to sort.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { CheckCircleIcon, CheckIcon, ChevronLeftIcon, EllipsisHorizontalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDndMonitor } from '@dnd-kit/core';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { useLongPress } from '@/lib/hooks/useLongPress';
import { StretchHandle } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';

export type V2Tone = 'live' | 'ok' | 'warn' | 'bad' | 'off';

const TONE: Record<V2Tone, { dot: string; text: string }> = {
  live: { dot: 'var(--color-success, #22c55e)', text: 'var(--color-success, #22c55e)' },
  ok: { dot: '#60a5fa', text: 'var(--color-text-muted)' },
  warn: { dot: 'var(--color-warning, #f59e0b)', text: 'var(--color-warning, #f59e0b)' },
  bad: { dot: 'var(--color-error, #ef4444)', text: 'var(--color-error, #ef4444)' },
  off: { dot: '#9ca3af', text: 'var(--color-text-muted)' },
};

/** One status, in words, with a coloured dot. */
export function V2Status({ tone, children }: { tone: V2Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span className="v2-status" style={{ color: t.text }}>
      <span className={`v2-dot${tone === 'live' ? ' v2-dot-live' : ''}`} style={{ background: t.dot }} />
      {children}
    </span>
  );
}

/** A provider name as a small outlined pill. */
export function V2AppPill({ label, color }: { label: string; color: string }) {
  return (
    <span className="v2-chip" style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}>{label}</span>
  );
}

/** A card in a v2 grid. The whole card opens the thing; `action` is its one button. */
export function V2Card({ children, footer, action, className = '', style }: { children: ReactNode; footer?: ReactNode; action?: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`v2-card ${className}`} style={style}>
      {children}
      {(footer !== undefined || action) && (
        <div className="v2-card-foot">
          <span className="text-muted text-[13px] flex-1 min-w-0">{footer ?? 'Tap to open'}</span>
          {action}
        </div>
      )}
    </div>
  );
}

/** The grid v2 cards sit in: one column on a phone, more as the screen widens. */
export function V2Grid({ children, max, stretch }: {
  children: ReactNode;
  max?: 3;
  /** The page's arrange and this grid's key: the cards can be stretched to size while arranging. */
  stretch?: { arrange: PageArrange; id: string; label?: string };
}) {
  return (
    <div className={max === 3 ? 'v2-grid v2-grid-3' : 'v2-grid'} {...(stretch ? stretch.arrange.cardAttrs(stretch.id) : {})}>
      {children}
      {stretch && <StretchHandle arrange={stretch.arrange} id={stretch.id} label={stretch.label} />}
    </div>
  );
}

/** The list v2 rows sit in. */
export function V2List({ children }: { children: ReactNode }) {
  return <div className="v2-list">{children}</div>;
}

/** The small v2 button (Sync, Fix sign-in, Open...). */
export function V2Button({ children, onClick, primary, disabled, icon, label }: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={primary ? 'v2-btn v2-btn-main' : 'v2-btn'}
      disabled={disabled}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); }}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- ⋯ menu ----

export type V2CardMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A line above this item. */
  divider?: boolean;
  /** A second list: beside the menu on a wide screen, in place of it (under a header) on a phone. */
  sub?: { title: string; items: V2CardMenuItem[] };
  /** A coloured dot in place of the icon. */
  dot?: string;
  /** A tick after the label. */
  checked?: boolean;
  /** A row that becomes a text field when tapped ("New tag…"). */
  input?: { placeholder: string; onSubmit: (text: string) => void };
};

const MENU_W = 240;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

function MenuRow({ it, onPick, onOpenSub }: { it: V2CardMenuItem; onPick: (it: V2CardMenuItem) => void; onOpenSub: (it: V2CardMenuItem, el: HTMLElement) => void }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const lead = it.dot
    ? <span className="w-[18px] flex items-center justify-center shrink-0"><span style={{ width: 10, height: 10, borderRadius: 99, background: it.dot, display: 'inline-block' }} /></span>
    : it.icon;
  const line = it.divider ? <div role="separator" style={{ height: 1, margin: '5px 4px', background: 'var(--color-surface-border)' }} /> : null;
  if (it.input && typing) {
    const submit = () => { const v = text.trim(); if (v) { onPick({ label: it.label, onClick: () => it.input!.onSubmit(v) }); } };
    return (
      <>
        {line}
        <div className="flex items-center gap-1.5 px-2 py-1">
          <input
            autoFocus
            value={text}
            maxLength={40}
            placeholder={it.input.placeholder}
            aria-label={it.input.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submit(); if (e.key === 'Escape') setTyping(false); }}
            className="input-base px-2.5 py-1.5 text-sm flex-1 min-w-0"
          />
          <button type="button" className="arrange-icon" aria-label="Save" onClick={submit}><CheckIcon className="w-4 h-4" /></button>
        </div>
      </>
    );
  }
  return (
    <>
      {line}
      <button
        type="button"
        role="menuitem"
        disabled={it.disabled}
        className="arrange-menu-item"
        style={it.danger ? { color: 'var(--color-error, #ef4444)' } : undefined}
        onClick={(e) => {
          if (it.input) { setTyping(true); return; }
          if (it.sub) { onOpenSub(it, e.currentTarget); return; }
          onPick(it);
        }}
      >
        {lead}
        <span className="flex-1 min-w-0 truncate">{it.label}</span>
        {it.checked && <CheckIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />}
        {it.sub && <span className="opacity-70 shrink-0">›</span>}
      </button>
    </>
  );
}

function Panel({ innerRef, pos, label, children }: { innerRef: React.RefObject<HTMLDivElement | null>; pos: { top: number; left: number } | null; label?: string; children: ReactNode }) {
  return (
    <div
      ref={innerRef}
      role="menu"
      aria-label={label}
      className="arrange-menu"
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, right: 'auto', zIndex: 60, visibility: pos ? 'visible' : 'hidden' }}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {children}
    </div>
  );
}

/** The menu itself, drawn over the page: from the ⋯ button, or at a pressed point. */
function V2Menu({ items, at, anchorEl, onClose }: { items: V2CardMenuItem[]; at: { x: number; y: number } | null; anchorEl: HTMLElement | null; onClose: () => void }) {
  const [sub, setSub] = useState<{ it: V2CardMenuItem; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const wide = typeof window !== 'undefined' && window.innerWidth >= 600;
  const phoneSub = !wide && sub;

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight || 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      const below = r.bottom + 6 + h <= vh - 8;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPos({ top: Math.round(below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)), left: Math.round(Math.min(Math.max(8, r.right - MENU_W), vw - MENU_W - 8)) });
    } else if (at) {
      setPos({ top: Math.round(Math.max(8, Math.min(at.y, vh - h - 8))), left: Math.round(Math.min(Math.max(8, at.x), vw - MENU_W - 8)) });
    }
  }, [anchorEl, at, phoneSub]);

  useLayoutEffect(() => {
    if (!sub || !wide || !pos || !ref.current) return;
    const m = ref.current.getBoundingClientRect();
    const h = subRef.current?.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const right = m.right + 6 + MENU_W <= vw - 8;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubPos({ top: Math.round(Math.max(8, Math.min(sub.rect.top - 6, vh - h - 8))), left: Math.round(right ? m.right + 6 : Math.max(8, m.left - 6 - MENU_W)) });
  }, [sub, wide, pos]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || subRef.current?.contains(t) || anchorEl?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const follow = () => {
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow);
      window.removeEventListener('resize', onClose);
    };
  }, [anchorEl, onClose]);

  const pick = (it: V2CardMenuItem) => { onClose(); it.onClick?.(); };
  const openSub = (it: V2CardMenuItem, el: HTMLElement) => setSub({ it, rect: el.getBoundingClientRect() });
  const list = (its: V2CardMenuItem[]) => its.map((it, i) => <MenuRow key={`${it.label}-${i}`} it={it} onPick={pick} onOpenSub={openSub} />);

  const main = phoneSub
    ? (
      <Panel innerRef={ref} pos={pos} label={sub!.it.sub!.title}>
        <button type="button" className="arrange-menu-item" onClick={() => setSub(null)} aria-label={`Back from ${sub!.it.sub!.title}`}>
          <ChevronLeftIcon className="w-4 h-4 shrink-0" />
          <b className="flex-1 min-w-0 truncate">{sub!.it.sub!.title}</b>
        </button>
        <div role="separator" style={{ height: 1, margin: '5px 4px', background: 'var(--color-surface-border)' }} />
        {list(sub!.it.sub!.items)}
      </Panel>
    )
    : <Panel innerRef={ref} pos={pos}>{list(items)}</Panel>;
  return createPortal(
    <>
      {main}
      {wide && sub && <Panel innerRef={subRef} pos={subPos} label={sub.it.sub!.title}>{list(sub.it.sub!.items)}</Panel>}
    </>,
    document.body,
  );
}

type MenuState = { at: { x: number; y: number } | null; anchor: HTMLElement | null };

// ------------------------------------------------------------ V2Item ----

type ItemCtx = { grip: Record<string, unknown> | null };
const V2ItemContext = createContext<ItemCtx>({ grip: null });

/** The ⠿ handle that moves a card or row; put it beside pin and eye while arranging. */
export function V2Grip({ label = 'Drag to move' }: { label?: string }) {
  const { grip } = useContext(V2ItemContext);
  if (!grip) return null;
  const g = grip as { onTouchStart?: (e: React.TouchEvent) => void };
  return (
    <button
      type="button"
      className="arrange-icon"
      aria-label={label}
      title="Drag to move"
      style={{ cursor: 'grab', fontSize: 17, lineHeight: 1, color: 'var(--color-primary)', touchAction: 'none' }}
      {...grip}
      onTouchStart={(e) => { g.onTouchStart?.(e); e.stopPropagation(); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      ⠿
    </button>
  );
}

export type V2ItemProps = {
  href: string;
  /** A grid card (wraps the card) or a list row (is the row). */
  view: 'card' | 'row';
  /** The ⋯ menu; none means no ⋯ and no long press. */
  items?: V2CardMenuItem[];
  menuLabel?: string;
  /** Select mode: the circle takes the ⋯ place and a tap picks instead of opening. */
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  /** Makes the card draggable (the id dnd-kit knows it by). */
  sortId?: string;
  /** The card's own work in progress (a rename): no navigating, no menu, no drag. */
  busy?: boolean;
  /** Arranging shows the grip and hides the ⋯. */
  arranging?: boolean;
  /** Extra class on the card link or the row. */
  className?: string;
  /** Extra data for dnd-kit (a label for the layout's drag pill, say). */
  sortData?: Record<string, unknown>;
  /** Opens something on this page instead of following href (the Vault's editor); Enter on the card does it too. */
  onOpen?: () => void;
  children: ReactNode;
};

function ItemInner(p: V2ItemProps & { sort?: ReturnType<typeof useSortable> }) {
  const { href, view, items, menuLabel = 'More', selecting, selected, onToggle, busy, arranging, className = '', sort } = p;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const suppress = useRef(false);
  const hasMenu = !!items && items.length > 0 && !selecting && !arranging && !busy;
  const closeMenu = useCallback(() => setMenu(null), []);
  const openAt = useCallback((x: number, y: number) => {
    if (!hasMenu) return;
    suppress.current = true;
    window.setTimeout(() => { suppress.current = false; }, 700);
    setMenu({ at: { x, y }, anchor: null });
  }, [hasMenu]);
  const longPress = useLongPress({ onLongPress: (_e, x, y) => openAt(x, y), delay: 500 });

  // The same menu opens on a right click.
  const onContextMenu = (e: React.MouseEvent) => {
    if (!hasMenu) return;
    e.preventDefault();
    openAt(e.clientX, e.clientY);
  };
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea')) { e.preventDefault(); return; }
    if (suppress.current) { e.preventDefault(); return; }
    if (selecting) { e.preventDefault(); onToggle?.(); return; }
    if (p.onOpen && !arranging && !busy) { e.preventDefault(); p.onOpen(); }
  };

  const grip = sort && !selecting ? { ...sort.attributes, ...sort.listeners } as Record<string, unknown> : null;
  // The whole card drags with a mouse; a finger drags by the grip (a hold on
  // the card opens the menu instead).
  const mouseDown = sort && !selecting && !busy
    ? (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      (sort.listeners as { onPointerDown?: (ev: React.PointerEvent) => void } | undefined)?.onPointerDown?.(e);
    }
    : undefined;

  const menuButton = selecting
    ? (
      <span className="shrink-0" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}>
        <SelectionCheckbox checked={!!selected} onChange={onToggle} />
      </span>
    )
    : hasMenu
      ? (
        <button
          ref={btnRef}
          type="button"
          className="v2-btn"
          style={{ padding: '7px 10px' }}
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu((m) => (m ? null : { at: null, anchor: btnRef.current }));
          }}
        >
          <EllipsisHorizontalIcon className="w-5 h-5" />
        </button>
      )
      : null;

  const nativeDrag = (e: React.DragEvent) => e.preventDefault();
  const linkProps = {
    href,
    draggable: false,
    onClick,
    onContextMenu,
    onDragStart: nativeDrag,
    style: { WebkitTouchCallout: 'none' } as CSSProperties,
    ...(hasMenu ? longPress : {}),
  };
  const menuNode = menu && items && typeof document !== 'undefined'
    ? <V2Menu items={items} at={menu.at} anchorEl={menu.anchor} onClose={closeMenu} />
    : null;

  const dragStyle: CSSProperties = sort
    ? { transform: CSS.Transform.toString(sort.transform), transition: sort.isDragging ? 'none' : sort.transition, zIndex: sort.isDragging ? 100 : undefined, isolation: 'isolate' }
    : {};

  if (view === 'row') {
    return (
      <V2ItemContext.Provider value={{ grip }}>
        <Link
          {...linkProps}
          ref={sort?.setNodeRef as React.Ref<HTMLAnchorElement> | undefined}
          className={`v2-row ${className}`}
          style={{ ...linkProps.style, ...dragStyle, ...(selected ? { background: 'var(--color-primary-muted)' } : {}), ...(sort?.isDragging ? { boxShadow: '0 0 0 2px var(--color-primary)', background: 'var(--color-surface)' } : {}) }}
          onPointerDown={mouseDown}
        >
          {p.children}
          {menuButton}
          {menuNode}
        </Link>
      </V2ItemContext.Provider>
    );
  }
  return (
    <V2ItemContext.Provider value={{ grip }}>
      <div
        ref={sort?.setNodeRef}
      className={`relative h-full ${menuButton ? '[&_.v2-card>:first-child]:pr-[46px]' : ''}`}
        style={{
          ...dragStyle,
          borderRadius: 18,
          ...(selected ? { outline: '2px solid color-mix(in srgb, var(--color-primary) 55%, transparent)' } : {}),
          ...(sort?.isDragging ? { boxShadow: '0 22px 44px -12px rgba(0,0,0,0.7), 0 0 0 2px var(--color-primary)' } : {}),
        }}
        onPointerDown={mouseDown}
      >
        <Link {...linkProps} className={`v2-link h-full ${className}`}>{p.children}</Link>
        {menuButton && <div className="absolute" style={{ top: 12, right: 10 }}>{menuButton}</div>}
        {menuNode}
      </div>
    </V2ItemContext.Provider>
  );
}

function SortableItem(p: V2ItemProps) {
  const sort = useSortable({ id: p.sortId!, data: p.sortData });
  return <ItemInner {...p} sort={sort} />;
}

/** A list card or row: opens the thing, ⋯ menu, long press, select, drag to sort. */
export function V2Item(p: V2ItemProps) {
  return p.sortId ? <SortableItem {...p} /> : <ItemInner {...p} />;
}

// ----------------------------------------------------------- small bits ----

/** The Select / Done button beside Arrange. */
export function V2SelectButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`arrange-btn${on ? ' arrange-btn-on' : ''}`}
      title="Pick several to act on together"
    >
      <CheckCircleIcon className="w-4 h-4" />
      {on ? 'Done' : 'Select'}
    </button>
  );
}

/** A name that has turned into a field, with a tick and a cross. */
export function V2NameField({ value, onSave, onCancel, label = 'Name', size = 17 }: {
  value: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  label?: string;
  size?: number;
}) {
  const [text, setText] = useState(value);
  const done = () => { const v = text.trim(); if (v && v !== value) onSave(v); else onCancel(); };
  return (
    <span
      className="flex items-center gap-1.5 min-w-0"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerDown={stop}
    >
      <input
        autoFocus
        value={text}
        aria-label={label}
        maxLength={120}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') onCancel(); }}
        className="input-base min-w-0 flex-1 px-2.5 py-1 font-semibold"
        style={{ fontSize: size }}
      />
      <button type="button" className="arrange-icon" aria-label="Save the name" title="Save" onClick={(e) => { e.preventDefault(); e.stopPropagation(); done(); }}>
        <CheckIcon className="w-4 h-4" />
      </button>
      <button type="button" className="arrange-icon" aria-label="Cancel" title="Cancel" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}>
        <XMarkIcon className="w-4 h-4" />
      </button>
    </span>
  );
}

/** A small pill that follows the pointer while something is dragged ("Drop to label it Testing"). */
export function V2DragHint({ hint }: { hint: (activeId: string, overId: string | null) => string | null }) {
  const [state, setState] = useState<{ text: string; x: number; y: number } | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const activeId = useRef<string | null>(null);
  const last = useRef<{ over: string | null; dx: number; dy: number }>({ over: null, dx: 0, dy: 0 });
  const refresh = () => {
    if (!origin.current || !activeId.current) return;
    const text = hint(activeId.current, last.current.over);
    setState(text ? { text, x: origin.current.x + last.current.dx, y: origin.current.y + last.current.dy } : null);
  };
  const reset = () => { setState(null); activeId.current = null; last.current = { over: null, dx: 0, dy: 0 }; };
  useDndMonitor({
    onDragStart: ({ active, activatorEvent }) => {
      activeId.current = String(active.id);
      const e = activatorEvent as Partial<PointerEvent> & { touches?: ArrayLike<{ clientX: number; clientY: number }> };
      const t = e.touches?.[0];
      origin.current = { x: t?.clientX ?? e.clientX ?? 0, y: t?.clientY ?? e.clientY ?? 0 };
    },
    onDragMove: ({ over, delta }) => { last.current = { over: over ? String(over.id) : null, dx: delta.x, dy: delta.y }; refresh(); },
    onDragOver: ({ over }) => { last.current = { ...last.current, over: over ? String(over.id) : null }; refresh(); },
    onDragEnd: reset,
    onDragCancel: reset,
  });
  if (!state || typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="status"
      style={{
        position: 'fixed', zIndex: 200, pointerEvents: 'none', whiteSpace: 'nowrap',
        left: Math.max(8, Math.min(state.x - 20, window.innerWidth - 230)), top: Math.max(8, state.y - 46),
        padding: '5px 10px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, background: 'var(--color-primary)', color: '#fff',
      }}
    >
      {state.text}
    </div>,
    document.body,
  );
}
