'use client';

// Two-step delete. The first press does not delete: the button turns red and
// asks ("Delete?", "Remove?"), and goes back to normal if you press anywhere
// else or leave it for about four seconds. The second press does it, and the
// page then shows its Undo toast. Used for deleting a group and for taking
// someone out of a group.
//
// ArmedButton is the button itself, for the places that have one on the page
// (Classic). ArmedFloat is for the places where the first press happens in a
// ⋯ menu, which closes as it is pressed: the same red question comes up as a
// small pop-up pointing at that ⋯.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui/Button';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';

const ARM_MS = 4000;

export function ArmedButton({ armedLabel, onConfirm, children, className = '', ms = ARM_MS, ...rest }: Omit<ComponentProps<typeof Button>, 'onClick'> & {
  /** What the red button says: "Delete?", "Remove?". */
  armedLabel: string;
  onConfirm: () => void;
  ms?: number;
}) {
  const id = useId();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => { clearTimeout(timer.current); setArmed(false); }, []);

  // A press anywhere else puts it back.
  useEffect(() => {
    if (!armed) return;
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest(`[data-armed="${id}"]`)) disarm();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [armed, id, disarm]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (armed) { disarm(); onConfirm(); return; }
    setArmed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), ms);
  };

  return (
    <Button {...rest} data-armed={id} onClick={press} className={armed ? `${className} armed-btn`.trim() : className}>
      {armed ? armedLabel : children}
    </Button>
  );
}

/** The ⋯ button that opens a given menu: found by its label ("Family options", "More"). */
export function findMenuButton(label: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const all = document.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]');
  for (const b of all) if (b.getAttribute('aria-label') === label) return b;
  return null;
}

/** The link to a page ("/groups/abc"), for a card that has no ⋯ button. */
export function findLinkTo(href: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const a of document.querySelectorAll<HTMLElement>('a[href]')) if (a.getAttribute('href') === href) return a;
  return null;
}

export function ArmedFloat({ anchor, armedLabel, onConfirm, onCancel, ms = ARM_MS }: {
  /** What it points at; nothing means the page has nowhere to put it and it just asks nothing. */
  anchor: HTMLElement | null;
  armedLabel: string;
  onConfirm: () => void;
  /** Pressed elsewhere, Escape, or the time ran out. */
  onCancel: () => void;
  ms?: number;
}) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });
  useEffect(() => {
    const t = setTimeout(() => cancelRef.current(), ms);
    return () => clearTimeout(t);
  }, [ms]);
  if (!anchor) return null;
  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onCancel} width={132} align="end" label={armedLabel} caret closeButton={false}>
      <button
        type="button"
        className="v2-btn armed-btn w-full justify-center"
        style={{ padding: '9px 12px' }}
        onClick={onConfirm}
        autoFocus
      >
        {armedLabel}
      </button>
    </AnchoredPopup>
  );
}
