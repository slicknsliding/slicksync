'use client';

// Themes → Layout: the small personal settings - how tight the pages are,
// which page SlickSync opens on, and whether pages keep their filter. All
// saved to the account; each has a plain default.

import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useDensity, useKeepFilters, useStartPage } from '@/lib/arrange';
import { ADMIN_MENU } from '@/lib/adminMenu';

const START_PAGES = [...ADMIN_MENU.map((i) => ({ href: i.href, label: i.label })), { href: '/tasks', label: 'Tasks' }];

export function PersonalTouches() {
  const { density, setDensity } = useDensity();
  const { startPage, setStartPage } = useStartPage();
  const { keep, setKeep } = useKeepFilters();
  return (
    <div className="mt-5 rounded-xl p-4 space-y-4" style={{ border: '1px solid var(--color-surface-border)' }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Density</p>
          <p className="text-xs text-muted">Compact fits more cards and rows on screen</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Density">
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={density === d} className={density === d ? 'on' : ''} onClick={() => setDensity(d)}>
              {d === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Start page</p>
          <p className="text-xs text-muted">Where SlickSync opens when you come back</p>
        </div>
        <select
          value={startPage}
          onChange={(e) => setStartPage(e.target.value)}
          className="input-base px-3 py-2 text-sm rounded-lg"
          style={{ width: '11rem', background: 'var(--color-surface-hover)', color: 'var(--color-text)', border: '1px solid var(--color-surface-border)' }}
          aria-label="Start page"
        >
          {START_PAGES.map((p) => <option key={p.href} value={p.href}>{p.label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-default">Keep each page&apos;s filter</p>
          <p className="text-xs text-muted">Users, Addons and the Vault open on the filter you last picked</p>
        </div>
        <ToggleSwitch checked={keep} onChange={() => setKeep(!keep)} />
      </div>
    </div>
  );
}
