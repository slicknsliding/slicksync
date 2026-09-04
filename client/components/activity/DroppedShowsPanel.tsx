'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
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
//    every one of them can be dug back up, or wiped permanently.
//
// Both shelves support multi-select: a household purge is dozens of shows,
// and one-at-a-time was the entire cost of doing it. Bulk operations loop
// the same single-item endpoints - at household scale that is a handful of
// fast requests, and it keeps one code path per operation (wipes, notably,
// each land their own Trash entry so each show stays individually undoable).

type Dropped = Awaited<ReturnType<typeof api.getAbandonedShows>>[number];
type Buried = Awaited<ReturnType<typeof api.getBuriedShows>>[number];

const keyOf = (item: { userId: string; showId: string }) => `${item.userId}:${item.showId}`;

export function DroppedShowsPanel() {
  const [items, setItems] = useState<Dropped[] | null>(null);
  const [buried, setBuried] = useState<Buried[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [graveOpen, setGraveOpen] = useState(false);

  // Multi-select, one set per shelf. Keys are `${userId}:${showId}` - the
  // same identity every row action already uses.
  const [selUnfinished, setSelUnfinished] = useState<Set<string>>(new Set());
  const [selBuried, setSelBuried] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

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

  const toggleSel = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const bury = async (item: Dropped) => {
    const key = keyOf(item);
    setWorking(key);
    try {
      await api.dismissContinueWatching(item.userId, item.showId);
      setItems((prev) => (prev || []).filter((i) => keyOf(i) !== key));
      setSelUnfinished((prev) => { const n = new Set(prev); n.delete(key); return n; });
      // Appears in the graveyard immediately, without a refetch flashing the
      // whole panel - buriedAt is "now" by definition.
      setBuried((prev) => [{
        userId: item.userId, username: item.username, showId: item.showId, showName: item.showName,
        poster: item.poster, lastSeason: item.lastSeason, lastEpisode: item.lastEpisode,
        lastWatchedAt: item.lastWatchedAt, episodesWatched: item.episodesWatched, buriedAt: new Date().toISOString(),
      }, ...(prev || [])]);
      toast.success(`Buried ${item.showName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not bury that show');
    } finally {
      setWorking(null);
    }
  };

  const unbury = async (item: Buried) => {
    const key = keyOf(item);
    setWorking(key);
    try {
      await api.unburyShow(item.userId, item.showId);
      setBuried((prev) => (prev || []).filter((i) => keyOf(i) !== key));
      setSelBuried((prev) => { const n = new Set(prev); n.delete(key); return n; });
      toast.success(`${item.showName} dug back up - it returns to Continue Watching or the unfinished list`);
      // The unfinished list may now contain it again - refresh just that half.
      api.getAbandonedShows().then(setItems).catch(() => {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unbury that show');
    } finally {
      setWorking(null);
    }
  };

  // The permanent exit. Two-step on purpose: Wipe arms a confirmation state
  // on the row itself (button turns into "Erase N episodes forever?"), so
  // the destructive click is never the first click and the count of what
  // dies is in the button text. No modal - the row IS the context.
  const [wipeArmed, setWipeArmed] = useState<string | null>(null);

  // Panel-level option applied to every wipe (single and bulk): also drop
  // the title from the provider account's own library, so it leaves the
  // device's home screen too - the wipe alone only erases SlickSync's
  // record while the provider keeps showing it on-device. Persisted per
  // browser; the server skips it gracefully on providers whose libraries
  // are read-only (Nuvio), so it's safe to leave on for a mixed household.
  const [wipeOnDevice, setWipeOnDevice] = useState(false);
  useEffect(() => {
    try { setWipeOnDevice(localStorage.getItem('graveyard-wipe-on-device') === '1'); } catch { /* fresh browser */ }
  }, []);
  const toggleWipeOnDevice = (v: boolean) => {
    setWipeOnDevice(v);
    try { localStorage.setItem('graveyard-wipe-on-device', v ? '1' : '0'); } catch { /* private window */ }
  };

  const wipe = async (item: Buried) => {
    const key = keyOf(item);
    if (wipeArmed !== key) {
      setWipeArmed(key);
      setTimeout(() => setWipeArmed((cur) => (cur === key ? null : cur)), 5000);
      return;
    }
    setWipeArmed(null);
    setWorking(key);
    try {
      const r = await api.wipeBuriedShow(item.userId, item.showId, wipeOnDevice);
      setBuried((prev) => (prev || []).filter((i) => keyOf(i) !== key));
      setSelBuried((prev) => { const n = new Set(prev); n.delete(key); return n; });
      const erased = r.episodesDeleted > 0
        ? `${r.episodesDeleted} episode${r.episodesDeleted === 1 ? '' : 's'} of history erased`
        : 'its watch history erased';
      const device = r.deviceRemoved ? ', removed from the account library' : '';
      toast.success(`${item.showName} wiped - ${erased}${device} (undoable for 30 days in the Trash)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not wipe that show');
    } finally {
      setWorking(null);
    }
  };

  // ---- Bulk operations: loop the single-item calls, then reconcile once.

  const buryBulk = async () => {
    const targets = (items || []).filter((i) => selUnfinished.has(keyOf(i)));
    if (targets.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    for (const item of targets) {
      try { await api.dismissContinueWatching(item.userId, item.showId); ok++; } catch { /* counted below */ }
    }
    setBulkBusy(false);
    setSelUnfinished(new Set());
    await load();
    if (ok === targets.length) toast.success(`Buried ${ok} show${ok === 1 ? '' : 's'}`);
    else toast.error(`Buried ${ok} of ${targets.length} - the rest failed, try them again`);
  };

  const unburyBulk = async () => {
    const targets = (buried || []).filter((i) => selBuried.has(keyOf(i)));
    if (targets.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    for (const item of targets) {
      try { await api.unburyShow(item.userId, item.showId); ok++; } catch { /* counted below */ }
    }
    setBulkBusy(false);
    setSelBuried(new Set());
    await load();
    if (ok === targets.length) toast.success(`Dug up ${ok} show${ok === 1 ? '' : 's'}`);
    else toast.error(`Dug up ${ok} of ${targets.length} - the rest failed, try them again`);
  };

  // Bulk wipe gets the same two-step arming as a single wipe, with the
  // grand total of episodes named before anything is erased.
  const [bulkWipeArmed, setBulkWipeArmed] = useState(false);
  const wipeBulk = async () => {
    const targets = (buried || []).filter((i) => selBuried.has(keyOf(i)));
    if (targets.length === 0) return;
    if (!bulkWipeArmed) {
      setBulkWipeArmed(true);
      setTimeout(() => setBulkWipeArmed(false), 6000);
      return;
    }
    setBulkWipeArmed(false);
    setBulkBusy(true);
    let ok = 0;
    let episodes = 0;
    for (const item of targets) {
      try {
        const r = await api.wipeBuriedShow(item.userId, item.showId, wipeOnDevice);
        episodes += r.episodesDeleted;
        ok++;
      } catch { /* counted below */ }
    }
    setBulkBusy(false);
    setSelBuried(new Set());
    await load();
    if (ok === targets.length) toast.success(`Wiped ${ok} show${ok === 1 ? '' : 's'} - ${episodes} episode${episodes === 1 ? '' : 's'} of history erased (each undoable for 30 days in the Trash)`);
    else toast.error(`Wiped ${ok} of ${targets.length} - the rest failed, try them again`);
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

  const selBuriedEpisodes = buried.filter((i) => selBuried.has(keyOf(i))).reduce((n, i) => n + (i.episodesWatched || 0), 0);

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-default">Unfinished</h3>
            <p className="text-sm text-muted mt-0.5">
              Started, then not touched in over 45 days. Pick one back up, or bury it.
            </p>
          </div>
          {items.length > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="text-xs text-muted hover:text-default transition-colors"
                onClick={() => setSelUnfinished(selUnfinished.size === items.length ? new Set() : new Set(items.map(keyOf)))}
              >
                {selUnfinished.size === items.length ? 'Select none' : 'Select all'}
              </button>
              {selUnfinished.size > 0 && (
                <Button variant="secondary" size="sm" isLoading={bulkBusy} onClick={buryBulk}>
                  Bury {selUnfinished.size} selected
                </Button>
              )}
            </div>
          )}
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
              const key = keyOf(item);
              return (
                <div key={key} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
                  <SelectionCheckbox checked={selUnfinished.has(key)} onChange={() => toggleSel(setSelUnfinished, key)} />
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
                {buried.length} buried show{buried.length === 1 ? '' : 's'} resting here. Dig one back up any time - or Wipe it to erase its watch history permanently.
              </p>
            </div>
            <span className="text-xs text-muted shrink-0">{graveOpen ? 'Hide' : 'Show'}</span>
          </button>
          {graveOpen && (
            <>
              <label className="flex items-start gap-2 mt-3 text-xs text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={wipeOnDevice}
                  onChange={(e) => toggleWipeOnDevice(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  When wiping, also remove the title from the account&apos;s own library - so it disappears from
                  the device&apos;s home screen too, not just from SlickSync. Skipped automatically for accounts
                  whose library can&apos;t be edited.
                </span>
              </label>
              {buried.length > 1 && (
                <div className="flex flex-wrap items-center justify-end gap-2 mt-3">
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-default transition-colors"
                    onClick={() => { setBulkWipeArmed(false); setSelBuried(selBuried.size === buried.length ? new Set() : new Set(buried.map(keyOf))); }}
                  >
                    {selBuried.size === buried.length ? 'Select none' : 'Select all'}
                  </button>
                  {selBuried.size > 0 && (
                    <>
                      <Button variant="secondary" size="sm" isLoading={bulkBusy && !bulkWipeArmed} onClick={unburyBulk}>
                        Dig up {selBuried.size} selected
                      </Button>
                      <Button variant={bulkWipeArmed ? 'danger' : 'ghost'} size="sm" isLoading={bulkBusy && bulkWipeArmed} onClick={wipeBulk}>
                        {bulkWipeArmed
                          ? (selBuriedEpisodes > 0 ? `Erase ${selBuriedEpisodes} episode${selBuriedEpisodes === 1 ? '' : 's'} across ${selBuried.size} title${selBuried.size === 1 ? '' : 's'} forever?` : `Erase ${selBuried.size} title${selBuried.size === 1 ? '' : 's'} and their watch history forever?`)
                          : `Wipe ${selBuried.size} selected`}
                      </Button>
                    </>
                  )}
                </div>
              )}
              <div className="space-y-2 mt-4">
                {buried.map((item) => {
                  const key = keyOf(item);
                  return (
                    <div key={key} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)', opacity: 0.85 }}>
                      <SelectionCheckbox checked={selBuried.has(key)} onChange={() => toggleSel(setSelBuried, key)} />
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
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          isLoading={working === key}
                          onClick={() => unbury(item)}
                        >
                          Dig up
                        </Button>
                        <Button
                          variant={wipeArmed === key ? 'danger' : 'ghost'}
                          size="sm"
                          isLoading={working === key && wipeArmed === null}
                          onClick={() => wipe(item)}
                        >
                          {wipeArmed === key
                            ? (item.episodesWatched > 0 ? `Erase ${item.episodesWatched} episode${item.episodesWatched === 1 ? '' : 's'} forever?` : 'Erase its watch history forever?')
                            : 'Wipe'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
