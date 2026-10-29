'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { usePageArrangement, usePageDesign } from '@/lib/arrange';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { ArrangeBar, ArrangeButton, ArrangePanel, HiddenTray } from '@/components/ui/Arrange';
import { GuidesV2, GUIDES_START_KEY, guideCategoryKey } from '@/components/v2/GuidesV2';
import {
  MagnifyingGlassIcon,
  ChevronRightIcon,
  SparklesIcon,
  LifebuoyIcon,
} from '@heroicons/react/24/outline';
import { HELP_ENTRIES, searchHelp, helpEntriesByCategory, getHelpEntry, HelpEntry } from '@/lib/helpContent';

// The Guides index - the "browse everything" counterpart to the command
// palette's search-as-you-type. The palette answers a question you already
// know how to ask; this page is for when you don't know what to search for
// yet, which is exactly when a flat search box is useless and a categorised
// list isn't.
export default function GuidesPage() {
  const { layoutMode } = useLayoutMode();
  const [query, setQuery] = useState('');

  // With a query we show a flat ranked list (relevance beats category
  // grouping when you've actually asked for something specific); without
  // one, the full categorised browse.
  const results: HelpEntry[] | null = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return searchHelp(q, 30);
  }, [query]);

  const grouped = useMemo(() => helpEntriesByCategory(), []);

  // v2: Start here, then every category as a section that folds, moves and
  // hides. The first three categories start open, the rest folded.
  const { design } = usePageDesign();
  const isTV = useIsTV();
  const v2 = design === 'v2' && !isTV;
  const sectionKeys = useMemo(() => [GUIDES_START_KEY, ...grouped.map((g) => guideCategoryKey(g.category))], [grouped]);
  const defaultFolded = useMemo(() => grouped.slice(3).map((g) => guideCategoryKey(g.category)), [grouped]);
  const arrange = usePageArrangement('guides', sectionKeys, { defaultFolded });
  // Classic has no Start here block, so it keeps its own arrangement of the same categories.
  const classicKeys = useMemo(() => grouped.map((g) => guideCategoryKey(g.category)), [grouped]);
  const classicArrange = usePageArrangement('guides-classic', classicKeys);
  const pageArrange = v2 ? arrange : classicArrange;
  const canArrange = !isTV;
  const subtitle = `${HELP_ENTRIES.length} guides covering every page, setting, and the things that most often go wrong.`;

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Guides' }]} className="text-xl font-semibold" />}
          actions={canArrange ? <ArrangeButton arrange={pageArrange} /> : undefined}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && (
            <NebulaPageHeading
              title="Guides"
              subtitle={subtitle}
              actions={canArrange ? <ArrangeButton arrange={pageArrange} /> : undefined}
            />
          )}

          {v2 && (
            <>
              <ArrangeBar arrange={arrange} />
              <GuidesV2
                query={query}
                onQuery={setQuery}
                results={results}
                grouped={grouped}
                byId={getHelpEntry}
                arrange={arrange}
              />
              {results === null && (
                <HiddenTray
                  arrange={arrange}
                  labelOf={(key) => {
                    const cat = grouped.find((g) => guideCategoryKey(g.category) === key)?.category;
                    return `${key === GUIDES_START_KEY ? 'Start here' : cat ?? 'Section'} (section)`;
                  }}
                  note="Hidden only here: the guides are still there, and search still finds them. Tap one to bring it back."
                />
              )}
            </>
          )}

          {/* Search */}
          {!v2 && (<>
          <PageSection delay={0.05} className="mb-6">
            <Card padding="lg">
              <div className="flex items-center gap-3">
                <MagnifyingGlassIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help - try &quot;history missing&quot;, &quot;2fa&quot;, or &quot;auto remove&quot;"
                  className="flex-1 bg-transparent outline-none text-sm min-w-0"
                  style={{ color: 'var(--color-text)' }}
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="text-xs shrink-0 hover:opacity-80"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs mt-3" style={{ color: 'var(--color-text-muted)' }}>
                Tip: press <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px]" style={{ background: 'var(--color-subtle)' }}>Ctrl</kbd>
                {' + '}
                <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px]" style={{ background: 'var(--color-subtle)' }}>K</kbd>
                {' '}anywhere to search this from any page.
              </p>
            </Card>
          </PageSection>

          {/* Search results */}
          {results !== null && (
            <PageSection delay={0.1}>
              <Card padding="lg">
                <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--color-text-muted)' }}>
                  {results.length > 0
                    ? `${results.length} result${results.length === 1 ? '' : 's'}`
                    : 'No results'}
                </p>
                {results.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    Nothing matched &quot;{query}&quot;. Try a shorter or more general term - or clear the search to browse everything by category.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {results.map((entry) => (
                      <HelpRow key={entry.id} entry={entry} showCategory />
                    ))}
                  </div>
                )}
              </Card>
            </PageSection>
          )}

          {/* Categorised browse.
              CSS multi-column rather than a grid: category cards have wildly
              different heights (10 guides vs. 2), and in a 2-col grid every
              row is as tall as its tallest card, which left large dead gaps
              under the short ones. Columns let the cards flow and pack
              tightly instead. break-inside-avoid keeps a card from being
              split across the column boundary. */}
          </>)}
          {!v2 && results === null && (<>
            {!isTV && <ArrangeBar arrange={classicArrange} />}
            <div className="columns-1 lg:columns-2 gap-4">
              {(isTV ? grouped.map((g) => guideCategoryKey(g.category)) : classicArrange.shown).map((key) => {
                const group = grouped.find((g) => guideCategoryKey(g.category) === key);
                if (!group) return null;
                return (
                <div key={group.category} className="break-inside-avoid mb-4">
                  <ArrangePanel arrange={classicArrange} id={key} label={group.category} ownHeading={false}>
                  <Card padding="lg">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted shrink-0">
                        {group.category === 'Troubleshooting' ? (
                          <LifebuoyIcon className="w-5 h-5 text-primary" />
                        ) : (
                          <SparklesIcon className="w-5 h-5 text-primary" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold font-display text-default truncate">{group.category}</h3>
                        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {group.entries.length} guide{group.entries.length === 1 ? '' : 's'}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      {group.entries.map((entry) => (
                        <HelpRow key={entry.id} entry={entry} />
                      ))}
                    </div>
                  </Card>
                  </ArrangePanel>
                </div>
                );
              })}
            </div>
            {!isTV && (
              <HiddenTray
                arrange={classicArrange}
                labelOf={(key) => `${grouped.find((g) => guideCategoryKey(g.category) === key)?.category ?? 'Section'} (section)`}
                note="Hidden only here: the guides are still there, and search still finds them. Tap one to bring it back."
              />
            )}
          </>)}
        </div>
      </div>
    </>
  );
}

function HelpRow({ entry, showCategory = false }: { entry: HelpEntry; showCategory?: boolean }) {
  return (
    <Link
      href={`/guides/${entry.id}`}
      className="group flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-surface-hover"
    >
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-default">{entry.title}</span>
          {showCategory && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold shrink-0"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}
            >
              {entry.category}
            </span>
          )}
        </span>
        <span className="block text-xs mt-1 line-clamp-2" style={{ color: 'var(--color-text-muted)' }}>
          {entry.answer}
        </span>
      </span>
      <ChevronRightIcon
        className="w-4 h-4 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}
