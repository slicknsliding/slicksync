'use client';

// Settings navigation: the left rail with grouped sections (PC, Nebula), the
// chip row (PC, Original layout), the section dropdown that opens as a tile
// grid (phone / PWA), and the "Find a setting" search that sits above all of
// them. TV gets the rail only - no keyboard, so no search.
//
// The search is built from the page itself, not a hand list: every settings
// section stays mounted (hidden when it is not the open one) inside an element
// marked data-settings-pane, so collectSettingsEntries() reads each row's
// title and description (SettingRow's data-setting) and each card's heading
// straight from the DOM, then adds the keywords from lib/settingsIndex.ts by
// label. A setting added with SettingRow is found without touching any list.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, ChevronRightIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { ScrollRow } from '@/components/ui/ScrollRow';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';
import type { SettingsIndexEntry } from '@/lib/settingsIndex';

export interface SettingsTabDef {
  key: string;
  label: string;
  icon: React.ComponentType<React.ComponentProps<'svg'>>;
  blurb: string;
  /** Which labelled group of the rail the section sits in. */
  group: 'experience' | 'setup';
}

export const SETTINGS_GROUPS: { key: SettingsTabDef['group']; label: string }[] = [
  { key: 'experience', label: 'Your experience' },
  { key: 'setup', label: 'Your setup' },
];

export interface SettingsSearchEntry {
  /** Visible label - also the anchor the page scrolls to and flashes. */
  label: string;
  description: string;
  keywords: string;
  tab: string;
}

const clean = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();

/**
 * Every setting on the page, read from the mounted sections, plus any entry in
 * the shared index that is not on the page (a section that is not mounted).
 */
export function collectSettingsEntries(
  root: ParentNode | null,
  tabs: readonly SettingsTabDef[],
  index: SettingsIndexEntry[],
  tabForSection: (section: string) => string | undefined,
): SettingsSearchEntry[] {
  const byLabel = new Map<string, SettingsSearchEntry>();
  const keywordsFor = new Map(index.map((e) => [e.label.toLowerCase(), e]));
  const tabLabel = (key: string) => tabs.find((t) => t.key === key)?.label || '';
  const add = (label: string, description: string, tab: string) => {
    const id = label.toLowerCase();
    if (!label || byLabel.has(id)) return;
    const known = keywordsFor.get(id);
    byLabel.set(id, { label, description, tab, keywords: `${known?.keywords || ''} ${known?.section || ''} ${tabLabel(tab)}` });
  };
  // Every label-ish text on the mounted sections: an index entry whose control
  // is not drawn right now (a key pool before a key exists, the account id on
  // a private instance) is left out, so a result always lands on something.
  const present: string[] = [];
  if (root) {
    for (const pane of Array.from(root.querySelectorAll<HTMLElement>('[data-settings-pane]'))) {
      const tab = pane.dataset.settingsPane || '';
      for (const row of Array.from(pane.querySelectorAll<HTMLElement>('[data-setting]'))) {
        const ps = row.querySelectorAll('p');
        add(row.dataset.setting || '', clean(ps[1]?.textContent), tab);
      }
      for (const el of Array.from(pane.querySelectorAll('label, h3'))) present.push(clean(el.textContent).toLowerCase());
      // Card headings for the blocks that are not rows (a key field, 2FA...).
      for (const h of Array.from(pane.querySelectorAll('h3'))) {
        const sub = h.parentElement?.querySelector('p');
        add(clean(h.textContent), clean(sub?.textContent), tab);
      }
    }
  }
  for (const e of index) {
    const tab = tabForSection(e.section);
    const l = e.label.toLowerCase();
    if (tab && present.some((t) => t === l || t.startsWith(l))) add(e.label, '', tab);
  }
  return Array.from(byLabel.values());
}

export function searchSettings(entries: SettingsSearchEntry[], query: string, limit = 8): SettingsSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { e: SettingsSearchEntry; score: number }[] = [];
  for (const e of entries) {
    const title = e.label.toLowerCase();
    const rest = `${e.keywords} ${e.description}`.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (title.startsWith(w)) score += 4;
      else if (title.includes(` ${w}`)) score += 3;
      else if (title.includes(w)) score += 2;
      else if (e.keywords.toLowerCase().includes(w)) score += 1.5;
      else if (rest.includes(w)) score += 1;
      else { ok = false; break; }
    }
    if (ok) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.label.length - b.e.label.length);
  return scored.slice(0, limit).map((s) => s.e);
}

const surface: React.CSSProperties = { background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' };

function SettingsSearch({ getEntries, onPick, tabs }: {
  getEntries: () => SettingsSearchEntry[];
  onPick: (e: SettingsSearchEntry) => void;
  tabs: readonly SettingsTabDef[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [hit, setHit] = useState(0);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);

  const [results, setResults] = useState<SettingsSearchEntry[]>([]);
  const open = focused && query.trim().length > 0;
  const place = () => {
    const r = box.current?.getBoundingClientRect();
    return r ? placePopup(r, Math.max(r.width, 320), panel.current?.scrollHeight) : null;
  };
  const replace = () => { const at = place(); if (at) setAnchor(at); };
  useFitPopup(panel, open, replace);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      setFocused(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', replace);
      window.removeEventListener('scroll', replace, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // "/" jumps to the box, as long as nothing else is being typed into and this
  // copy of the box is the one on screen (the page keeps one per layout).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (!input.current || input.current.offsetParent === null) return;
      e.preventDefault();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (e: SettingsSearchEntry) => {
    setQuery('');
    setFocused(false);
    input.current?.blur();
    onPick(e);
  };

  return (
    <div ref={box} className="relative">
      <div className="flex items-center gap-2 rounded-xl px-3 h-11 focus-within:ring-2 focus-within:ring-primary" style={surface}>
        <MagnifyingGlassIcon className="w-4 h-4 shrink-0 text-muted" />
        <input
          ref={input}
          type="text"
          value={query}
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            setResults(q.trim() ? searchSettings(getEntries(), q) : []);
            setHit(0);
            replace();
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setFocused(false); input.current?.blur(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHit((h) => Math.min(h + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHit((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && results[hit]) { e.preventDefault(); pick(results[hit]); }
          }}
          placeholder="Find a setting"
          aria-label="Find a setting"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-default placeholder:text-muted"
        />
        <kbd className="hidden md:inline text-[11px] text-muted rounded px-1.5 py-0.5" style={{ border: '1px solid var(--color-surface-border)' }}>/</kbd>
      </div>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <div
          ref={panel}
          role="listbox"
          aria-label="Matching settings"
          className="fixed z-[9999] rounded-2xl popup-panel p-1.5"
          style={popupStyle(anchor)}
        >
          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">No setting matches &ldquo;{query.trim()}&rdquo;.</p>
          ) : results.map((r, i) => (
            <button
              key={r.label}
              type="button"
              role="option"
              aria-selected={i === hit}
              onClick={() => pick(r)}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHit(i); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left ${i === hit ? 'bg-surface-hover' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-default truncate">{r.label}</span>
                <span className="block text-xs text-muted truncate">{tabs.find((t) => t.key === r.tab)?.label}</span>
              </span>
              <ChevronRightIcon className="w-4 h-4 shrink-0 text-muted" />
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Phone / PWA: one button naming the open section; it opens a 2-column tile
// grid right under it. A tile is one tap; outside tap or Escape closes.
function SectionDropdown({ tabs, active, onSelect }: {
  tabs: readonly SettingsTabDef[];
  active: string;
  onSelect: (key: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    return r ? placePopup(r, r.width, panel.current?.scrollHeight) : null;
  };
  const replace = () => { const at = place(); if (at) setAnchor(at); };
  useFitPopup(panel, open, replace);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); button.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', replace);
      window.removeEventListener('scroll', replace, true);
    };
  }, [open]);

  const current = tabs.find((t) => t.key === active) || tabs[0];
  const CurrentIcon = current.icon;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? close() : replace())}
        className="w-full flex items-center gap-2.5 rounded-xl px-3 h-11 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={{ ...surface, boxShadow: '0 10px 24px -10px rgba(0,0,0,0.7)', ...(open ? { borderColor: 'var(--color-primary)' } : {}) }}
      >
        <CurrentIcon className="w-4 h-4 shrink-0 text-muted" />
        <span className="flex-1 min-w-0 text-sm font-semibold text-default truncate">{current.label}</span>
        <ChevronDownIcon className={`w-4 h-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="menu"
            aria-label="Settings sections"
            className="fixed z-[9999] rounded-2xl popup-panel p-2 grid grid-cols-2 gap-2"
            style={popupStyle(anchor)}
          >
            {tabs.map((t) => {
              const Icon = t.icon;
              const on = t.key === active;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="menuitem"
                  aria-current={on ? 'true' : undefined}
                  onClick={() => { onSelect(t.key); close(); }}
                  className="flex flex-col items-start gap-1 rounded-xl p-3 text-left min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  style={on
                    ? { background: 'var(--color-primary-muted)', border: '1px solid var(--color-primary)' }
                    : { background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}
                >
                  <Icon className={`w-4 h-4 ${on ? 'text-primary' : 'text-muted'}`} />
                  <span className={`text-sm font-semibold ${on ? 'text-primary' : 'text-default'}`}>{t.label}</span>
                  <span className="text-[11px] leading-snug text-muted">{t.blurb}</span>
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

export function SettingsNavigation({ tabs, active, onSelect, rail, isTV, getEntries, onPick }: {
  tabs: readonly SettingsTabDef[];
  active: string;
  onSelect: (key: string) => void;
  /** Left rail on PC (Nebula layout); the chip row on PC otherwise. */
  rail: boolean;
  isTV: boolean;
  getEntries: () => SettingsSearchEntry[];
  onPick: (e: SettingsSearchEntry) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const search = !isTV && <SettingsSearch getEntries={getEntries} onPick={onPick} tabs={tabs} />;

  return (
    <>
      {/* Phone / PWA: search, then the section dropdown. */}
      {search && <div className="md:hidden pb-2">{search}</div>}
      {/* No backdrop of its own: a flat strip here showed as a box over the
          page glow. The pill is solid and carries a shadow instead. */}
      <div className="md:hidden sticky top-0 z-20 pt-1 pb-3 -mx-1 px-1">
        <SectionDropdown tabs={tabs} active={active} onSelect={onSelect} />
      </div>

      {rail ? (
        <nav
          className="hidden md:block w-56 shrink-0 sticky top-4"
          // Safety net for the pointer that leaves the rail fast enough to
          // skip a row's own leave event (or leaves the window entirely).
          onPointerLeave={() => setHovered(null)}
        >
          {search && <div className="mb-3">{search}</div>}
          <div className="rounded-2xl p-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
            {SETTINGS_GROUPS.map((g, gi) => (
              <div key={g.key} className={gi > 0 ? 'mt-2' : ''}>
                <p className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.label}</p>
                {tabs.filter((t) => t.group === g.key).map((t) => {
                  const on = active === t.key;
                  const warm = !on && hovered === t.key;
                  const Icon = t.icon;
                  const btn = (
                    <button
                      type="button"
                      // Clearing the hover on click matters as much as setting
                      // it: after a tap the finger is gone but the pointer
                      // never "leaves", so the row just chosen would keep its
                      // hover tint on top of everything.
                      onClick={(e) => { onSelect(t.key); setHovered(null); e.currentTarget.blur(); }}
                      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHovered(t.key); }}
                      onPointerLeave={() => setHovered((k) => (k === t.key ? null : k))}
                      // One of three mutually exclusive classes, never a mix
                      // (see globals.css .rail-item-*): a row that is not the
                      // selected one cannot be painted by a leftover :hover.
                      className={`relative w-full flex items-center gap-3 pl-4 pr-3 py-2.5 rounded-xl text-left mb-0.5 focus:outline-none rail-item ${on ? 'rail-item-on' : warm ? 'rail-item-warm' : 'rail-item-off'}`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${on ? 'rail-ico-on' : 'text-muted'}`} />
                      <span className="min-w-0">
                        <span className={`block text-sm ${on ? 'font-semibold' : 'font-medium'}`}>{t.label}</span>
                        <span className={`block text-[11px] leading-tight ${on ? 'rail-blurb-on' : 'text-muted'}`}>{t.blurb}</span>
                      </span>
                    </button>
                  );
                  return isTV
                    ? <TVFocusable key={t.key} onEnterPress={() => onSelect(t.key)}>{btn}</TVFocusable>
                    : <div key={t.key}>{btn}</div>;
                })}
              </div>
            ))}
          </div>
        </nav>
      ) : (
        <div className="hidden md:block pb-3 space-y-2">
          {search && <div className="max-w-sm">{search}</div>}
          <ScrollRow className="flex gap-1.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onSelect(t.key)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap focus:outline-none ${
                  active === t.key ? 'bg-primary-solid text-white' : 'bg-surface-hover text-muted nav-item-hover-pill'
                }`}
              >
                {t.label}
              </button>
            ))}
          </ScrollRow>
        </div>
      )}
    </>
  );
}
