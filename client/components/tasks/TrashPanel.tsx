'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { TrashIcon } from '@heroicons/react/24/outline';

// Recently deleted catalogs and addons, restorable for 30 days.
//
// The undo toast (see undoToast.tsx) covers the "I just did that by mistake"
// case; this covers "I deleted that last week and want it back". Same
// archive behind both.

type TrashRow = Awaited<ReturnType<typeof api.getTrash>>[number];

export function TrashPanel() {
  const [items, setItems] = useState<TrashRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.getTrash());
    } catch {
      // A trash list that cannot load is not worth an error banner - the
      // panel simply shows nothing.
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const restore = async (item: TrashRow) => {
    setBusyId(item.id);
    try {
      await api.restoreFromTrash(item.id);
      toast.success(`Restored ${item.label}`);
      setItems((prev) => (prev || []).filter((i) => i.id !== item.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (item: TrashRow) => {
    // This is the one delete with nothing behind it, so it asks first.
    if (!confirm(`Permanently delete "${item.label}"? This cannot be undone.`)) return;
    setBusyId(item.id);
    try {
      await api.purgeTrashItem(item.id);
      setItems((prev) => (prev || []).filter((i) => i.id !== item.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove that item');
    } finally {
      setBusyId(null);
    }
  };

  if (!items || items.length === 0) return null;

  return (
    <Card padding="lg">
      <h3 className="text-base font-semibold text-default mb-1">Recently deleted</h3>
      <p className="text-xs text-muted mb-4">
        Deleted catalogs and addons are kept for 30 days. Restoring puts one back exactly as it was, including its group assignments.
      </p>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
            <TrashIcon className="w-4 h-4 text-subtle shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-default truncate">{item.label}</span>
                <Badge variant="muted" size="sm">{item.kind}</Badge>
              </div>
              <p className="text-xs text-muted mt-0.5">
                Deleted {new Date(item.deletedAt).toLocaleDateString()} · {item.expiresInDays} day{item.expiresInDays === 1 ? '' : 's'} left
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="secondary" size="sm" isLoading={busyId === item.id} onClick={() => restore(item)}>Restore</Button>
              <Button variant="ghost" size="sm" disabled={busyId === item.id} onClick={() => purge(item)}>Delete forever</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
