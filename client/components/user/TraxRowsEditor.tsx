'use client';

import { useEffect, useState } from 'react';
import { ChevronUpIcon, ChevronDownIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { api, type TraxRow } from '@/lib/api';
import { Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';

/**
 * Which SlickTrax rows this person gets inside Stremio and Nuvio, and in
 * what order - Continue Watching, Watchlist and each Catalog. Saving gives
 * their addon a new address, so their apps pick the change up, and starts a
 * sync for them straight away.
 */
export function TraxRowsEditor({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TraxRow[] | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || rows) return;
    api.getTraxRows(userId)
      .then((v) => { setRows(v.rows); setSaved(JSON.stringify(v.rows)); })
      .catch(() => setRows([]));
  }, [open, rows, userId]);

  const move = (i: number, by: number) => {
    if (!rows) return;
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };
  const toggle = (i: number) => {
    if (!rows) return;
    setRows(rows.map((r, k) => (k === i ? { ...r, hidden: !r.hidden } : r)));
  };

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const v = await api.saveTraxRows(userId, rows.map((r) => r.key), rows.filter((r) => r.hidden).map((r) => r.key));
      setRows(v.rows);
      setSaved(JSON.stringify(v.rows));
      toast.success('Rows saved - their apps update with the sync that just started');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save the rows');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const v = await api.saveTraxRows(userId, [], []);
      setRows(v.rows);
      setSaved(JSON.stringify(v.rows));
      toast.success('Back to every row, in the usual order');
    } catch (e: any) {
      toast.error(e?.message || 'Could not reset the rows');
    } finally {
      setBusy(false);
    }
  };

  const dirty = rows && JSON.stringify(rows) !== saved;
  const shown = rows ? rows.filter((r) => !r.hidden).length : 0;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        {open ? 'Hide rows' : 'Choose rows'}
        <ChevronDownIcon className="w-4 h-4 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-2">
          {!rows ? (
            <p className="text-sm text-muted px-2 py-2">Loading rows…</p>
          ) : (
            <>
              <ol className="flex flex-col gap-1">
                {rows.map((r, i) => (
                  <li key={r.key} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${r.hidden ? 'opacity-50' : 'hover:bg-surface-hover'}`}>
                    <span className="w-5 text-xs text-subtle text-right tabular-nums">{r.hidden ? '' : rows.slice(0, i + 1).filter((x) => !x.hidden).length}</span>
                    <span className={`flex-1 min-w-0 truncate text-sm ${r.hidden ? 'text-muted line-through' : 'text-default'}`}>{r.name}</span>
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || busy} title="Move up" aria-label={`Move ${r.name} up`}
                      className="p-1 rounded-md text-muted hover:text-default hover:bg-surface-hover disabled:opacity-30">
                      <ChevronUpIcon className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1 || busy} title="Move down" aria-label={`Move ${r.name} down`}
                      className="p-1 rounded-md text-muted hover:text-default hover:bg-surface-hover disabled:opacity-30">
                      <ChevronDownIcon className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => toggle(i)} disabled={busy} title={r.hidden ? 'Show this row' : 'Hide this row'} aria-label={`${r.hidden ? 'Show' : 'Hide'} ${r.name}`}
                      className="p-1 rounded-md text-muted hover:text-default hover:bg-surface-hover">
                      {r.hidden ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="flex items-center justify-between gap-3 flex-wrap px-2 pt-3 pb-1">
                <p className="text-xs text-muted">
                  {shown} of {rows.length} rows shown. Stremio and Nuvio on a computer follow this order; Nuvio&apos;s phone app groups rows by movies and shows.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>Reset</Button>
                  <Button variant="primary" size="sm" onClick={save} disabled={!dirty || busy} isLoading={busy}>Save rows</Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
