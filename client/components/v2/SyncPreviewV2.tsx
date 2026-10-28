'use client';

// The v2 look of the sync preview (SyncPreviewDialog draws this when Page
// design is v2): who it's for with their picture, what would change as chips
// and one row per change with a coloured word, what stays folded away, and
// Sync as the one button. When nothing would change it says so in a green box
// and the button becomes a plain "Sync anyway".

import { useState, type ReactNode } from 'react';
import { CheckCircleIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui/UserAvatar';

type Entry = { name: string; transportUrl: string };

export type SyncPreviewPerson = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
  useGravatar?: boolean;
  colorIndex?: number;
  /** "Nuvio", "Stremio"... */
  appLabel?: string;
  /** The group they are in, if any. */
  groupName?: string;
};

const GOOD = 'var(--color-success, #22c55e)';
const BAD = 'var(--color-error, #ef4444)';
const NEUTRAL = 'var(--color-primary)';

function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center text-[12.5px] font-semibold px-2.5 py-0.5 rounded-full"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {children}
    </span>
  );
}

function Mark({ name }: { name: string }) {
  // A small tile with the addon's first letter; the plan carries no logo.
  const letter = (name.trim()[0] || '?').toUpperCase();
  return (
    <span
      className="shrink-0 flex items-center justify-center rounded-lg text-[12px] font-bold"
      style={{ width: 28, height: 28, background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

function ChangeRow({ entry, word, color }: { entry: Entry; word: string; color: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
      <Mark name={entry.name} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{entry.name}</div>
      </div>
      <span className="text-[12.5px] font-semibold px-2.5 py-0.5 rounded-full" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{word}</span>
    </div>
  );
}

export function SyncPreviewV2Body({ person, loading, error, ready, added, removed, reordered, stay, nothingToDo, confirming, onClose, onConfirm }: {
  person: SyncPreviewPerson;
  loading: boolean;
  error: string | null;
  ready: boolean;
  added: Entry[];
  removed: Entry[];
  reordered: boolean;
  stay: Entry[];
  nothingToDo: boolean;
  confirming: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [showStay, setShowStay] = useState(false);
  const sub = [person.appLabel ? `${person.name}’s ${person.appLabel}` : null, person.groupName ? `in the ${person.groupName} group` : null].filter(Boolean).join(' · ');
  return (
    <div className="v2-sync">
      <div className="flex items-center gap-3 pr-8">
        <UserAvatar
          userId={person.id}
          name={person.name}
          email={person.email}
          src={person.avatarUrl ?? undefined}
          useGravatar={person.useGravatar}
          colorIndex={person.colorIndex || 0}
          size="lg"
          className="w-[42px] h-[42px] rounded-full"
        />
        <div className="min-w-0 flex-1">
          <div className="text-xl font-bold leading-tight truncate">Sync {person.name}?</div>
          {sub && <div className="text-[13px] text-muted mt-0.5 truncate">{sub}</div>}
        </div>
      </div>

      {loading && <p className="text-sm text-muted py-5 text-center">Working out what would change...</p>}

      {error && (
        <div className="mt-4 p-3 rounded-xl text-sm" style={{ background: 'color-mix(in srgb, var(--color-error) 12%, transparent)' }}>
          {error}
          <p className="text-xs text-muted mt-1">You can still sync - this preview just could not be built.</p>
        </div>
      )}

      {ready && nothingToDo && (
        <div className="flex items-center gap-3 mt-4 p-3.5 rounded-2xl" style={{ background: `color-mix(in srgb, ${GOOD} 10%, transparent)` }}>
          <CheckCircleIcon className="w-6 h-6 shrink-0" style={{ color: GOOD }} />
          <div>
            <div className="text-sm font-semibold">Already up to date</div>
            <div className="text-[12.5px] text-muted mt-0.5">
              {stay.length > 0 ? `${person.name}’s ${stay.length} addon${stay.length === 1 ? '' : 's'} match. ` : ''}Syncing won’t change anything.
            </div>
          </div>
        </div>
      )}

      {ready && !nothingToDo && (
        <>
          <div className="flex gap-1.5 flex-wrap mt-4 mb-1.5">
            {added.length > 0 && <Chip color={GOOD}>{added.length} to add</Chip>}
            {removed.length > 0 && <Chip color={BAD}>{removed.length} to remove</Chip>}
            {reordered && <Chip color={NEUTRAL}>New order</Chip>}
          </div>
          <div className="max-h-72 overflow-y-auto">
            {added.map((a) => <ChangeRow key={`a:${a.transportUrl}`} entry={a} word="Adds" color={GOOD} />)}
            {removed.map((a) => <ChangeRow key={`r:${a.transportUrl}`} entry={a} word="Removes" color={BAD} />)}
            {reordered && (
              <div className="flex items-center gap-3 py-2.5 border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">Addon order</div>
                  <div className="text-[12.5px] text-muted">The same addons, in a different order.</div>
                </div>
                <span className="text-[12.5px] font-semibold px-2.5 py-0.5 rounded-full" style={{ color: NEUTRAL, background: `color-mix(in srgb, ${NEUTRAL} 14%, transparent)` }}>Reorders</span>
              </div>
            )}
          </div>
        </>
      )}

      {ready && stay.length > 0 && !nothingToDo && (
        <div className="border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full py-3 text-left"
            aria-expanded={showStay}
            onClick={() => setShowStay((v) => !v)}
          >
            <ChevronRightIcon className="w-4 h-4 text-muted transition-transform" style={{ transform: showStay ? 'rotate(90deg)' : undefined }} />
            <span className="flex-1 text-[13.5px] text-muted">{stay.length} stay as they are</span>
            {!showStay && (
              <span className="flex">
                {stay.slice(0, 4).map((a, i) => <span key={a.transportUrl} style={{ marginLeft: i ? -6 : 0 }}><Mark name={a.name} /></span>)}
              </span>
            )}
          </button>
          {showStay && (
            <ul className="pb-2 space-y-1">
              {stay.map((a) => <li key={a.transportUrl} className="text-sm pl-6 truncate">{a.name}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-row gap-2 mt-5 sm:justify-end">
        <button type="button" className="v2-btn justify-center flex-1 sm:flex-none" style={{ padding: '10px 16px' }} onClick={onClose} disabled={confirming}>Cancel</button>
        <button
          type="button"
          className={`${nothingToDo ? 'v2-btn' : 'v2-btn v2-btn-main'} justify-center flex-[2] sm:flex-none`}
          style={{ padding: '10px 18px' }}
          onClick={onConfirm}
          disabled={loading || confirming}
        >
          {confirming ? 'Syncing...' : nothingToDo ? 'Sync anyway' : 'Sync'}
        </button>
      </div>
    </div>
  );
}
