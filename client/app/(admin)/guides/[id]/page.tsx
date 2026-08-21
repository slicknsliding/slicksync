'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Modal } from '@/components/ui';
import { AutomationPanel } from '@/components/automation/AutomationPanel';
import { BoltIcon } from '@heroicons/react/24/outline';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LightBulbIcon,
  ChevronRightIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { getHelpEntry, HelpEntry } from '@/lib/helpContent';

// A full page per help topic, rather than the cramped inline blurb the
// command palette used to be limited to. That's the whole point: the palette
// stays fast and answers-at-a-glance, and anything that needs real
// step-by-step instructions, caveats, or "here's why it behaves like this"
// gets room to actually say it.
export default function GuideTopicPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : '';
  const { layoutMode } = useLayoutMode();
  const router = useRouter();
  const [embedOpen, setEmbedOpen] = useState(false);

  const entry = getHelpEntry(id);

  const related = (entry?.related || [])
    .map((rid) => getHelpEntry(rid))
    .filter((e): e is HelpEntry => Boolean(e));

  // The footer "Browse all guides" link only earns its place on a page long
  // enough that the back link at the top has scrolled away. On a short
  // summary-only topic the two sit within a few hundred pixels of each
  // other and just read as two back buttons.
  const hasLongContent = Boolean(
    (entry?.steps && entry.steps.length > 0) ||
    (entry?.details && entry.details.length > 0) ||
    (entry?.tips && entry.tips.length > 0) ||
    related.length > 0
  );

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={
            <Breadcrumbs
              items={[{ label: 'Guides', href: '/guides' }, { label: entry ? entry.title : 'Not found' }]}
              className="text-xl font-semibold"
            />
          }
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(64rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && entry && (
            <NebulaPageHeading title={entry.title} subtitle={entry.category} />
          )}

          <PageSection delay={0.05} className="mb-4">
            <button
              onClick={() => router.push('/guides')}
              className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-80"
              style={{ color: 'var(--color-secondary)' }}
            >
              <ArrowLeftIcon className="w-4 h-4" />
              All guides
            </button>
          </PageSection>

          {!entry ? (
            <PageSection delay={0.1}>
              <Card padding="lg">
                <h2 className="text-lg font-semibold font-display text-default mb-2">Topic not found</h2>
                <p className="text-sm mb-5" style={{ color: 'var(--color-text-muted)' }}>
                  There&apos;s no help topic with the id &quot;{id}&quot;. It may have been renamed or removed.
                </p>
                <Button variant="primary" size="sm" onClick={() => router.push('/guides')}>
                  Browse all topics
                </Button>
              </Card>
            </PageSection>
          ) : (
            <>
              {/* Summary - the same text the command palette shows inline */}
              <PageSection delay={0.1} className="mb-5">
                <Card padding="lg">
                  {layoutMode !== 'nebula' && (
                    <>
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-primary)' }}>
                        {entry.category}
                      </p>
                      <h1 className="text-xl font-bold font-display text-default mb-3">{entry.title}</h1>
                    </>
                  )}
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>
                    {entry.answer}
                  </p>
                  {/* Prefer opening the feature right here over navigating
                      away - the steps stay on screen while you follow them,
                      instead of the instructions ending up on the page you
                      just left. Only guides whose feature is a genuinely
                      self-contained component can do this; the rest still
                      deep-link. */}
                  {entry.embed ? (
                    <div className="mt-5">
                      <Button
                        variant="primary"
                        size="sm"
                        leftIcon={<BoltIcon className="w-4 h-4" />}
                        onClick={() => setEmbedOpen(true)}
                      >
                        Open Automation here
                      </Button>
                      <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                        Opens on this page, so the steps below stay visible.
                      </p>
                    </div>
                  ) : entry.href ? (
                    <div className="mt-5">
                      <Button
                        variant="primary"
                        size="sm"
                        rightIcon={<ArrowTopRightOnSquareIcon className="w-4 h-4" />}
                        onClick={() => router.push(entry.href!)}
                      >
                        {entry.linkLabel || 'Go there'}
                      </Button>
                    </div>
                  ) : null}
                </Card>
              </PageSection>

              {/* Steps */}
              {entry.steps && entry.steps.length > 0 && (
                <PageSection delay={0.14} className="mb-5">
                  <Card padding="lg">
                    <h2 className="text-base font-semibold font-display text-default mb-4">Step by step</h2>
                    <ol className="flex flex-col gap-3">
                      {entry.steps.map((step, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <span
                            className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-px"
                            style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}
                          >
                            {i + 1}
                          </span>
                          <span className="text-sm leading-relaxed flex-1" style={{ color: 'var(--color-text)' }}>
                            {step}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </Card>
                </PageSection>
              )}

              {/* Details */}
              {entry.details && entry.details.length > 0 && (
                <PageSection delay={0.18} className="mb-5">
                  <Card padding="lg">
                    <h2 className="text-base font-semibold font-display text-default mb-4">How it works</h2>
                    <div className="flex flex-col gap-3">
                      {entry.details.map((d, i) => (
                        <p key={i} className="text-sm leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                          {d}
                        </p>
                      ))}
                    </div>
                  </Card>
                </PageSection>
              )}

              {/* Tips / gotchas */}
              {entry.tips && entry.tips.length > 0 && (
                <PageSection delay={0.22} className="mb-5">
                  <Card padding="lg">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-warning-muted shrink-0">
                        <LightBulbIcon className="w-5 h-5 text-warning" />
                      </div>
                      <h2 className="text-base font-semibold font-display text-default">Worth knowing</h2>
                    </div>
                    <ul className="flex flex-col gap-3">
                      {entry.tips.map((tip, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0 mt-[7px]"
                            style={{ background: 'var(--color-warning)' }}
                          />
                          <span className="text-sm leading-relaxed flex-1" style={{ color: 'var(--color-text)' }}>
                            {tip}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </PageSection>
              )}

              {/* Related */}
              {related.length > 0 && (
                <PageSection delay={0.26}>
                  <Card padding="lg">
                    <h2 className="text-base font-semibold font-display text-default mb-4">Related</h2>
                    <div className="flex flex-col gap-1">
                      {related.map((r) => (
                        <Link
                          key={r.id}
                          href={`/guides/${r.id}`}
                          className="group flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-surface-hover"
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-medium text-default">{r.title}</span>
                            <span className="block text-xs mt-1 line-clamp-2" style={{ color: 'var(--color-text-muted)' }}>
                              {r.answer}
                            </span>
                          </span>
                          <ChevronRightIcon
                            className="w-4 h-4 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            style={{ color: 'var(--color-text-muted)' }}
                          />
                        </Link>
                      ))}
                    </div>
                  </Card>
                </PageSection>
              )}

              {hasLongContent && (
                <PageSection delay={0.3} className="mt-5">
                  <Link
                    href="/guides"
                    className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-80"
                    style={{ color: 'var(--color-secondary)' }}
                  >
                    Browse all guides
                    <ArrowRightIcon className="w-4 h-4" />
                  </Link>
                </PageSection>
              )}
            </>
          )}
        </div>
      </div>

      {/* The real Automation panel, rendered on the guide page itself. It's
          the same self-contained component the Tasks page mounts, so rules
          created here are the real thing, not a preview. */}
      {entry?.embed === 'automation' && (
        <Modal
          isOpen={embedOpen}
          onClose={() => setEmbedOpen(false)}
          title="Automation"
          size="xl"
        >
          <AutomationPanel />
        </Modal>
      )}
    </>
  );
}
