'use client';

// The pieces Settings is built from in the v2 page design: a short row (the
// setting, one line on what it does, its control on the right), a switch, a
// tile for a switch, a status word, and a segmented choice. Every row and tile
// carries the setting's name as data-setting, which is what the "Find a
// setting" search and the command palette scroll to.

import type { ReactNode } from 'react';

const BORDER = 'var(--color-surface-border)';

/** An on/off switch. */
export function V2Switch({ on, onChange, label, disabled }: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className="relative shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
      style={{ width: 38, height: 22, background: on ? 'var(--color-primary)' : 'var(--color-surface-elevated, var(--color-surface-hover))', border: on ? '0' : `1px solid ${BORDER}` }}
    >
      <span
        className="absolute rounded-full transition-all"
        style={{ top: on ? 3 : 2, left: on ? 19 : 2, width: 16, height: 16, background: '#fff' }}
      />
    </button>
  );
}

/** A status in one word, coloured by how it is. */
export function V2Word({ tone = 'ok', children }: { tone?: 'ok' | 'off' | 'warn' | 'bad'; children: ReactNode }) {
  const color = { ok: 'var(--color-success, #22c55e)', off: 'var(--color-text-muted)', warn: 'var(--color-warning, #f59e0b)', bad: 'var(--color-error, #ef4444)' }[tone];
  return <span className="text-[13px] font-medium whitespace-nowrap" style={{ color }}>{children}</span>;
}

/** Rows in one box. */
export function V2Rows({ children }: { children: ReactNode }) {
  return (
    <div className="v2-box px-[18px] py-0.5 divide-y" style={{ borderColor: BORDER }}>
      {children}
    </div>
  );
}

/**
 * One setting: its name, a line on what it does, and its control on the right
 * (under the text on a narrow screen). `below` is anything wider that belongs
 * to the row (an input, a list). `also` is the setting's older name, so the
 * search and the command palette still land on it.
 */
export function V2SetRow({ title, line, control, below, also, disabled }: {
  title: string;
  line: ReactNode;
  control?: ReactNode;
  below?: ReactNode;
  also?: string;
  disabled?: boolean;
}) {
  return (
    <div
      data-setting={title}
      data-setting-also={also}
      className={`py-3 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      style={{ borderColor: BORDER }}
    >
      <div className="flex items-center flex-wrap gap-x-3.5 gap-y-2">
        <div className="flex-1 min-w-[14rem]">
          <p className="font-semibold text-[14.5px] text-default">{title}</p>
          <p className="text-muted text-[12.5px] mt-0.5">{line}</p>
        </div>
        {control && <div className="flex items-center gap-2 shrink-0 max-w-full">{control}</div>}
      </div>
      {below && <div className="mt-2.5">{below}</div>}
    </div>
  );
}

/** A setting as a tile with its switch. */
export function V2ToggleTile({ title, line, hint, on, onChange, also, disabled, extra }: {
  title: string;
  line: ReactNode;
  /** The longer explanation, as a tooltip. */
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  also?: string;
  disabled?: boolean;
  /** Another control beside the switch. */
  extra?: ReactNode;
}) {
  return (
    <div
      data-setting={title}
      data-setting-also={also}
      title={hint}
      className={`v2-tool ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <span className="flex-1 min-w-0">
        <p className="font-semibold text-[14.5px] text-default">{title}</p>
        <p className="text-muted text-[12.5px] mt-0.5">{line}</p>
      </span>
      {extra}
      <V2Switch on={on} onChange={onChange} label={`Turn ${title.toLowerCase()} ${on ? 'off' : 'on'}`} disabled={disabled} />
    </div>
  );
}

/** A choice between a few things, as one segmented control. */
export function V2Seg<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="menu-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A native dropdown, sized to sit in a row. */
export const V2_SELECT_CLASS = 'input-base px-3 py-1.5 text-[13px] rounded-lg max-w-full';
