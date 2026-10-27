'use client';

// Shared pieces of the v2 page design (Themes → Page design → v2): one status
// in plain words with its dot, the section heading, and the card and row
// shells every v2 page builds from.

import type { ReactNode } from 'react';

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
export function V2Card({ children, footer, action, className = '' }: { children: ReactNode; footer?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`v2-card ${className}`}>
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
export function V2Grid({ children, max }: { children: ReactNode; max?: 3 }) {
  return <div className={max === 3 ? 'v2-grid v2-grid-3' : 'v2-grid'}>{children}</div>;
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
