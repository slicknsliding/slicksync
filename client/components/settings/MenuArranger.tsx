'use client';

// Themes → Layout → Arrange the menu: the order of the admin pages, which ones
// sit in More, and how the bar is laid out. The bar above updates as you go,
// and the choice is saved to the account (lib/arrange.tsx).

import { ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { useMenuArrangement } from '@/lib/arrange';
import { ADMIN_MENU, arrangeMenu, menuIsArranged } from '@/lib/adminMenu';
import { orderKeys, type MenuArrangement } from '@/lib/arrange-core';

function Segment<T extends string | number>({ label, value, options, onChange, disabled, note }: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3">
      <span className="text-sm text-default w-28 shrink-0">{label}</span>
      <div className="menu-seg" role="radiogroup" aria-label={label} aria-disabled={disabled}>
        {options.map((o) => (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            disabled={disabled}
            className={value === o.id ? 'on' : ''}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {note && <span className="text-xs text-muted">{note}</span>}
    </div>
  );
}

export function MenuArranger({ topNavi }: { topNavi: boolean }) {
  const { menu, setMenu } = useMenuArrangement();
  const keys = ADMIN_MENU.map((i) => i.href);
  const ordered = orderKeys(keys, menu.order);
  const hidden = new Set(menu.hidden || []);
  const byHref = new Map(ADMIN_MENU.map((i) => [i.href, i]));
  const { shown } = arrangeMenu(menu);
  const rows = menu.rows ?? 2;

  const set = (patch: Partial<MenuArrangement>) => setMenu((m) => ({ ...m, ...patch }));
  const move = (href: string, dir: -1 | 1) => {
    const i = ordered.indexOf(href);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    const next = ordered.slice();
    [next[i], next[j]] = [next[j], next[i]];
    set({ order: next });
  };
  const toggleHidden = (href: string) => {
    const next = new Set(hidden);
    if (next.has(href)) next.delete(href);
    else next.add(href);
    set({ hidden: [...next] });
  };
  const isDefault = !menuIsArranged(menu) && menu.rows === undefined && menu.logo === undefined && menu.align === undefined;

  return (
    <div className="mt-5 rounded-xl p-4" style={{ border: '1px solid var(--color-surface-border)' }}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-default">Arrange the menu</h4>
          <p className="text-xs text-muted mt-0.5">
            Move pages into your order. Hidden pages go into a More menu, so nothing is ever lost. The bar changes as you go, and the Original sidebar follows the same order.
          </p>
        </div>
        <button type="button" className="arrange-pill" disabled={isDefault} onClick={() => setMenu(() => ({}))}>Reset</button>
      </div>

      <ol className="mt-3 rounded-xl overflow-hidden" style={{ border: '1px solid var(--color-surface-border)' }}>
        {ordered.map((href, i) => {
          const item = byHref.get(href)!;
          const Icon = item.icon;
          const off = hidden.has(href);
          return (
            <li
              key={href}
              className="flex items-center gap-3 px-3 py-2"
              style={{ borderTop: i === 0 ? undefined : '1px solid var(--color-surface-border)', opacity: off ? 0.6 : 1 }}
            >
              <Icon className="w-[18px] h-[18px] text-muted shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-default truncate">{item.label}</span>
              <span className="menu-where">{off ? 'In More' : 'In the bar'}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                <button type="button" className="arrange-icon" aria-label={`Move ${item.label} up`} title="Move up" disabled={i === 0} onClick={() => move(href, -1)}>
                  <ChevronUpIcon className="w-4 h-4" />
                </button>
                <button type="button" className="arrange-icon" aria-label={`Move ${item.label} down`} title="Move down" disabled={i === ordered.length - 1} onClick={() => move(href, 1)}>
                  <ChevronDownIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="arrange-icon"
                  aria-label={off ? `Put ${item.label} back in the bar` : `Move ${item.label} into More`}
                  title={off ? 'Back in the bar' : 'Into More'}
                  aria-pressed={off}
                  // Keep at least one page in the bar.
                  disabled={!off && shown.length <= 1}
                  onClick={() => toggleHidden(href)}
                >
                  {off ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      {topNavi && (<>
      <Segment label="Rows" value={rows} onChange={(v) => set({ rows: v === 2 ? undefined : 1 })}
        options={[{ id: 1, label: 'One' }, { id: 2, label: 'Two' }]} />
      <Segment label="Logo" value={menu.logo ?? 'large'} onChange={(v) => set({ logo: v === 'large' ? undefined : v })}
        options={[{ id: 'large', label: 'Large' }, { id: 'small', label: 'Small' }, { id: 'hidden', label: 'Hidden' }]} />
      <Segment label="Position" value={menu.align ?? 'center'} onChange={(v) => set({ align: v === 'center' ? undefined : v })}
        options={[{ id: 'center', label: 'Centred' }, { id: 'left', label: 'Left' }]}
        disabled={rows !== 1} note={rows !== 1 ? 'With one row' : 'Logo on the left, pages beside it'} />
      </>)}
      <p className="text-xs text-muted mt-3">{topNavi ? '' : 'Rows, logo and position are for Top Navi. '}On a phone the menu keeps its stacked shape; your order and More still apply. A TV always uses the standard menu.</p>
    </div>
  );
}
