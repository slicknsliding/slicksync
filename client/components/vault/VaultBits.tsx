'use client';

// Small pieces of a Vault card, shared by both page designs: the one status
// badge a Classic card shows, and "Used by N addons" with the list it opens.

import { useEffect, useRef, useState } from 'react';
import { PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { HistoryPopup, HistoryRow } from '@/components/ui/HistoryPopup';
import { LoadErrorInline } from '@/components/ui/LoadState';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { api } from '@/lib/api';
import { useIsTV } from '@/lib/hooks/useIsTV';
import type { Judged } from '@/lib/vaultStatus';

/** A Classic card's one badge: Working, Not working, Ends in 2 days, Lifetime. */
export function VaultStatusBadge({ judged }: { judged: Judged }) {
  return <span className={`vault-badge ${judged.badgeTone}`}>{judged.badge}</span>;
}

type UsedBy = { addons: { id: string; name: string; groups: string[] }[]; aioConfigs: { userId: string; username: string }[] };

/**
 * "Used by 3 addons": how many addons carry this key, and on a press, which
 * ones and whose. Worth knowing before a key is rotated or deleted. Draws
 * nothing when no addon carries it.
 */
export function UsedByChip({ entryId, name, count }: { entryId: string; name: string; count: number }) {
  const isTV = useIsTV();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<UsedBy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getVaultUsedBy(entryId)
      .then((r) => { if (!cancelled) { setList(r); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e?.message || 'Could not read where it is used'); });
    return () => { cancelled = true; };
  }, [open, entryId, attempt]);
  if (count <= 0) return null;
  const chip = (
    <button
      ref={button}
      type="button"
      className="vault-used-chip"
      aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}
    >
      <PuzzlePieceIcon className="w-4 h-4" />
      Used by {count} addon{count === 1 ? '' : 's'}
    </button>
  );
  return (
    <>
      {/* A remote reaches it as its own stop, like the History button beside it. */}
      {isTV ? <TVFocusable onEnterPress={() => setOpen((v) => !v)}>{chip}</TVFocusable> : chip}
      <HistoryPopup
        open={open}
        anchor={() => button.current?.getBoundingClientRect() ?? null}
        pointer="start"
        onClose={() => setOpen(false)}
        title={`Carries ${name}’s key`}
        line="Change the key here and SlickSync puts the new one into each of these."
      >
        {error ? (
          <LoadErrorInline error={error} onRetry={() => { setError(null); setAttempt((n) => n + 1); }} />
        ) : !list ? (
          <div className="h-20 rounded-xl skeleton-fill" />
        ) : (
          <div className="space-y-2">
            {list.addons.map((a) => (
              <HistoryRow key={a.id} head={a.name}>
                <p className="text-subtle">{a.groups.length ? a.groups.join(', ') : 'In no group'}</p>
              </HistoryRow>
            ))}
            {list.aioConfigs.map((c) => (
              <HistoryRow key={c.userId} head={`${c.username}’s AIOStreams`}>
                <p className="text-subtle">Inside their AIOStreams configuration</p>
              </HistoryRow>
            ))}
            {list.addons.length === 0 && list.aioConfigs.length === 0 && <p className="text-xs text-subtle">Nothing carries it right now.</p>}
          </div>
        )}
      </HistoryPopup>
    </>
  );
}
