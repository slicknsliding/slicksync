'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

const ARMED_MS = 4000;

/** Two presses to do something you can take back from the Undo toast: the
 *  first only turns the button red ("Delete?"), the second acts at once. It
 *  goes back to normal after about four seconds, or on a press elsewhere. */
export function useTwoStep(onConfirm: () => void, ms: number = ARMED_MS) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);

  const disarm = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setArmed(false);
  }, []);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!armed) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) disarm(); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [armed, disarm]);

  const press = useCallback(() => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => { timer.current = null; setArmed(false); }, ms);
      return;
    }
    disarm();
    onConfirm();
  }, [armed, disarm, onConfirm, ms]);

  return { armed, press, ref };
}

/** The button itself. `label` is the resting text (none for an icon-only
 *  button), `armedLabel` what the first press turns it into. */
export function TwoStepButton({ onConfirm, label, armedLabel = 'Delete?', icon, className = '', ariaLabel, title, disabled }: {
  onConfirm: () => void;
  label?: ReactNode;
  armedLabel?: ReactNode;
  icon?: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { armed, press, ref } = useTwoStep(onConfirm);
  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      type="button"
      disabled={disabled}
      title={title}
      aria-label={armed ? `${typeof armedLabel === 'string' ? armedLabel : 'Confirm'} Press again to confirm` : ariaLabel}
      data-armed={armed ? 'true' : undefined}
      className={`${className}${armed ? ' two-step-armed' : ''}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); press(); }}
    >
      {!armed && icon}
      {armed ? armedLabel : label}
    </button>
  );
}
