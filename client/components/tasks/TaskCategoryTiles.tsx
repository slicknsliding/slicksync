'use client';

// The four category tiles at the top of Tasks. Each tile is one click target
// (the whole tile), shows how many tools sit behind it, and the open one is
// filled. On a D-pad (TV) each tile takes focus and OK picks it.

import { TVFocusable } from '@/components/tv/TVFocusable';

export interface TaskCategory {
  key: string;
  label: string;
  description: string;
  icon: React.ComponentType<React.ComponentProps<'svg'>>;
  /** How many tools (cards) the category holds. */
  count: number;
}

export function TaskCategoryTiles({ categories, active, onSelect, isTV }: {
  categories: readonly TaskCategory[];
  active: string;
  onSelect: (key: string) => void;
  isTV: boolean;
}) {
  return (
    <nav className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-label="Task categories">
      {categories.map((c) => {
        const on = active === c.key;
        const Icon = c.icon;
        const tile = (
          <button
            type="button"
            aria-pressed={on}
            onClick={(e) => { onSelect(c.key); e.currentTarget.blur(); }}
            className={`w-full h-full flex flex-col items-start gap-1 rounded-2xl p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? '' : '[@media(hover:hover)]:hover:bg-surface-hover'}`}
            style={on
              ? { background: 'var(--color-primary-muted)', border: '1px solid var(--color-primary)' }
              : { background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <Icon className={`w-5 h-5 shrink-0 ${on ? 'text-primary' : 'text-muted'}`} />
              <span className="text-[11px] text-muted">{c.count} {c.count === 1 ? 'tool' : 'tools'}</span>
            </span>
            <span className={`text-sm font-semibold ${on ? 'text-primary' : 'text-default'}`}>{c.label}</span>
            <span className="text-xs leading-snug text-muted">{c.description}</span>
          </button>
        );
        return isTV
          ? <TVFocusable key={c.key} onEnterPress={() => onSelect(c.key)} className="h-full">{tile}</TVFocusable>
          : <div key={c.key} className="h-full">{tile}</div>;
      })}
    </nav>
  );
}
