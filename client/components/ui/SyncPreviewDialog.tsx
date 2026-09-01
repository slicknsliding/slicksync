'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { PlusIcon, MinusIcon, ArrowsUpDownIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

// "Show me what this will do before it does it" for a user sync.
//
// Syncing rewrites a real Stremio/Nuvio account's addon list. Until now the
// button just did it, so the only way to find out what changed was to compare
// before and after from memory. This turns it into a decision: exactly which
// addons get added, removed, or reordered, then an explicit confirm.
//
// Deliberately built on the EXISTING /users/:id/sync-plan endpoint rather
// than a new one - that route already computes current vs desired using the
// same comparator the sync badge uses, so the preview can never disagree with
// what the sync actually does. The diff below is purely a presentation of
// that response.

interface SyncPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  userName: string;
  /** Runs the real sync. The dialog closes itself first. */
  onConfirm: () => void | Promise<void>;
}

interface PlanEntry { name: string; transportUrl: string; fingerprint: string }

export function SyncPreviewDialog({ isOpen, onClose, userId, userName, onConfirm }: SyncPreviewDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{
    alreadySynced: boolean;
    current: PlanEntry[];
    desired: PlanEntry[];
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!isOpen) { setPlan(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    api.getUserSyncPlan(userId)
      .then((p) => { if (!cancelled) setPlan(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not work out what would change'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, userId]);

  // Matched on transportUrl rather than fingerprint: fingerprint folds in
  // position, so a pure reorder would otherwise read as "remove everything,
  // add everything back" - which is exactly the panic this dialog exists to
  // prevent.
  const currentUrls = new Set((plan?.current || []).map((a) => a.transportUrl));
  const desiredUrls = new Set((plan?.desired || []).map((a) => a.transportUrl));
  const added = (plan?.desired || []).filter((a) => !currentUrls.has(a.transportUrl));
  const removed = (plan?.current || []).filter((a) => !desiredUrls.has(a.transportUrl));
  // Same set on both sides but a different order = reorder only.
  const keptCurrent = (plan?.current || []).filter((a) => desiredUrls.has(a.transportUrl)).map((a) => a.transportUrl);
  const keptDesired = (plan?.desired || []).filter((a) => currentUrls.has(a.transportUrl)).map((a) => a.transportUrl);
  const reordered = keptCurrent.length === keptDesired.length
    && keptCurrent.some((url, i) => url !== keptDesired[i]);

  const nothingToDo = !!plan && added.length === 0 && removed.length === 0 && !reordered;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Sync ${userName}`} size="lg">
      <div className="space-y-4">
        {loading && <p className="text-sm text-muted py-4 text-center">Working out what would change...</p>}

        {error && (
          <div className="p-3 rounded-lg text-sm" style={{ background: 'color-mix(in srgb, var(--color-error) 12%, transparent)', color: 'var(--color-text)' }}>
            {error}
            <p className="text-xs text-muted mt-1">You can still sync - this preview just could not be built.</p>
          </div>
        )}

        {plan && nothingToDo && (
          <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'var(--color-surface-hover)' }}>
            <CheckCircleIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-success)' }} />
            <p className="text-sm text-default">Already up to date - syncing would not change anything.</p>
          </div>
        )}

        {plan && !nothingToDo && (
          <>
            <p className="text-sm text-muted">
              This will change {userName}&apos;s addons on their actual Stremio/Nuvio account:
            </p>
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {added.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--color-success)' }}>
                    <PlusIcon className="w-3.5 h-3.5 inline mr-1" />
                    {added.length} to add
                  </p>
                  <ul className="space-y-1">
                    {added.map((a) => (
                      <li key={a.transportUrl} className="text-sm text-default pl-5 truncate">{a.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              {removed.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--color-error)' }}>
                    <MinusIcon className="w-3.5 h-3.5 inline mr-1" />
                    {removed.length} to remove
                  </p>
                  <ul className="space-y-1">
                    {removed.map((a) => (
                      <li key={a.transportUrl} className="text-sm text-default pl-5 truncate">{a.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              {reordered && (
                <div>
                  <p className="text-xs font-semibold mb-1.5 text-muted">
                    <ArrowsUpDownIcon className="w-3.5 h-3.5 inline mr-1" />
                    Addon order will change
                  </p>
                  <p className="text-xs text-muted pl-5">The same addons, in a different order.</p>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={confirming}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} isLoading={confirming} disabled={loading}>
            {nothingToDo ? 'Sync anyway' : 'Sync now'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
