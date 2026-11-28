'use client';

// "What Sync All will change": a small pop-up right under the Sync All button
// that lists each person whose sync would change something ("+2 addons, −1"),
// says how many others have nothing to change, and only then lets the sync
// run. It asks the same /users/:id/sync-plan the per-person preview uses, three
// people at a time, so it can never disagree with what a sync really does.
//
// Only people with an addon list (Stremio and Nuvio sign-ins) have a plan.
// Jellyfin and AIOStreams sign-ins have none to preview; Sync All still syncs
// them as it always did, and the pop-up says so in one line.
// Turned on and off in Themes → Layout ("Preview before Sync All").

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';

export type SyncAllPerson = { id: string; name: string; hasAddons: boolean };

type Plan = { current: { transportUrl: string }[]; desired: { transportUrl: string }[] };
type Row = { id: string; name: string; words: string };

const CONCURRENCY = 3;

/** What a plan would do, in the short words the list uses; '' when nothing. */
export function planWords(plan: Plan): string {
  const cur = new Set(plan.current.map((a) => a.transportUrl));
  const des = new Set(plan.desired.map((a) => a.transportUrl));
  const added = plan.desired.filter((a) => !cur.has(a.transportUrl)).length;
  const removed = plan.current.filter((a) => !des.has(a.transportUrl)).length;
  // Same set on both sides but another order = a reorder only.
  const keptCur = plan.current.filter((a) => des.has(a.transportUrl)).map((a) => a.transportUrl);
  const keptDes = plan.desired.filter((a) => cur.has(a.transportUrl)).map((a) => a.transportUrl);
  const reordered = keptCur.length === keptDes.length && keptCur.some((u, i) => u !== keptDes[i]);
  const parts: string[] = [];
  if (added) parts.push(`+${added} addon${added === 1 ? '' : 's'}`);
  if (removed) parts.push(added ? `−${removed}` : `−${removed} addon${removed === 1 ? '' : 's'}`);
  if (reordered) parts.push('new order');
  const out = parts.join(', ');
  return out ? out[0].toUpperCase() + out.slice(1) : '';
}

type Result = { changed: Row[]; failed: Row[]; same: number } | null;

export function SyncAllPreview({ anchorRef, people: shown, onClose, onSync }: {
  /** The Sync All button. */
  anchorRef: React.RefObject<HTMLElement | null>;
  people: SyncAllPerson[];
  onClose: () => void;
  /** Runs the sync for these people (the ones that would change, can't be checked, or have no addon list to check). */
  onSync: (ids: string[]) => void;
}) {
  // Who it checks is fixed when it opens: a refresh of the list underneath must not restart it.
  const [people] = useState(shown);
  const [result, setResult] = useState<Result>(null);
  const [checked, setChecked] = useState(0);
  const checkable = useMemo(() => people.filter((p) => p.hasAddons), [people]);
  const unchecked = useMemo(() => people.filter((p) => !p.hasAddons), [people]);

  // Gathered once per opening: the page mounts this only while it is open.
  useEffect(() => {
    let cancelled = false;
    const changed: Row[] = [];
    const failed: Row[] = [];
    let same = 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (!cancelled) {
        const p = checkable[next++];
        if (!p) return;
        try {
          const words = planWords(await api.getUserSyncPlan(p.id));
          if (words) changed.push({ id: p.id, name: p.name, words }); else same++;
        } catch {
          failed.push({ id: p.id, name: p.name, words: 'Couldn’t check' });
        }
        done++;
        if (!cancelled) setChecked(done);
      }
    };
    Promise.all(Array.from({ length: Math.min(CONCURRENCY, checkable.length) }, worker)).then(() => {
      if (cancelled) return;
      const order = new Map(checkable.map((p, i) => [p.id, i]));
      const byList = (a: Row, b: Row) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
      setResult({ changed: changed.sort(byList), failed: failed.sort(byList), same });
    });
    return () => { cancelled = true; };
  }, [checkable]);

  const toRun = result ? [...result.changed, ...result.failed].map((r) => r.id).concat(unchecked.map((p) => p.id)) : [];
  const all = result && toRun.length === 0;

  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onClose} width={360} align="start" label="What Sync All will change" caret closeButton={false}>
      <div onClick={(e) => e.stopPropagation()}>
        <div className="pop-row"><b className="text-default">{all ? 'Everyone is already in sync' : 'What Sync All will change'}</b></div>
        {!result && (
          <div className="pop-row text-muted" role="status">Checking {checkable.length === 1 ? '1 person' : `${checked} of ${checkable.length} people`}…</div>
        )}
        {result && (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {[...result.changed, ...result.failed].map((r) => (
              <div key={r.id} className="pop-row"><span className="text-default">{r.name}</span><small>{r.words}</small></div>
            ))}
            {result.same > 0 && !all && (
              <div className="pop-row text-muted"><span>{result.same} {result.same === 1 ? 'other' : 'others'}</span><small>Nothing to change</small></div>
            )}
            {unchecked.length > 0 && (
              <div className="pop-row text-muted"><span>{unchecked.length} on Jellyfin or AIOStreams</span><small>Synced as usual</small></div>
            )}
          </div>
        )}
        <div className="flex gap-2 justify-end mt-2">
          {all ? (
            <button type="button" className="v2-btn v2-btn-main" onClick={onClose}>OK</button>
          ) : (
            <>
              <button type="button" className="v2-btn" onClick={onClose}>Not now</button>
              {result && (
                <button type="button" className="v2-btn v2-btn-main" onClick={() => onSync(toRun)}>
                  {toRun.length === 1 ? 'Sync 1 person' : `Sync ${toRun.length} people`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </AnchoredPopup>
  );
}
