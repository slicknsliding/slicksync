import type { ReactNode } from 'react';

/**
 * What an empty list shows instead of a line of gray text: a small drawing,
 * one line saying what would be here, and optionally the one thing to do
 * about it. Only for lists that stay on screen when they are empty.
 */
export function EmptyState({ art, title, line, action, tight = false }: {
  art: 'screen' | 'bell' | 'vault' | 'catalog';
  title: string;
  line?: string;
  action?: ReactNode;
  /** Less room around it (a pop-up). */
  tight?: boolean;
}) {
  return (
    <div className={`empty-state${tight ? ' tight' : ''}`}>
      {art === 'screen' ? (
        <svg viewBox="0 0 92 70" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="14" y="14" width="64" height="40" rx="6" />
          <path d="M34 62h24M46 54v8" />
          <g className="empty-state-float" stroke="var(--color-primary)">
            <path d="M40 28h10l-10 12h10" />
            <path d="M58 22h6l-6 7h6" opacity="0.6" />
          </g>
        </svg>
      ) : art === 'vault' ? (
        <svg viewBox="0 0 92 70" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="24" y="30" width="44" height="30" rx="6" />
          <path d="M34 30v-8a12 12 0 0 1 24 0v8" />
          <g className="empty-state-float" stroke="var(--color-primary)">
            <circle cx="46" cy="43" r="3.5" />
            <path d="M46 46.5v6" />
          </g>
        </svg>
      ) : art === 'catalog' ? (
        <svg viewBox="0 0 92 70" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="22" y="12" width="48" height="12" rx="4" opacity="0.6" />
          <rect x="18" y="26" width="56" height="14" rx="4" />
          <rect x="14" y="42" width="64" height="16" rx="5" />
          <g className="empty-state-float" stroke="var(--color-primary)">
            <path d="M26 50h18M26 33h14" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 92 70" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M30 48V34a16 16 0 1 1 32 0v14l4 6H26z" />
          <path d="M41 58a5 5 0 0 0 10 0" />
          <g className="empty-state-float" stroke="var(--color-primary)">
            <path d="M68 18l2.2 4.6 4.8.7-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8-3.5-3.4 4.8-.7z" />
          </g>
        </svg>
      )}
      <p className="empty-state-title">{title}</p>
      {line && <p className="empty-state-line">{line}</p>}
      {action}
    </div>
  );
}
