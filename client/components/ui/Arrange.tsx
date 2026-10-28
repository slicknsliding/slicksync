'use client';

// The pieces every page uses to be arranged: the Arrange button, the bar that
// shows while arranging, the grip/up/down/hide buttons, the fold chevron, a
// section's ⋯ menu, and the tray of hidden things. Pages decide what their
// sections are; lib/arrange.tsx keeps the order. Dragging comes with
// ArrangeSection, ArrangePanel and ArrangeControls (arrange.sort); a list of
// your own keys uses useSortableScope + SortableItem + ArrangeGrip from
// lib/arrange.tsx (documented there).

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  AdjustmentsHorizontalIcon, ArrowUturnLeftIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon,
  EyeIcon, EyeSlashIcon, MapPinIcon,
} from '@heroicons/react/24/outline';
import { SortableItem, useGrip, type PageArrange, type SortableState } from '@/lib/arrange';
import type { SectionSize } from '@/lib/arrange-core';
import { useIsTV } from '@/lib/hooks/useIsTV';

export function ArrangeButton({ arrange }: { arrange: PageArrange }) {
  const on = arrange.arranging;
  return (
    <button
      type="button"
      onClick={() => arrange.setArranging(!on)}
      aria-pressed={on}
      className={`arrange-btn${on ? ' arrange-btn-on' : ''}`}
      title="Move, fold and hide this page’s sections"
    >
      <AdjustmentsHorizontalIcon className="w-4 h-4" />
      Arrange
    </button>
  );
}

export function ArrangeBar({ arrange }: { arrange: PageArrange }) {
  const isTV = useIsTV();
  if (!arrange.arranging) return null;
  return (
    <div className="arrange-bar" role="region" aria-label="Arranging this page">
      <AdjustmentsHorizontalIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-primary)' }} />
      <b className="text-sm">Arranging</b>
      <span className="text-muted text-[13px] flex-1 min-w-0 max-sm:hidden">
        {isTV
          ? 'The arrows move, the eye hides, the chevron folds. Saved to your account, so it follows you to every device.'
          : 'Drag the grip, or use the arrows, to move. The eye hides, the chevron folds. Saved to your account, so it follows you to every device.'}
      </span>
      <span className="flex-1 sm:hidden" />
      <div className="arrange-bar-actions">
        <button type="button" className="arrange-pill" onClick={arrange.undo} disabled={!arrange.canUndo} title="Undo the last change">
          <ArrowUturnLeftIcon className="w-[15px] h-[15px]" />Undo
        </button>
        <button type="button" className="arrange-pill" onClick={arrange.cancel} title="Put this page back as it was before you started arranging">Cancel</button>
        <button type="button" className="arrange-pill" onClick={arrange.reset} disabled={arrange.isDefault}>Reset</button>
        <button type="button" className="arrange-pill arrange-pill-main" onClick={() => arrange.setArranging(false)}>Done</button>
      </div>
    </div>
  );
}

export function ArrangeIconButton({ label, onClick, disabled, on, children }: { label: string; onClick: () => void; disabled?: boolean; on?: boolean; children: ReactNode }) {
  return (
    // Kept from reaching a card's own link around it.
    <button type="button" className={`arrange-icon${on ? ' arrange-icon-on' : ''}`} aria-label={label} title={label} disabled={disabled} aria-pressed={on}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

/**
 * The handle you drag by (six dots). `drag` is what SortableItem hands its
 * child; it draws nothing where dragging doesn't exist (TV).
 */
export function ArrangeGrip({ drag, label }: { drag: SortableState | null; label: string }) {
  const grip = drag?.grip;
  if (!grip) return null;
  const { ref, ...rest } = grip;
  return (
    <button
      type="button"
      {...rest}
      ref={ref as Ref<HTMLButtonElement>}
      className="arrange-icon arrange-grip"
      aria-label={`Drag ${label}`}
      title="Drag to move"
      // Kept from reaching a card's own link around it.
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor" aria-hidden="true">
        <circle cx="5.5" cy="3.5" r="1.3" /><circle cx="10.5" cy="3.5" r="1.3" />
        <circle cx="5.5" cy="8" r="1.3" /><circle cx="10.5" cy="8" r="1.3" />
        <circle cx="5.5" cy="12.5" r="1.3" /><circle cx="10.5" cy="12.5" r="1.3" />
      </svg>
    </button>
  );
}

function Seg<T extends string>({ label, value, options, onPick, className = '' }: {
  label: string;
  value: T;
  options: { value: T; text: string; aria: string }[];
  onPick: (v: T) => void;
  className?: string;
}) {
  return (
    <span className={`arrange-seg ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'on' : ''}
          aria-pressed={value === o.value}
          aria-label={o.aria}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick(o.value); }}
        >
          {o.text}
        </button>
      ))}
    </span>
  );
}

const WIDTHS: { value: SectionSize; text: string }[] = [{ value: 'full', text: 'Full' }, { value: 'half', text: 'Half' }, { value: 'third', text: 'Third' }];

// ------------------------------------------------------------ stretch -----

export type StretchKind = 'cards' | 'posters' | 'row';
// Card width (px) from 600px wide up, and cards per row on a phone.
const STRETCH: Record<StretchKind, { min: number; max: number; phone: [number, number] }> = {
  cards: { min: 200, max: 720, phone: [1, 2] },
  posters: { min: 100, max: 360, phone: [2, 5] },
  row: { min: 140, max: 560, phone: [1, 3] },
};
const PHONE = 600;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The round handle on the first card's corner while arranging: drag it (or
 * focus it and press the arrows) to make every card in this grid or row
 * bigger or smaller. A grid snaps to whole cards per row; a phone counts cards
 * per row, a wider screen keeps a card width. Put it inside the grid or row,
 * which spreads arrange.cardAttrs(id).
 */
export function StretchHandle({ arrange, id, kind = 'cards', label = 'cards' }: { arrange: PageArrange; id: string; kind?: StretchKind; label?: string }) {
  const isTV = useIsTV();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  // While dragging: the first card's corner (x0, y0), the outline's size and its label, and how wide the grid is.
  const [drag, setDrag] = useState<{ x0: number; y0: number; w: number; h: number; text: string; room: number } | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const on = arrange.arranging && !isTV;

  const host = () => ref.current?.parentElement || null;
  const firstCard = () => {
    const h = host();
    return h ? [...h.children].find((c) => !(c as HTMLElement).dataset.stretchUi) as HTMLElement | undefined : undefined;
  };

  // Sit on the first card's bottom-right corner, and follow it as things move.
  useLayoutEffect(() => {
    if (!on) return;
    const h = host();
    if (!h) return;
    if (getComputedStyle(h).position === 'static') h.style.position = 'relative';
    const place = () => {
      const c = firstCard();
      if (!c) { setSpot(null); return; }
      const inset = kind === 'row' ? 22 : 0;
      setSpot({ x: c.offsetLeft + c.offsetWidth - inset, y: c.offsetTop + c.offsetHeight - inset });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(h);
    const c = firstCard();
    if (c) ro.observe(c);
    return () => ro.disconnect();
  }, [on, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on || !spot) return <span ref={ref} data-stretch-ui="1" hidden />;

  const lim = STRETCH[kind];
  // What a pointer at `wanted` px wide gives: the size to keep, the outline to draw and its label.
  const measure = (wanted: number) => {
    const h = host()!, c = firstCard()!;
    const phone = window.innerWidth < PHONE;
    const cs = getComputedStyle(h);
    const gap = parseFloat(cs.columnGap) || 12;
    const width = h.clientWidth;
    const fit = (n: number) => (width - gap * (n - 1)) / n;
    if (phone || kind !== 'row') {
      const most = phone ? lim.phone[1] : Math.max(1, Math.floor((width + gap) / (lim.min + gap)));
      const least = phone ? lim.phone[0] : Math.max(1, Math.ceil((width + gap) / (lim.max + gap)));
      const n = clamp(Math.round((width + gap) / (wanted + gap)), least, Math.max(least, most));
      const w = fit(n);
      return { keep: phone ? { p: n } : { w: Math.max(1, Math.floor(w) - 1) }, w, h: c.offsetHeight * Math.pow(w / c.offsetWidth, 0.35), text: `${n} per row` };
    }
    const w = clamp(Math.round(wanted / 10) * 10, lim.min, Math.min(lim.max, width));
    const n = Math.max(1, Math.floor((width + gap) / (w + gap)));
    return { keep: { w }, w, h: c.offsetHeight * Math.pow(w / c.offsetWidth, 0.35), text: `About ${n} on screen` };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const c = firstCard();
    if (!c) return;
    const left = c.getBoundingClientRect().left;
    const x0 = c.offsetLeft, y0 = c.offsetTop, room = host()?.clientWidth || 0;
    const btn = e.currentTarget;
    btn.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const m = measure(ev.clientX - left);
      pending.current = () => arrange.setCardSizing(id, m.keep);
      setDrag({ x0, y0, room, w: m.w, h: m.h, text: m.text });
    };
    const up = () => {
      btn.removeEventListener('pointermove', move);
      btn.removeEventListener('pointerup', up);
      btn.removeEventListener('pointercancel', cancel);
      pending.current?.();
      pending.current = null;
      setDrag(null);
    };
    const cancel = () => { pending.current = null; up(); };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', cancel);
  };

  // The arrows: one more or one fewer per row (a row: 40px smaller or bigger).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const c = firstCard();
    if (!c) return;
    const bigger = e.key === 'ArrowRight';
    const h = host()!;
    const gap = parseFloat(getComputedStyle(h).columnGap) || 12;
    const now = Math.max(1, Math.round((h.clientWidth + gap) / (c.offsetWidth + gap)));
    const wanted = kind === 'row' && window.innerWidth >= PHONE
      ? c.offsetWidth + (bigger ? 40 : -40)
      : (h.clientWidth - gap * (now + (bigger ? -2 : 0))) / Math.max(1, now + (bigger ? -1 : 1));
    arrange.setCardSizing(id, measure(wanted).keep);
  };

  const at = drag ? { x: drag.x0 + drag.w, y: drag.y0 + drag.h } : spot;
  return (
    <>
      {drag && (
        <>
          <span data-stretch-ui="1" className="stretch-ghost" style={{ left: drag.x0, top: drag.y0, width: drag.w, height: drag.h }} />
          <span data-stretch-ui="1" className="stretch-label" style={{ left: Math.max(0, Math.min(at.x + 14, drag.room - 190)), top: at.y + 14 }}>{drag.text} · let go to keep</span>
        </>
      )}
      <button
        ref={ref}
        type="button"
        data-stretch-ui="1"
        className={`stretch-handle${drag ? ' stretch-handle-on' : ''}`}
        style={{ left: at.x, top: at.y }}
        aria-label={`Card size of ${label}: drag, or press the left and right arrows`}
        title="Drag to make the cards bigger or smaller"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-3.5 h-3.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15l6-6M10 9h5v5" />
        </svg>
      </button>
    </>
  );
}

/**
 * The page's sections laid out for Width: one column on a phone, six on a
 * laptop and up, where a section takes 6 (Full), 3 (Half) or 2 (Third) of them.
 * Put arrange.spanClass(id) on each section's wrapper.
 */
export function ArrangeGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 lg:grid-cols-6 gap-x-5 gap-y-7 items-start ${className}`}>{children}</div>;
}

/** Grip (when the thing is in a SortableItem of this page), pin, up, down and hide for one section or item, shown while arranging. */
export function ArrangeControls({ arrange, id, label, hideLabel = 'Hide', pin }: {
  arrange: PageArrange;
  id: string;
  label: string;
  hideLabel?: string;
  /** The section holds a row or grid of cards (sized by its StretchHandle). */
  cards?: boolean;
  /** A pin button before the arrows: pinned things always sit first. */
  pin?: { on: boolean; toggle: () => void };
}) {
  const drag = useGrip(arrange.sort, id);
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <ArrangeGrip drag={drag} label={label} />
      {/* Width only matters where sections sit side by side (a laptop and up). */}
      {arrange.hasWidths && (
        <Seg
          className="arrange-seg-width"
          label={`Width of ${label}`}
          value={arrange.widthOf(id)}
          options={WIDTHS.map((w) => ({ ...w, aria: `${label} width: ${w.text}` }))}
          onPick={(w) => arrange.setWidth(id, w)}
        />
      )}
      {pin && (
        <ArrangeIconButton label={pin.on ? `Unpin ${label}` : `Pin ${label} first`} onClick={pin.toggle} on={pin.on}>
          <MapPinIcon className="w-4 h-4" />
        </ArrangeIconButton>
      )}
      <ArrangeIconButton label={`Move ${label} up`} onClick={() => arrange.move(id, -1)} disabled={!arrange.canMove(id, -1)}>
        <ChevronUpIcon className="w-4 h-4" />
      </ArrangeIconButton>
      <ArrangeIconButton label={`Move ${label} down`} onClick={() => arrange.move(id, 1)} disabled={!arrange.canMove(id, 1)}>
        <ChevronDownIcon className="w-4 h-4" />
      </ArrangeIconButton>
      <ArrangeIconButton label={`${hideLabel} ${label}`} onClick={() => arrange.hide(id)}>
        <EyeIcon className="w-4 h-4" />
      </ArrangeIconButton>
    </span>
  );
}

/** The chevron that folds a section. */
export function FoldButton({ arrange, id, label }: { arrange: PageArrange; id: string; label: string }) {
  const folded = arrange.isFolded(id);
  return (
    <button
      type="button"
      className="arrange-fold"
      aria-expanded={!folded}
      aria-label={folded ? `Unfold ${label}` : `Fold ${label}`}
      title={folded ? 'Unfold' : 'Fold'}
      onClick={() => arrange.fold(id, !folded)}
    >
      {folded ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
    </button>
  );
}

/**
 * What's hidden on this page, each one a click from coming back. Only while
 * arranging: outside Arrange mode nothing about hidden things shows.
 */
export function HiddenTray({ arrange, labelOf, extra = [] }: {
  arrange: PageArrange;
  labelOf: (id: string) => ReactNode;
  /** Kept for older callers; the tray always says "Tap to bring back". */
  note?: string;
  /** More hidden things kept by another arrangement on the same page (a page's people, beside its groups). */
  extra?: { id: string; label: ReactNode; show: () => void }[];
}) {
  const entries = [...arrange.hidden.map((id) => ({ id, label: labelOf(id), show: () => arrange.show(id) })), ...extra];
  if (!arrange.arranging || entries.length === 0) return null;
  return (
    <div className="arrange-tray" role="region" aria-label="Hidden on this page">
      <div className="flex items-center gap-x-2.5 gap-y-2 flex-wrap">
        <EyeSlashIcon className="w-5 h-5 text-muted" />
        <b className="text-sm">Hidden:</b>
        {entries.map((e) => (
          <button key={e.id} type="button" className="arrange-chip" onClick={e.show} title="Tap to bring back">
            <EyeIcon className="w-4 h-4" />
            {e.label}
          </button>
        ))}
        <span className="text-muted text-[13px]">Tap to bring back</span>
      </div>
    </div>
  );
}

/**
 * One arrangeable section: its heading row (fold chevron, title, and while
 * arranging the arrows and eye) and its body, which folding hides.
 */
export function ArrangeSection({
  arrange, id, title, label: labelProp, meta, actions, children, emptyNote, cards,
}: {
  arrange: PageArrange;
  id: string;
  title: ReactNode;
  /** Plain-text name for the buttons, when the title isn't plain text. */
  label?: string;
  /** Small text beside the title (counts). */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  noun?: string;
  /**
   * For a section with nothing in it right now, drawn only while arranging
   * (usePageArrangement's `empty`): its body becomes a dashed placeholder
   * with this line, and `children` is ignored.
   */
  emptyNote?: ReactNode;
  /** The section holds a row or grid of cards: put a <StretchHandle> in it and spread arrange.cardAttrs(id) on it. */
  cards?: boolean;
}) {
  const label = labelProp || (typeof title === 'string' ? title : id);
  const folded = arrange.isFolded(id);
  return (
    <SortableItem scope={arrange.sort} itemKey={id}>
      {(d) => (
    <section
      ref={d.ref as Ref<HTMLElement>}
      style={d.style}
      className={`${arrange.arranging ? 'arrange-section arrange-section-on' : 'arrange-section'}${arrange.hasWidths ? ` ${arrange.spanClass(id)}` : ''}${d.className ? ` ${d.className}` : ''}`}
      aria-label={label}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
        <FoldButton arrange={arrange} id={id} label={label} />
        <div className="min-w-0 flex items-baseline gap-2.5 flex-wrap">
          <h2 className="text-lg font-semibold truncate">{title}</h2>
          {meta && <span className="text-muted text-[13px]">{meta}{folded ? ' · folded' : ''}</span>}
          {!meta && folded && <span className="text-muted text-[13px]">folded</span>}
        </div>
        <span className="flex-1" />
        {/* On a phone the section's own controls take a line under its title, so neither gets squeezed. */}
        {!arrange.arranging && actions && <div className="flex items-center gap-2 max-sm:order-last max-sm:basis-full">{actions}</div>}
        {arrange.arranging && <ArrangeControls arrange={arrange} id={id} label={label} cards={cards} />}
      </div>
      {!folded && <div className="mt-3">{emptyNote ? <div className="arrange-empty">{emptyNote}</div> : children}</div>}
    </section>
      )}
    </SortableItem>
  );
}

const PanelContext = createContext<{ arrange: PageArrange; id: string; label: string } | null>(null);

/**
 * A panel that already draws its own heading (the Dashboard's cards). The
 * panel puts <PanelControls /> in its heading row; folded, the panel shrinks
 * to one line; while arranging, a strip with the arrows and eye sits on top.
 */
export function ArrangePanel({
  arrange, id, label, className, children, ownHeading = true, emptyNote,
}: {
  arrange: PageArrange;
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
  /** False for a panel with no heading row (the numbers): it gets a strip of its own while arranging. */
  ownHeading?: boolean;
  /** A panel with nothing in it right now, drawn only while arranging: a dashed placeholder instead of `children`. */
  emptyNote?: ReactNode;
}) {
  const folded = arrange.isFolded(id);
  const ctx = { arrange, id, label };
  return (
    <SortableItem scope={arrange.sort} itemKey={id}>
      {(d) => (
    <PanelContext.Provider value={ctx}>
      {/* A column, so a card that fills its grid cell (h-full) fills only
          what's left under the arranging strip instead of spilling over. */}
      <div
        ref={d.ref as Ref<HTMLDivElement>}
        style={d.style}
        className={`flex flex-col ${className || ''}${arrange.hasWidths ? ` ${arrange.spanClass(id)}` : ''}${arrange.arranging ? ' arrange-section-on' : ''}${d.className ? ` ${d.className}` : ''}`}
        data-arrange-panel={id}
      >
        {arrange.arranging && (!ownHeading || emptyNote) && !folded && (
          <div className="flex items-center gap-2.5 mb-2 px-1">
            <FoldButton arrange={arrange} id={id} label={label} />
            <b className="text-sm flex-1 min-w-0 truncate">{label}</b>
            <ArrangeControls arrange={arrange} id={id} label={label} />
          </div>
        )}
        {folded ? (
          <div className="arrange-folded">
            <FoldButton arrange={arrange} id={id} label={label} />
            <b className="text-base font-semibold font-display flex-1 min-w-0 truncate">
              {label} <span className="text-muted font-normal text-[13px]">· folded</span>
            </b>
            {arrange.arranging && <ArrangeControls arrange={arrange} id={id} label={label} />}
          </div>
        ) : <div className="flex-1 min-h-0">{emptyNote ? <div className="arrange-empty">{emptyNote}</div> : children}</div>}
      </div>
    </PanelContext.Provider>
      )}
    </SortableItem>
  );
}

/** The fold chevron, and while arranging the controls, inside an ArrangePanel's own heading. */
export function PanelControls({ side }: { side: 'start' | 'end' }) {
  const ctx = useContext(PanelContext);
  if (!ctx) return null;
  if (side === 'start') return <FoldButton arrange={ctx.arrange} id={ctx.id} label={ctx.label} />;
  return ctx.arrange.arranging ? <ArrangeControls arrange={ctx.arrange} id={ctx.id} label={ctx.label} /> : null;
}
