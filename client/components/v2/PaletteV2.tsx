'use client';

// The v2 look of the command palette (CommandPalette draws this when Page
// design is v2): results come back grouped (People with a status word, Pages,
// Settings, Addons, Catalogs, Titles, then Guides), the keys sit in the foot,
// and before you type there are your recent places, every page as a tile and a
// hint that questions open the right guide. What it searches, what it opens
// and how the arrow keys walk the list are the palette's own.

import type { ComponentType, CSSProperties, KeyboardEvent, RefObject } from 'react';
import { ArrowUpRightIcon, BookOpenIcon, MagnifyingGlassIcon, QuestionMarkCircleIcon, SparklesIcon } from '@heroicons/react/24/outline';
import type { HelpEntry } from '@/lib/helpContent';
import { V2Status, type V2Tone } from './V2Bits';

export type PaletteResult = {
  id: string;
  label: string;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  poster?: string | null;
  /** A person's state in a word. */
  person?: { tone: V2Tone; words: string };
  /** Shown under Recent (before you type). */
  recent?: boolean;
};

export type PaletteHelp = HelpEntry;

const GROUPS: { prefix: string; title: string }[] = [
  { prefix: 'user-', title: 'People' },
  { prefix: 'nav-', title: 'Pages' },
  { prefix: 'setting-', title: 'Settings' },
  { prefix: 'addon-', title: 'Addons' },
  { prefix: 'list-', title: 'Catalogs' },
  { prefix: 'title-', title: 'Titles' },
];

function groupOf(id: string) {
  return GROUPS.find((g) => id.startsWith(g.prefix))?.title || 'Results';
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex items-center justify-center text-[11.5px] font-semibold rounded-md"
      style={{ minWidth: 22, height: 22, padding: '0 6px', border: '1px solid var(--color-surface-border)', background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
    >
      {children}
    </kbd>
  );
}

const LABEL = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted px-3 pt-2.5 pb-1';

function Row({ r, active, onPick, onHover }: { r: PaletteResult; active: boolean; onPick: () => void; onHover: () => void }) {
  const Icon = r.icon;
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={onHover}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-left transition-colors ${active ? 'row-hl' : ''}`}
    >
      {r.poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.poster} alt="" className="w-5 h-7 rounded-sm object-cover shrink-0" loading="lazy" decoding="async" />
      ) : (
        <Icon className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      )}
      <span className="text-sm flex-1 min-w-0 flex items-center gap-2.5">
        <span className="truncate">{r.label}</span>
        {r.person && <V2Status tone={r.person.tone}>{r.person.words}</V2Status>}
      </span>
      {r.sublabel && <span className="text-xs text-muted shrink-0">{r.sublabel}</span>}
      {active && <Kbd>↵</Kbd>}
    </button>
  );
}

export function PaletteV2Panel({
  query, onQuery, inputRef, onKeyDown, results, helpResults, activeIndex, onActive,
  onPick, onPickHelp, onBrowse, onClose, loading,
}: {
  query: string;
  onQuery: (q: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: KeyboardEvent) => void;
  results: PaletteResult[];
  helpResults: PaletteHelp[];
  activeIndex: number;
  onActive: (i: number) => void;
  onPick: (r: PaletteResult) => void;
  onPickHelp: (h: PaletteHelp) => void;
  onBrowse: () => void;
  onClose: () => void;
  loading: boolean;
}) {
  const typing = query.trim().length > 0;
  const none = typing && results.length === 0 && helpResults.length === 0;

  // Consecutive results of one kind share a heading.
  const sections: { title: string; items: { r: PaletteResult; i: number }[] }[] = [];
  if (typing) {
    results.forEach((r, i) => {
      const title = groupOf(r.id);
      const last = sections[sections.length - 1];
      if (last && last.title === title) last.items.push({ r, i });
      else sections.push({ title, items: [{ r, i }] });
    });
  }
  const recent = results.map((r, i) => ({ r, i })).filter((x) => x.r.recent);
  const pages = results.map((r, i) => ({ r, i })).filter((x) => !x.r.recent);

  return (
    <div className="popup-panel overflow-hidden" style={{ borderRadius: 22 }}>
      <div className="px-3.5 pt-3.5 pb-1.5">
        <div className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>
          <MagnifyingGlassIcon className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, people, addons…"
            aria-label="Search"
            className="flex-1 min-w-0 bg-transparent outline-none text-[15px]"
            style={{ color: 'var(--color-text)' }}
          />
          <span className="hidden sm:inline-flex"><Kbd>Esc</Kbd></span>
        </div>
      </div>

      <div className="max-h-[26rem] overflow-y-auto px-2 pb-2.5">
        {none && (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-muted mb-3">No matches for “{query}”</p>
            <button type="button" onClick={onBrowse} className="text-xs font-medium hover:opacity-80" style={{ color: 'var(--color-secondary)' }}>
              Browse all guides →
            </button>
          </div>
        )}

        {typing && sections.map((s) => (
          <div key={s.title}>
            <p className={LABEL}>{s.title}</p>
            {s.items.map(({ r, i }) => (
              <Row key={r.id} r={r} active={i === activeIndex} onPick={() => onPick(r)} onHover={() => onActive(i)} />
            ))}
          </div>
        ))}

        {typing && helpResults.length > 0 && (
          <div>
            <p className={LABEL}>Guides</p>
            {helpResults.map((h, hi) => {
              const idx = results.length + hi;
              const on = idx === activeIndex;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => onPickHelp(h)}
                  onMouseEnter={() => onActive(idx)}
                  className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-[10px] text-left transition-colors ${on ? 'row-hl' : ''}`}
                >
                  <SparklesIcon className="w-[18px] h-[18px] mt-0.5 shrink-0" style={{ color: 'var(--color-primary)' }} />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{h.title}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold shrink-0" style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}>{h.category}</span>
                    </span>
                    <span className="block text-xs mt-0.5 line-clamp-2 text-muted">{h.answer}</span>
                  </span>
                  {on ? <Kbd>↵</Kbd> : <ArrowUpRightIcon className="w-3.5 h-3.5 mt-1 shrink-0 opacity-0" />}
                </button>
              );
            })}
            <button type="button" onClick={onBrowse} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-left hover:bg-surface-hover">
              <BookOpenIcon className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--color-secondary)' }}>Browse all guides</span>
            </button>
          </div>
        )}

        {!typing && (
          <>
            {recent.length > 0 && (
              <div>
                <p className={LABEL}>Recent</p>
                {recent.map(({ r, i }) => (
                  <Row key={r.id} r={r} active={i === activeIndex} onPick={() => onPick(r)} onHover={() => onActive(i)} />
                ))}
              </div>
            )}
            <div>
              <p className={LABEL}>Pages</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 px-1 pt-0.5">
                {pages.map(({ r, i }) => {
                  const Icon = r.icon;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onPick(r)}
                      onMouseEnter={() => onActive(i)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${i === activeIndex ? 'row-hl' : ''}`}
                      style={{ background: i === activeIndex ? undefined : 'var(--color-surface-hover)' }}
                    >
                      <Icon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                      <span className="truncate">{r.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2.5 mx-1 mt-3 px-3 py-2.5 rounded-xl text-[13.5px]" style={{ border: '1px dashed var(--color-surface-border)' }}>
              <QuestionMarkCircleIcon className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--color-primary)' }} />
              <span className="text-muted">Type a question, like <b style={{ color: 'var(--color-text)' }}>how do I limit watch time</b>, to open the guide</span>
            </div>
            {loading && <div className="px-3 pt-3 text-xs text-muted">Loading people, addons, catalogs…</div>}
          </>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-4 text-xs text-muted px-4 py-2.5" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
        <span className="inline-flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
        <button type="button" className="inline-flex items-center gap-1.5" onClick={onClose}><Kbd>Esc</Kbd> close</button>
      </div>
    </div>
  );
}
