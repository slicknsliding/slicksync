'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { ArchiveBoxIcon } from '@heroicons/react/24/outline';

// Shows someone genuinely started and then stopped watching.
//
// Continue Watching only looks back 120 days, so anything older disappears
// from the app completely - never resumed, never acknowledged, just gone.
// This is the shelf those end up on, so each one can actually be dealt with
// instead of quietly accumulating.
//
// "Bury" reuses the same dismissal the Continue Watching row uses rather
// than inventing a second one: "I'm done with this show" means the same
// thing in both places, and something buried here should never resurface
// there either.

type Dropped = Awaited<ReturnType<typeof api.getAbandonedShows>>[number];

export function DroppedShowsPanel() {
  const [items, setItems] = useState<Dropped[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [burying, setBurying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.getAbandonedShows());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load dropped shows');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const bury = async (item: Dropped) => {
    const key = `${item.userId}:${item.showId}`;
    setBurying(key);
    try {
      await api.dismissContinueWatching(item.userId, item.showId);
      // Removed locally rather than refetching the whole list - the row is
      // gone either way and a refetch would flash the entire panel.
      setItems((prev) => (prev || []).filter((i) => `${i.userId}:${i.showId}` !== key));
      toast.success(`Buried ${item.showName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not bury that show');
    } finally {
      setBurying(null);
    }
  };

  if (error) {
    return (
      <Card padding="lg">
        <p className="text-sm text-error">{error}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={load}>Retry</Button>
      </Card>
    );
  }

  if (!items) {
    return <Card padding="lg"><p className="text-sm text-muted">Looking for dropped shows...</p></Card>;
  }

  if (items.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-8">
          <ArchiveBoxIcon className="w-10 h-10 text-subtle mx-auto mb-3" />
          <p className="text-default font-medium mb-1">Nothing abandoned</p>
          <p className="text-sm text-muted">Every show anyone started has either been finished or watched recently.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-default">Dropped shows</h3>
        <p className="text-sm text-muted mt-0.5">
          Started, then not touched in over 45 days. Pick one back up, or bury it so it stops showing here.
        </p>
      </div>
      <div className="space-y-2">
        {items.map((item) => {
          const key = `${item.userId}:${item.showId}`;
          return (
            <div key={key} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
              {item.poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.poster} alt="" width={40} height={60} className="w-10 h-15 rounded object-cover shrink-0" style={{ height: '3.75rem' }} />
              ) : (
                <div className="w-10 shrink-0 rounded" style={{ height: '3.75rem', background: 'var(--color-bg-subtle)' }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-default truncate">{item.showName}</span>
                  <Badge variant="muted" size="sm">{item.username}</Badge>
                </div>
                <p className="text-xs text-muted mt-0.5">
                  Stopped at S{item.lastSeason}E{item.lastEpisode} · {item.episodesWatched} episode{item.episodesWatched === 1 ? '' : 's'} watched · {item.daysSince} days ago
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                isLoading={burying === key}
                onClick={() => bury(item)}
              >
                Bury
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
