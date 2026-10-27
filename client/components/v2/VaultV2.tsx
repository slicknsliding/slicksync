'use client';

// The Vault in the v2 page design: whatever needs you (not working, ending
// soon) sits on top; the rest is listed below. Each entry shows one status in
// words and the one button that fits it (Fix, Renew or Test), with Copy
// beside it. Sections move, fold and hide, and single entries hide, through
// Arrange.

import { ArrowPathIcon, DocumentDuplicateIcon, EyeIcon, KeyIcon } from '@heroicons/react/24/outline';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { VaultEntry } from '@/lib/api';
import { V2Button, V2Card, V2Grid, V2List, V2Status, type V2Tone } from './V2Bits';

export const VAULT_SECTIONS = [
  { key: 's:needs', label: 'Needs you' },
  { key: 's:rest', label: 'Working' },
] as const;

type Judged = { tone: V2Tone; words: string; line: string; need: 'fix' | 'renew' | null };

function daysUntil(d?: string | null, now = Date.now()) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? Math.round((t - now) / 86400000) : null;
}

/** One status for an entry, in words, and whether it needs you. */
export function judgeEntry(e: VaultEntry, now: number): Judged {
  const days = daysUntil(e.expiresAt, now);
  const snoozed = !!e.snoozedUntil && new Date(e.snoozedUntil).getTime() > now;
  if (e.lastCheckStatus === 'error') return { tone: 'bad', words: 'Not working', line: e.lastCheckMessage || 'Last check failed', need: 'fix' };
  if (days !== null && days < 0) return { tone: 'bad', words: 'Ended', line: `Ended ${-days === 1 ? 'yesterday' : `${-days} days ago`}`, need: 'renew' };
  if (days !== null && days <= (e.notifyDaysBefore ?? 7) && !snoozed) return { tone: 'warn', words: 'Ending soon', line: days === 0 ? 'Ends today' : `Ends in ${days} day${days === 1 ? '' : 's'}`, need: 'renew' };
  const ends = days !== null ? `Ends in ${days} days` : '';
  if (e.testType === 'manual' || !e.lastCheckStatus) return { tone: 'off', words: 'Not checked', line: ends || 'No automatic check', need: null };
  return { tone: 'live', words: 'Working', line: ends || e.lastCheckMessage || 'Last check passed', need: null };
}

export function VaultV2({ entries, labels, arrange, entryArrange, view, testing, now, onOpen, onCopy, onTest }: {
  entries: VaultEntry[];
  labels: Record<string, string>;
  arrange: PageArrange;
  entryArrange: PageArrange;
  view: 'grid' | 'list';
  testing: string | null;
  now: number;
  onOpen: (e: VaultEntry) => void;
  onCopy: (e: VaultEntry) => void;
  onTest: (e: VaultEntry) => void;
}) {
  const hidden = new Set(entryArrange.hidden);
  const judged = entries.map((e) => ({ e, j: judgeEntry(e, now) }));

  const buttons = (e: VaultEntry, j: Judged) => {
    if (arrange.arranging) {
      return (
        <button type="button" className="arrange-icon" aria-label={`Hide ${e.name}`} title="Hide on this page"
          onClick={(ev) => { ev.stopPropagation(); entryArrange.hide(e.id); }}>
          <EyeIcon className="w-4 h-4" />
        </button>
      );
    }
    const main = j.need === 'fix'
      ? <V2Button primary onClick={() => onOpen(e)}>Fix</V2Button>
      : j.need === 'renew'
        ? <V2Button onClick={() => onOpen(e)}>Renew</V2Button>
        : (
          <V2Button onClick={() => onTest(e)} disabled={testing === e.id || e.testType === 'manual'} icon={<ArrowPathIcon className={`w-4 h-4${testing === e.id ? ' animate-spin' : ''}`} />}>
            Test
          </V2Button>
        );
    return (
      <span className="flex gap-2">
        <V2Button onClick={() => onCopy(e)} icon={<DocumentDuplicateIcon className="w-4 h-4" />}>Copy</V2Button>
        {main}
      </span>
    );
  };
  const open = (e: VaultEntry) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => onOpen(e),
    onKeyDown: (ev: React.KeyboardEvent) => { if (ev.key === 'Enter') onOpen(e); },
  });
  const icon = (size: number) => (
    <span className="rounded-[14px] flex items-center justify-center shrink-0 text-muted" style={{ width: size, height: size, background: 'var(--color-surface-elevated, var(--color-surface-hover))' }}>
      <KeyIcon className="w-1/2 h-1/2" />
    </span>
  );
  const kind = (e: VaultEntry) => [labels[e.category] || e.category, e.provider].filter(Boolean).join(' · ');
  const tile = ({ e, j }: { e: VaultEntry; j: Judged }) => (
    <div key={e.id} className="v2-link cursor-pointer" {...open(e)}>
      <V2Card footer="Tap to edit" action={buttons(e, j)}>
        <div className="flex items-center gap-3.5 min-w-0">
          {icon(48)}
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold text-default truncate">{e.name}</div>
            <div className="text-muted text-[12.5px] truncate">{kind(e)}</div>
          </div>
        </div>
        <div>
          <V2Status tone={j.tone}>{j.words}</V2Status>
          <div className="text-muted text-[13px] mt-1 truncate">{j.line}</div>
        </div>
      </V2Card>
    </div>
  );
  const row = ({ e, j }: { e: VaultEntry; j: Judged }) => (
    <div key={e.id} className="v2-row cursor-pointer" {...open(e)}>
      {icon(38)}
      <div className="flex-1 min-w-0">
        <b className="text-default block truncate">{e.name}</b>
        <div className="text-muted text-[12.5px] truncate">{kind(e)}</div>
      </div>
      <div className="v2-col w-[150px]"><V2Status tone={j.tone}>{j.words}</V2Status></div>
      <div className="v2-col w-[200px] text-muted text-[13px] truncate">{j.line}</div>
      {buttons(e, j)}
    </div>
  );

  return (
    <div>
      {arrange.shown.map((key) => {
        const all = judged.filter(({ j }) => (key === 's:needs' ? j.need !== null : j.need === null));
        if (all.length === 0) return null;
        const shown = all.filter(({ e }) => !hidden.has(e.id));
        const needs = key === 's:needs';
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} noun="section"
            label={needs ? 'Needs you' : 'Working'}
            title={<span className="flex items-center gap-2.5"><span className="w-3 h-3 rounded shrink-0" style={{ background: needs ? 'var(--color-error, #ef4444)' : 'var(--color-success, #22c55e)' }} />{needs ? 'Needs you' : 'Working'}</span>}
            meta={`${all.length}`}>
            {shown.length === 0
              ? <p className="text-sm text-muted py-2">Every entry here is hidden on this page.</p>
              : view === 'grid' ? <V2Grid>{shown.map(tile)}</V2Grid> : <V2List>{shown.map(row)}</V2List>}
          </ArrangeSection>
        );
      })}
    </div>
  );
}
