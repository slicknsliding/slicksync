'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { ArchiveBoxIcon } from '@heroicons/react/24/outline';

// The Graveyard (renamed from "Dropped" - the user's own word for it, and a
// better one: bury implied a place, and for a while there wasn't one).
//
// Two shelves in one panel:
//  - Unfinished: shows someone genuinely started and then stopped. Continue
//    Watching only looks back 120 days, so anything older used to disappear
//    from the app completely - never resumed, never acknowledged, just gone.
//  - The graveyard itself: what burying produced. Burying reuses the same
//    dismissal Continue Watching uses ("done with this show" means the same
//    thing in both places), so shows dismissed there rest here too - and
//    every one of them can be dug back up, which is the half that was
//    missing: buried shows used to vanish with no list and no way back.

type Dropped = Awaited<ReturnType<typeof api.getAbandonedShows>>[number];
type Buried = Awaited<ReturnType<typeof api.getBuriedShows>>[number];

export function DroppedShowsPanel() {
  const [items, setItems] = useState<Dropped[] | null>(null);
  const [buried, setBuried] = useState<Buried[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [graveOpen, setGraveOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [abandoned, graves] = await Promise.all([api.getAbandonedShows(), api.getBuriedShows()]);
      setItems(abandoned);
      setBuried(graves);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the graveyard');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const bury = async (item: Dropped) => {
    const key = `${item.userId}:${item.showId}`;
    setWorking(key);
    try {
      await api.dismissContinueWatching(item.userId, item.showId);
      setItems((prev) => (prev || []).filter((i) => `${i.userId}:${i.showId}` !== key));
      // Appears in the graveyard immediately, without a refetch flashing the
      // whole panel - buriedAt is "now" by definition.
      setBuried((prev) => [{
        userId: item.userId, username: item.username, showId: item.showId, showName: item.showName,
        poster: item.poster, lastSeason: item.lastSeason, lastEpisode: item.lastEpisode,
        lastWatchedAt: item.lastWatchedAt, buriedAt: new Date().toISOString(),
      }, ...(prev || [])]);
      toast.success(`Buried ${item.showName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not bury that show');
    } finally {
      setWorking(null);
    }
  };

  const unbury = async (item: Buried) => {
    const key = `${item.userId}:${item.showId}`;
    setWorking(key);
    try {
      await api.unburyShow(item.userId, item.showId);
      setBuried((prev) => (prev || []).filter((i) => `${i.userId}:${i.showId}` !== key));
      toast.success(`${item.showName} dug back up - it returns to Continue Watching or the unfinished list`);
      // The unfinished list may now contain it again - refresh just that half.
      api.getAbandonedShows().then(setItems).catch(() => {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unbury that show');
    } finally {
      setWorking(null);
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

  if (!items || !buried) {
    return <Card padding="lg"><p className="text-sm text-muted">Visiting the graveyard...</p></Card>;
  }

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-default">Unfinished</h3>
          <p className="text-sm text-muted mt-0.5">
            Started, then not touched in over 45 days. Pick one back up, or bury it.
          </p>
        </div>
        {items.length === 0 ? (
          <div className="text-center py-6">
            <ArchiveBoxIcon className="w-10 h-10 text-subtle mx-auto mb-3" />
            <p className="text-default font-medium mb-1">Nothing abandoned</p>
            <p className="text-sm text-muted">Every show anyone started has either been finished or watched recently.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const key = `${item.userId}:${item.showId}`;
              return (
                <div key={key} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
                  {item.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.poster} alt="" width={40} height={60} className="w-10 rounded object-cover shrink-0" style={{ height: '3.75rem' }} />
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
                    isLoading={working === key}
                    onClick={() => bury(item)}
                  >
                    Bury
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {buried.length > 0 && (
        <Card padding="lg">
          <button
            type="button"
            onClick={() => setGraveOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <div>
              <h3 className="text-lg font-semibold text-default">The Graveyard</h3>
              <p className="text-sm text-muted mt-0.5">
                {buried.length} buried show{buried.length === 1 ? '' : 's'} resting here. Any of them can be dug back up.
              </p>
            </div>
            <span className="text-xs text-muted shrink-0">{graveOpen ? 'Hide' : 'Show'}</span>
          </button>
          {graveOpen && (
            <div className="space-y-2 mt-4">
              {buried.map((item) => {
                const key = `${item.userId}:${item.showId}`;
                return (
                  <div key={key} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)', opacity: 0.85 }}>
                    {item.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.poster} alt="" width={40} height={60} className="w-10 rounded object-cover shrink-0 grayscale" style={{ height: '3.75rem' }} />
                    ) : (
                      <div className="w-10 shrink-0 rounded" style={{ height: '3.75rem', background: 'var(--color-bg-subtle)' }} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-default truncate">{item.showName}</span>
                        <Badge variant="muted" size="sm">{item.username}</Badge>
                      </div>
                      <p className="text-xs text-muted mt-0.5">
                        {item.lastSeason != null && item.lastEpisode != null ? `Rested at S${item.lastSeason}E${item.lastEpisode} · ` : ''}
                        Buried {new Date(item.buriedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      isLoading={working === key}
                      onClick={() => unbury(item)}
                    >
                      Dig up
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
