'use client';

// The page every guide topic opens in, in the v2 page design. The title sits
// in the page heading with the one obvious button (where the guide points to,
// or Open Automation here); under it the one-line answer, then Step by step,
// How it works and Worth knowing as sections. On a wide screen "On this page"
// and the related guides sit in a column on the right; on a phone they follow
// at the end. Sections move, fold and hide through Arrange.

import Link from 'next/link';
import { ArrowLeftIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { HelpEntry } from '@/lib/helpContent';
import { GuideTile } from './GuidesV2';
import { V2Box } from './V2Detail';

export const GUIDE_TOPIC_SECTIONS = [
  { key: 'steps', label: 'Step by step' },
  { key: 'details', label: 'How it works' },
  { key: 'tips', label: 'Worth knowing' },
] as const;

export function GuideTopicV2({ entry, related, arrange, backLabel, onBack }: {
  entry: HelpEntry;
  related: HelpEntry[];
  arrange: PageArrange;
  backLabel: string;
  onBack: () => void;
}) {
  const has: Record<string, boolean> = {
    steps: Boolean(entry.steps?.length),
    details: Boolean(entry.details?.length),
    tips: Boolean(entry.tips?.length),
  };
  const shown = arrange.shown.filter((k) => has[k]);
  const label = (k: string) => GUIDE_TOPIC_SECTIONS.find((s) => s.key === k)?.label ?? k;

  const body = (key: string) => {
    if (key === 'steps') {
      return (
        <V2Box pad={false}>
          <ol className="px-[18px] py-1">
            {entry.steps!.map((step, i) => (
              <li key={i} className="flex items-start gap-3.5 py-3" style={i === 0 ? undefined : { borderTop: '1px solid var(--color-surface-border)' }}>
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0"
                  style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}
                >
                  {i + 1}
                </span>
                <span className="text-[14.5px] leading-relaxed flex-1 min-w-0 text-default" style={{ overflowWrap: 'anywhere' }}>{step}</span>
              </li>
            ))}
          </ol>
        </V2Box>
      );
    }
    if (key === 'details') {
      return (
        <V2Box>
          <div className="flex flex-col gap-3">
            {entry.details!.map((d, i) => (
              <p key={i} className="text-[14.5px] leading-relaxed text-muted" style={{ overflowWrap: 'anywhere' }}>{d}</p>
            ))}
          </div>
        </V2Box>
      );
    }
    return (
      <div
        className="rounded-[18px] px-[18px] py-3.5"
        style={{ border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 40%, transparent)', background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 8%, transparent)' }}
      >
        <ul className="flex flex-col gap-2.5">
          {entry.tips!.map((tip, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <LightBulbIcon className="w-4 h-4 shrink-0 mt-[3px]" style={{ color: 'var(--color-warning, #f59e0b)' }} />
              <span className="text-[14.5px] leading-relaxed flex-1 min-w-0 text-default" style={{ overflowWrap: 'anywhere' }}>{tip}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const jump = (key: string) => document.getElementById(`guide-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      <div className="mt-1 mb-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-opacity hover:opacity-80"
          style={{ color: 'var(--color-secondary)' }}
        >
          <ArrowLeftIcon className="w-4 h-4" />
          {backLabel}
          <span className="text-muted font-normal">&middot; {entry.category}</span>
        </button>
      </div>
      <p className="text-[15px] leading-relaxed max-w-[760px] mb-2 text-default">{entry.answer}</p>

      <div className="flex flex-col lg:flex-row gap-x-7 items-stretch lg:items-start">
        <div className="flex-1 min-w-0 max-w-[860px]">
          {shown.map((key) => (
            <div key={key} id={`guide-${key}`} style={{ scrollMarginTop: 16 }}>
              <ArrangeSection arrange={arrange} id={key} title={label(key)} label={label(key)} meta={key === 'steps' ? `${entry.steps!.length} step${entry.steps!.length === 1 ? '' : 's'}` : key === 'tips' ? `${entry.tips!.length}` : undefined}>
                {body(key)}
              </ArrangeSection>
            </div>
          ))}
        </div>
        {(related.length > 0 || shown.length > 1) && (
          <aside className="w-full lg:w-[300px] lg:flex-none lg:sticky lg:top-5 mt-2 lg:mt-[26px]" aria-label="On this page and related guides">
            {shown.length > 1 && (
              <div className="hidden lg:block mb-5">
                <b className="text-sm">On this page</b>
                <div className="flex flex-col items-start mt-1.5">
                  {shown.map((key) => (
                    <button key={key} type="button" onClick={() => jump(key)} className="text-muted text-[13.5px] py-1 hover:text-default">
                      {label(key)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {related.length > 0 && (
              <div>
                <h2 className="text-lg lg:text-sm font-semibold lg:font-bold mb-2.5">Related</h2>
                <div className="flex flex-col gap-2.5">
                  {related.map((r) => <GuideTile key={r.id} entry={r} />)}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      <div className="mt-6">
        <Link href="/guides" className="text-muted text-[13px] hover:text-default">Browse all guides</Link>
      </div>
    </div>
  );
}
