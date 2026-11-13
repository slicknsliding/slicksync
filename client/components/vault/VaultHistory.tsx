'use client';

// A Vault key's History: each time it was shown, copied, changed or added,
// from which device and address, newest first (server/utils/vaultAccess.js).
// The clock button on a Classic card opens it; in v2 it is History in the
// card's menu, which opens the same box beside that card's menu button.

import { useEffect, useRef, useState } from 'react';
import { ClockIcon } from '@heroicons/react/24/outline';
import { HistoryPopup, HistoryRow } from '@/components/ui/HistoryPopup';
import { LoadErrorInline } from '@/components/ui/LoadState';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { api, type VaultHistoryEntry } from '@/lib/api';
import { formatWhen } from '@/lib/relativeTime';

const ACTION: Record<VaultHistoryEntry['action'], string> = {
  shown: 'Shown',
  copied: 'Copied',
  moved: 'Moved to Addons',
  changed: 'Key changed',
  added: 'Added',
  swapped: 'Swapped with its backup key',
};

function useVaultHistory(entryId: string, open: boolean) {
  const [entries, setEntries] = useState<VaultHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getVaultHistory(entryId).then((r) => setEntries(r.entries)).catch((e: Error) => setError(e?.message || 'Could not read the history'));
  }, [open, entryId, attempt]);
  return { entries, error, retry: () => setAttempt((n) => n + 1) };
}

/** The box itself, beside whatever `anchor` points at. */
export function VaultHistoryPopup({ entryId, name, open, anchor, onClose }: {
  entryId: string;
  name: string;
  open: boolean;
  anchor: () => DOMRect | null;
  onClose: () => void;
}) {
  const { entries, error, retry } = useVaultHistory(entryId, open);
  return (
    <HistoryPopup
      open={open}
      anchor={anchor}
      onClose={onClose}
      title={`History of ${name}’s key`}
      line="Each time it was shown, copied or changed, newest first."
      note="Kept for a year."
    >
      {error ? (
        <LoadErrorInline error={error} onRetry={retry} />
      ) : !entries ? (
        <div className="h-24 rounded-xl skeleton-fill" />
      ) : entries.length === 0 ? (
        <p className="text-xs text-subtle">Nothing yet. A line appears here the next time this key is shown, copied or changed.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => {
            const where = [e.device, e.ip].filter(Boolean).join(' · ') || (e.action === 'swapped' ? 'By SlickSync, after a failed check' : '');
            return (
              <HistoryRow key={e.id} head={`${formatWhen(e.at)} · ${ACTION[e.action] || e.action}`}>
                {where && <p className="text-subtle">{where}</p>}
              </HistoryRow>
            );
          })}
        </div>
      )}
    </HistoryPopup>
  );
}

/** The clock button on a Classic Vault card. */
export function VaultHistoryButton({ entryId, name }: { entryId: string; name: string }) {
  const isTV = useIsTV();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const btn = (
    <button
      ref={button}
      type="button"
      onClick={toggle}
      title="History"
      aria-label={`History of ${name}’s key`}
      aria-expanded={open}
      className="p-2 rounded-lg transition-colors"
      style={{ background: 'var(--color-surface-hover)' }}
    >
      <ClockIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
    </button>
  );
  return (
    <>
      {isTV ? <TVFocusable onEnterPress={toggle}>{btn}</TVFocusable> : btn}
      <VaultHistoryPopup
        entryId={entryId}
        name={name}
        open={open}
        anchor={() => button.current?.getBoundingClientRect() ?? null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
