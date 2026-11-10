'use client';

// A small "are you sure" question that opens right next to the button it
// came from (the ⋯ on a poster, a Delete button), instead of a window in the
// middle of the screen. Built on AnchoredPopup (placing, caret, closing on
// Escape or a press outside). The safe choice ("Keep it") is on the left and
// has focus when it opens, so a second accidental tap or OK press does
// nothing harmful. On a TV the two buttons are remote stops and the remote
// lands on the safe one.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { TrashIcon } from '@heroicons/react/24/outline';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';

export type ConfirmAsk = {
  /** "Delete Copper Sky?" */
  title: string;
  /** One short line under the title: what else happens. */
  line?: string;
  /** Default "Keep it". */
  keepLabel?: string;
  /** Default "Delete". */
  confirmLabel?: string;
};

/** TV only: keeps the remote inside the question while it is open, on Keep it. */
function TVScope({ keepKey, children }: { keepKey: string; children: ReactNode }) {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({ trackChildren: true, isFocusBoundary: true });
  useEffect(() => {
    // The buttons register a moment after this mounts.
    const timers = [0, 60, 200].map((d) => setTimeout(() => { try { setFocus(keepKey); } catch {} }, d));
    return () => timers.forEach(clearTimeout);
  }, [keepKey]);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref}>{children}</div>
    </FocusContext.Provider>
  );
}

function Question({ anchorRef, ask, onKeep, onConfirm, returnFocusKey }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  ask: ConfirmAsk;
  onKeep: () => void;
  onConfirm: () => void;
  returnFocusKey?: string;
}) {
  const isTV = useIsTV();
  const keepKey = `confirm-keep-${useId()}`;
  const keepRef = useRef<HTMLButtonElement>(null);

  // TV: AnchoredPopup hands native focus back to the trigger when it goes. A
  // TV moves with the remote's own focus, and a native focus as well would let
  // one OK press the button twice - so drop it, and put the remote back on
  // the button the question came from.
  useEffect(() => {
    if (!isTV) return;
    return () => {
      setTimeout(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        if (returnFocusKey) { try { setFocus(returnFocusKey); } catch {} }
      }, 0);
    };
  }, [isTV, returnFocusKey]);

  const keep = (
    <button ref={keepRef} type="button" className="v2-btn w-full justify-center" style={{ padding: '9px 12px' }} onClick={onKeep} tabIndex={isTV ? -1 : undefined}>
      {ask.keepLabel || 'Keep it'}
    </button>
  );
  const del = (
    <button
      type="button"
      className="v2-btn w-full justify-center"
      style={{ padding: '9px 12px', background: 'var(--color-error, #ef4444)', borderColor: 'transparent', color: '#fff' }}
      onClick={onConfirm}
      tabIndex={isTV ? -1 : undefined}
    >
      {ask.confirmLabel || 'Delete'}
    </button>
  );
  const body = (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-2.5 items-start">
        <span
          className="shrink-0 inline-flex items-center justify-center rounded-[10px]"
          style={{ width: 32, height: 32, color: 'var(--color-error, #ef4444)', background: 'color-mix(in srgb, var(--color-error, #ef4444) 16%, transparent)' }}
          aria-hidden="true"
        >
          <TrashIcon className="w-[17px] h-[17px]" />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-[15px] leading-snug text-default break-words">{ask.title}</div>
          {ask.line && <div className="text-[13px] leading-snug mt-[3px] text-muted">{ask.line}</div>}
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        {isTV ? (
          <>
            <TVFocusable focusKey={keepKey} onEnterPress={onKeep} className="flex-1">{keep}</TVFocusable>
            <TVFocusable onEnterPress={onConfirm} className="flex-1">{del}</TVFocusable>
          </>
        ) : (
          <>
            <span className="flex-1">{keep}</span>
            <span className="flex-1">{del}</span>
          </>
        )}
      </div>
    </div>
  );

  return (
    <AnchoredPopup
      anchorRef={anchorRef}
      onClose={onKeep}
      width={300}
      align="end"
      label={ask.title}
      caret
      closeButton={false}
      initialFocusRef={isTV ? undefined : keepRef}
    >
      {isTV ? <TVScope keepKey={keepKey}>{body}</TVScope> : body}
    </AnchoredPopup>
  );
}

export function AnchoredConfirm({ open, ...rest }: {
  /** The button the question points at. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  ask: ConfirmAsk;
  /** Closed without deleting: Keep it, Escape, or a press elsewhere. */
  onKeep: () => void;
  onConfirm: () => void;
  /** TV: the remote stop to go back to once it closes (the button it came from). */
  returnFocusKey?: string;
}) {
  return open ? <Question {...rest} /> : null;
}

/** What deleting a library title also does, in the person's own app. */
export function libraryDeleteLine(provider: string | null | undefined, count = 1): string | undefined {
  const it = count === 1 ? 'It comes' : 'They come';
  if (provider === 'jellyfin') return `${it} off your favourites and Continue Watching on your Jellyfin server.`;
  if (provider === 'stremio') return `${it} out of your library in Stremio too.`;
  return undefined;
}
