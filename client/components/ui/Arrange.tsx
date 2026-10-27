'use client';

// The pieces every page uses to be arranged: the Arrange button, the bar that
// shows while arranging, the up/down/hide buttons, the fold chevron, a
// section's ⋯ menu, and the tray of hidden things. Pages decide what their
// sections are; lib/arrange.tsx keeps the order.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AdjustmentsHorizontalIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon,
  EllipsisHorizontalIcon, EyeIcon, EyeSlashIcon,
} from '@heroicons/react/24/outline';
import type { PageArrange } from '@/lib/arrange';

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
  if (!arrange.arranging) return null;
  return (
    <div className="arrange-bar" role="region" aria-label="Arranging this page">
      <AdjustmentsHorizontalIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-primary)' }} />
      <b className="text-sm">Arranging</b>
      <span className="text-muted text-[13px] flex-1 min-w-0 max-sm:hidden">
        The arrows move, the eye hides, the chevron folds. Saved to your account, so it follows you to every device.
      </span>
      <span className="flex-1 sm:hidden" />
      <button type="button" className="arrange-pill" onClick={arrange.reset} disabled={arrange.isDefault}>Reset</button>
      <button type="button" className="arrange-pill arrange-pill-main" onClick={() => arrange.setArranging(false)}>Done</button>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    // Kept from reaching a card's own link around it.
    <button type="button" className="arrange-icon" aria-label={label} title={label} disabled={disabled}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

/** Up, down and hide for one section or item, shown while arranging. */
export function ArrangeControls({ arrange, id, label, hideLabel = 'Hide' }: { arrange: PageArrange; id: string; label: string; hideLabel?: string }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <IconBtn label={`Move ${label} up`} onClick={() => arrange.move(id, -1)} disabled={!arrange.canMove(id, -1)}>
        <ChevronUpIcon className="w-4 h-4" />
      </IconBtn>
      <IconBtn label={`Move ${label} down`} onClick={() => arrange.move(id, 1)} disabled={!arrange.canMove(id, 1)}>
        <ChevronDownIcon className="w-4 h-4" />
      </IconBtn>
      <IconBtn label={`${hideLabel} ${label}`} onClick={() => arrange.hide(id)}>
        <EyeIcon className="w-4 h-4" />
      </IconBtn>
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

/** A section's ⋯ menu: the quick moves without entering Arrange mode. */
export function SectionMenu({ arrange, id, label, noun = 'section' }: { arrange: PageArrange; id: string; label: string; noun?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const folded = arrange.isFolded(id);
  const item = (icon: ReactNode, text: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="arrange-menu-item"
      onClick={() => { setOpen(false); onClick(); }}
    >
      {icon}
      {text}
    </button>
  );
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        className="arrange-icon arrange-icon-plain"
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <EllipsisHorizontalIcon className="w-5 h-5" />
      </button>
      {open && (
        <div className="arrange-menu" role="menu">
          {item(<ChevronUpIcon className="w-4 h-4" />, 'Move up', () => arrange.move(id, -1), !arrange.canMove(id, -1))}
          {item(<ChevronDownIcon className="w-4 h-4" />, 'Move down', () => arrange.move(id, 1), !arrange.canMove(id, 1))}
          {item(folded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />, folded ? `Unfold this ${noun}` : `Fold this ${noun}`, () => arrange.fold(id, !folded))}
          {item(<EyeSlashIcon className="w-4 h-4" />, `Hide this ${noun}`, () => arrange.hide(id))}
          {item(<AdjustmentsHorizontalIcon className="w-4 h-4" />, 'Arrange the whole page', () => arrange.setArranging(true))}
        </div>
      )}
    </div>
  );
}

/** What's hidden on this page, each one a click from coming back. */
export function HiddenTray({ arrange, labelOf, note, extra = [] }: {
  arrange: PageArrange;
  labelOf: (id: string) => ReactNode;
  note?: string;
  /** More hidden things kept by another arrangement on the same page (a page's people, beside its groups). */
  extra?: { id: string; label: ReactNode; show: () => void }[];
}) {
  const entries = [...arrange.hidden.map((id) => ({ id, label: labelOf(id), show: () => arrange.show(id) })), ...extra];
  if (entries.length === 0) return null;
  // Outside Arrange mode the tray stays out of the way: one quiet line.
  if (!arrange.arranging) {
    return (
      <button type="button" className="arrange-hidden-line" onClick={() => arrange.setArranging(true)}>
        <EyeSlashIcon className="w-4 h-4" />
        {entries.length} hidden on this page
      </button>
    );
  }
  return (
    <div className="arrange-tray">
      <div className="flex items-center gap-2.5">
        <EyeSlashIcon className="w-5 h-5 text-muted" />
        <b className="text-sm">Hidden on this page</b>
        <span className="text-muted text-[13px]">{entries.length}</span>
      </div>
      <div className="flex flex-wrap gap-2.5 mt-3">
        {entries.map((e) => (
          <button key={e.id} type="button" className="arrange-chip" onClick={e.show} title="Show it again">
            <EyeIcon className="w-4 h-4" />
            {e.label}
          </button>
        ))}
      </div>
      <div className="text-muted text-[12.5px] mt-2.5">{note || 'Hidden only here. Tap one to bring it back.'}</div>
    </div>
  );
}

/**
 * One arrangeable section: its heading row (fold chevron, title, and either
 * the ⋯ menu or, while arranging, the arrows and eye) and its body, which
 * folding hides.
 */
export function ArrangeSection({
  arrange, id, title, label: labelProp, meta, actions, children, noun,
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
}) {
  const label = labelProp || (typeof title === 'string' ? title : id);
  const folded = arrange.isFolded(id);
  return (
    <section className={arrange.arranging ? 'arrange-section arrange-section-on' : 'arrange-section'} aria-label={label}>
      <div className="flex items-center gap-2.5 min-w-0">
        <FoldButton arrange={arrange} id={id} label={label} />
        <div className="min-w-0 flex items-baseline gap-2.5 flex-wrap">
          <h2 className="text-lg font-semibold truncate">{title}</h2>
          {meta && <span className="text-muted text-[13px]">{meta}{folded ? ' · folded' : ''}</span>}
          {!meta && folded && <span className="text-muted text-[13px]">folded</span>}
        </div>
        <span className="flex-1" />
        {!arrange.arranging && actions}
        {arrange.arranging
          ? <ArrangeControls arrange={arrange} id={id} label={label} />
          : <SectionMenu arrange={arrange} id={id} label={label} noun={noun} />}
      </div>
      {!folded && <div className="mt-3">{children}</div>}
    </section>
  );
}

const PanelContext = createContext<{ arrange: PageArrange; id: string; label: string } | null>(null);

/**
 * A panel that already draws its own heading (the Dashboard's cards). The
 * panel puts <PanelControls /> in its heading row; folded, the panel shrinks
 * to one line; while arranging, a strip with the arrows and eye sits on top.
 */
export function ArrangePanel({
  arrange, id, label, className, children, ownHeading = true,
}: {
  arrange: PageArrange;
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
  /** False for a panel with no heading row (the numbers): it gets a strip of its own while arranging. */
  ownHeading?: boolean;
}) {
  const folded = arrange.isFolded(id);
  const ctx = { arrange, id, label };
  return (
    <PanelContext.Provider value={ctx}>
      {/* A column, so a card that fills its grid cell (h-full) fills only
          what's left under the arranging strip instead of spilling over. */}
      <div className={`flex flex-col ${className || ''}${arrange.arranging ? ' arrange-section-on' : ''}`} data-arrange-panel={id}>
        {arrange.arranging && !ownHeading && !folded && (
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
            {arrange.arranging
              ? <ArrangeControls arrange={arrange} id={id} label={label} />
              : <SectionMenu arrange={arrange} id={id} label={label} noun="panel" />}
          </div>
        ) : <div className="flex-1 min-h-0">{children}</div>}
      </div>
    </PanelContext.Provider>
  );
}

/** The fold chevron and ⋯ menu inside an ArrangePanel's own heading. */
export function PanelControls({ side }: { side: 'start' | 'end' }) {
  const ctx = useContext(PanelContext);
  if (!ctx) return null;
  if (side === 'start') return <FoldButton arrange={ctx.arrange} id={ctx.id} label={ctx.label} />;
  // While arranging, the arrows and eye take the ⋯ menu's place.
  return ctx.arrange.arranging
    ? <ArrangeControls arrange={ctx.arrange} id={ctx.id} label={ctx.label} />
    : <SectionMenu arrange={ctx.arrange} id={ctx.id} label={ctx.label} noun="panel" />;
}
