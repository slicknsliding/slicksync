'use client';

// "Sync history" on a person's page and on their Users card (in the ⋯ menu
// of the other page design): what each sync changed on their Stremio or
// Nuvio account, who or what started it, and the ones that failed, newest
// first (server/utils/syncLog.js). Syncs that found nothing to change are
// not kept, so every line here is one that did something.

import { useEffect, useRef, useState } from 'react';
import { ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { HistoryPopup, HistoryRow } from '@/components/ui/HistoryPopup';
import { LoadErrorInline } from '@/components/ui/LoadState';
import { api, type SyncHistoryEntry } from '@/lib/api';
import { formatWhen } from '@/lib/relativeTime';

const PROVIDER: Record<string, string> = { stremio: 'Stremio', nuvio: 'Nuvio' };

function started(e: SyncHistoryEntry): string {
  const group = e.groupName ? `${e.groupName} group` : 'Their group';
  switch (e.source) {
    case 'manual': return 'You pressed Sync';
    case 'sync_all': return 'Sync all';
    case 'group_sync': return `${group} synced`;
    case 'group_change': return `${group} changed`;
    case 'addon_update': return 'An addon was updated';
    case 'schedule': return 'Scheduled sync';
    case 'api': return 'Through the API';
    case 'invite': return 'Invite accepted';
    case 'self': return 'They synced from their own page';
    case 'automation': return 'An automation';
    case 'key_change': return 'A Vault key changed';
    case 'screen_time': return 'Screen time';
    case 'trax': return 'Their SlickTrax rows changed';
    default: return 'SlickSync';
  }
}

function names(list: string[]): string {
  if (list.length <= 4) return list.join(', ');
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

function changes(e: SyncHistoryEntry): string {
  // The server compares addresses, so the same addon at a new address (their
  // SlickTrax rows, a Vault key inside it) comes back as added and removed.
  const moved = e.added.filter((n) => e.removed.includes(n));
  const added = e.added.filter((n) => !moved.includes(n));
  const removed = e.removed.filter((n) => !moved.includes(n));
  const updated = [...new Set([...e.updated, ...moved])];
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${names(added)}`);
  if (removed.length) parts.push(`Removed ${names(removed)}`);
  if (updated.length) parts.push(`Updated ${names(updated)}`);
  if (e.reordered) parts.push('New order');
  return parts.join(' · ');
}

export function SyncHistoryList({ entries }: { entries: SyncHistoryEntry[] }) {
  // Which sign-in only matters for someone with more than one.
  const several = new Set(entries.map((e) => e.provider)).size > 1;
  return (
    <div className="space-y-2">
      {entries.map((e) => {
        const provider = PROVIDER[e.provider] || e.provider;
        const head = `${formatWhen(e.at)} · ${started(e)}${several ? ` · ${provider}` : ''}`;
        if (!e.ok) {
          return (
            <HistoryRow key={e.id} head={head}>
              <div className="flex items-start gap-1.5 text-default">
                <ExclamationTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-px text-error" />
                <span>Couldn’t sync their {provider}, so nothing changed.</span>
              </div>
              {e.repeats > 1 && (
                <p className="text-subtle">
                  Same again {e.repeats - 1} more {e.repeats === 2 ? 'time' : 'times'}, last {formatWhen(e.lastAt)}
                </p>
              )}
              {e.error && (
                <details className="load-details">
                  <summary className="cursor-pointer text-xs text-muted select-none">Details</summary>
                  <code className="block mt-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-default text-xs text-muted font-mono break-all whitespace-pre-wrap">{e.error}</code>
                </details>
              )}
            </HistoryRow>
          );
        }
        return (
          <HistoryRow key={e.id} head={head}>
            <p className="text-muted">{changes(e)}</p>
            {e.total != null && <p className="text-subtle">{e.total} {e.total === 1 ? 'addon' : 'addons'} now</p>}
          </HistoryRow>
        );
      })}
    </div>
  );
}

/** Reads the history each time it opens, and again on Try again. */
export function useSyncHistory(userId: string, open: boolean) {
  const [entries, setEntries] = useState<SyncHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getSyncHistory(userId).then((r) => setEntries(r.entries)).catch((e: Error) => setError(e?.message || 'Could not read the sync history'));
  }, [open, userId, attempt]);
  return { entries, error, retry: () => setAttempt((n) => n + 1) };
}

export function SyncHistoryBody({ entries, error, retry }: ReturnType<typeof useSyncHistory>) {
  if (error) return <LoadErrorInline error={error} onRetry={retry} />;
  if (!entries) return <div className="h-24 rounded-xl skeleton-fill" />;
  if (entries.length === 0) return <p className="text-xs text-subtle">Nothing yet. A line appears here the first time a sync changes their addons, or one doesn’t work.</p>;
  return <SyncHistoryList entries={entries} />;
}

/**
 * Sync history only means something for a sign-in with an addon list: what
 * its line calls their account, or null for nobody to show it for. Pass every
 * sign-in the person has (their own, then a merged one).
 */
export function syncHistoryAccount(...providerTypes: (string | null | undefined)[]): string | null {
  const kinds = providerTypes.filter((k): k is string => k === 'stremio' || k === 'nuvio');
  if (kinds.length === 0) return null;
  if (new Set(kinds).size > 1) return 'accounts';
  return `${kinds[0] === 'nuvio' ? 'Nuvio' : 'Stremio'} account`;
}

/** The popup on its own, for something else that opens it (a card's ⋯ menu). */
export function SyncHistoryPopup({ userId, name, account = 'account', anchor, pointer, onClose }: {
  userId: string;
  name: string;
  account?: string;
  anchor: () => DOMRect | null;
  pointer?: 'start' | 'end';
  onClose: () => void;
}) {
  const history = useSyncHistory(userId, true);
  return (
    // Opened from inside a card, whose own clicks open the person: nothing in
    // here reaches it (React passes a portal's events up through this tree).
    <span className="contents" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <HistoryPopup
        open
        anchor={anchor}
        pointer={pointer}
        onClose={onClose}
        title={`Sync history for ${name}`}
        line={`What each sync changed on their ${account}, newest first.`}
        note="Syncs that found nothing to change aren’t listed. Kept for 90 days."
      >
        <SyncHistoryBody {...history} />
      </HistoryPopup>
    </span>
  );
}

/**
 * account: what the line names, e.g. "Stremio account". size 'sm' and
 * `pointer` on a Users card, beside Limits and Caught up.
 */
export function SyncHistoryButton({ userId, name, account = 'account', size = 'md', pointer = false }: {
  userId: string;
  name: string;
  account?: string;
  size?: 'sm' | 'md';
  pointer?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const history = useSyncHistory(userId, open);
  return (
    // On a Users card the card itself opens the person on a click; nothing
    // done here - in the pill or its popup - reaches it (React passes a
    // portal's events up through the component that rendered it).
    <span
      className="inline-flex max-w-full min-w-0"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ActionPill ref={button} icon={ClockIcon} size={size} open={open} onClick={() => setOpen((v) => !v)}>
        Sync history
      </ActionPill>
      <HistoryPopup
        open={open}
        anchor={() => button.current?.getBoundingClientRect() ?? null}
        pointer={pointer ? 'start' : undefined}
        onClose={() => setOpen(false)}
        title={`Sync history for ${name}`}
        line={`What each sync changed on their ${account}, newest first.`}
        note="Syncs that found nothing to change aren’t listed. Kept for 90 days."
      >
        <SyncHistoryBody {...history} />
      </HistoryPopup>
    </span>
  );
}
