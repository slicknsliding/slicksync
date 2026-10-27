'use client';

// Themes → Layout → Page design: Classic, or v2 (people grouped by their
// group, one status in plain words, one obvious button). Works with either
// layout; saved to the account.

import { CheckIcon } from '@heroicons/react/24/outline';
import { usePageDesign } from '@/lib/arrange';
import type { PageDesign } from '@/lib/arrange-core';

const CHOICES: { id: PageDesign; name: string; blurb: string }[] = [
  { id: 'classic', name: 'Classic', blurb: 'The pages as they have always been.' },
  { id: 'v2', name: 'v2', blurb: 'Grouped cards: one status in plain words and one obvious button. Users, Groups, Addons, Invitations, Catalogs and Vault.' },
];

export function PageDesignChoice() {
  const { design, setDesign } = usePageDesign();
  return (
    <>
      <div className="mt-5 mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-sm font-semibold text-default">Page design</h4>
        <p className="text-xs text-muted">How the pages lay out their people, groups and addons, in either layout</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Page design">
        {CHOICES.map((c) => {
          const on = design === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setDesign(c.id)}
              className="text-left rounded-xl p-4 transition-colors"
              style={{
                border: `1px solid ${on ? 'var(--color-primary)' : 'var(--color-surface-border)'}`,
                background: on ? 'var(--color-primary-muted)' : 'var(--color-surface)',
              }}
            >
              <span className="flex items-center gap-2">
                <b className="text-sm text-default flex-1">{c.name}</b>
                {on && <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />}
              </span>
              <span className="block text-xs text-muted mt-1">{c.blurb}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
