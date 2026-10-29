'use client';

// The Guides index in the v2 page design: a big search first, then "Start
// here", then every category as a section of guide tiles (title and one line).
// Categories fold, so all the guides are one tap away without a wall of text.
// Searching swaps the sections for one ranked list. Sections move, fold and
// hide through Arrange.

import Link from 'next/link';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { HelpEntry } from '@/lib/helpContent';
import { V2Box, V2Tiles } from './V2Detail';

export const GUIDES_START_KEY = 's:start';
export const guideCategoryKey = (category: string) => `c:${category}`;

// Real guides that answer what people ask first. Any id that goes missing is
// simply left out.
export const GUIDES_START_IDS = ['onboarding-wizard', 'groups', 'arrange-pages', 'history-not-updating'];

/** One guide: its title and a line on what it covers. */
export function GuideTile({ entry, showCategory = false }: { entry: HelpEntry; showCategory?: boolean }) {
  return (
    <Link
      href={`/guides/${entry.id}`}
      className="v2-box v2-box-pad block hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ borderRadius: 16, outlineColor: 'var(--color-primary)' }}
    >
      <b className="block text-[14.5px] text-default">{entry.title}</b>
      {showCategory && <span className="v2-chip mt-1.5">{entry.category}</span>}
      <span className="block text-muted text-[12.5px] mt-1 line-clamp-2">{entry.answer}</span>
    </Link>
  );
}

export function GuidesV2({ query, onQuery, results, grouped, byId, arrange }: {
  query: string;
  onQuery: (q: string) => void;
  /** Ranked search results, or null when nothing has been asked. */
  results: HelpEntry[] | null;
  grouped: { category: string; entries: HelpEntry[] }[];
  byId: (id: string) => HelpEntry | undefined;
  arrange: PageArrange;
}) {
  const start = GUIDES_START_IDS.map(byId).filter((e): e is HelpEntry => Boolean(e));
  return (
    <div>
      <div className="v2-box flex items-center gap-3 px-4 py-3.5" style={{ borderRadius: 16 }}>
        <MagnifyingGlassIcon className="w-[18px] h-[18px] shrink-0 text-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search help, like “history missing”"
          aria-label="Search guides"
          className="flex-1 bg-transparent outline-none text-[15px] min-w-0 text-default"
        />
        {query && (
          <button type="button" onClick={() => onQuery('')} className="text-xs shrink-0 hover:opacity-80 text-muted">
            Clear
          </button>
        )}
      </div>
      {/* A keyboard shortcut means nothing on a touch screen. */}
      <p className="text-muted text-xs mt-2 mb-1 [@media(pointer:coarse)]:hidden">
        Tip: press <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px]" style={{ background: 'var(--color-subtle)' }}>Ctrl</kbd>
        {' + '}
        <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px]" style={{ background: 'var(--color-subtle)' }}>K</kbd>
        {' '}anywhere to search this from any page.
      </p>

      {results !== null ? (
        <section className="arrange-section" aria-label="Search results">
          <h2 className="text-lg font-semibold">
            {results.length > 0 ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No results'}
          </h2>
          <div className="mt-3">
            {results.length === 0 ? (
              <V2Box>
                <p className="text-sm text-muted">
                  Nothing matched “{query}”. Try a shorter or more general term - or clear the search to browse everything by category.
                </p>
              </V2Box>
            ) : (
              <V2Tiles wide={3}>
                {results.map((entry) => <GuideTile key={entry.id} entry={entry} showCategory />)}
              </V2Tiles>
            )}
          </div>
        </section>
      ) : (
        arrange.shown.map((key) => {
          if (key === GUIDES_START_KEY) {
            if (start.length === 0) return null;
            return (
              <ArrangeSection key={key} arrange={arrange} id={key} title="Start here" label="Start here" meta={`${start.length}`}>
                <V2Tiles wide={4}>{start.map((entry) => <GuideTile key={entry.id} entry={entry} />)}</V2Tiles>
              </ArrangeSection>
            );
          }
          const group = grouped.find((g) => guideCategoryKey(g.category) === key);
          if (!group) return null;
          return (
            <ArrangeSection
              key={key}
              arrange={arrange}
              id={key}
              title={group.category}
              meta={`${group.entries.length} guide${group.entries.length === 1 ? '' : 's'}`}
            >
              <V2Tiles wide={3}>{group.entries.map((entry) => <GuideTile key={entry.id} entry={entry} />)}</V2Tiles>
            </ArrangeSection>
          );
        })
      )}
    </div>
  );
}
