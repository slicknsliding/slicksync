'use client';

import { useEffect, useState } from 'react';
import { api, type WatchTrackingSettings as Settings } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { V2SetRow, V2_SELECT_CLASS } from '@/components/v2/SettingsV2';

const FINISHED_CHOICES = [75, 80, 85, 90, 95, 98];
const UNFINISHED_CHOICES = [14, 30, 45, 60, 90, 180];

/**
 * Where "finished" starts, and how long a started show sits untouched before
 * it is offered on the Unfinished shelf. Account-wide; the history poller
 * picks a change up within a minute.
 */
export function WatchTrackingSettings({ rows = false }: { rows?: boolean } = {}) {
  const [value, setValue] = useState<Settings | null>(null);

  useEffect(() => {
    api.getWatchTrackingSettings().then(setValue).catch(() => {});
  }, []);

  const save = async (patch: Partial<Pick<Settings, 'finishedPercent' | 'unfinishedAfterDays'>>) => {
    if (!value) return;
    setValue({ ...value, ...patch });
    try {
      setValue(await api.saveWatchTrackingSettings(patch));
      toast.success('Saved');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save that');
      api.getWatchTrackingSettings().then(setValue).catch(() => {});
    }
  };

  if (!value) return null;

  // A value set some other way still shows as itself.
  const finished = FINISHED_CHOICES.includes(value.finishedPercent) ? FINISHED_CHOICES : [...FINISHED_CHOICES, value.finishedPercent].sort((a, b) => a - b);
  const unfinished = UNFINISHED_CHOICES.includes(value.unfinishedAfterDays) ? UNFINISHED_CHOICES : [...UNFINISHED_CHOICES, value.unfinishedAfterDays].sort((a, b) => a - b);

  // The v2 page design: the same two choices as short rows in a box.
  if (rows) {
    return (
      <>
        <V2SetRow
          title="Counts as finished at"
          line="How far into a movie or episode it counts as watched rather than stopped part-way. Lower it if your shows have long end credits."
          control={(
            <select aria-label="Counts as finished at" value={value.finishedPercent} onChange={(e) => save({ finishedPercent: Number(e.target.value) })} className={V2_SELECT_CLASS}>
              {finished.map((p) => <option key={p} value={p}>{p}% watched{p === value.defaults.finishedPercent ? ' (default)' : ''}</option>)}
            </select>
          )}
        />
        <V2SetRow
          title="Unfinished shelf after"
          line="How long a started show can go untouched before Activity → Graveyard offers it on the Unfinished shelf."
          control={(
            <select aria-label="Unfinished shelf after" value={value.unfinishedAfterDays} onChange={(e) => save({ unfinishedAfterDays: Number(e.target.value) })} className={V2_SELECT_CLASS}>
              {unfinished.map((d) => <option key={d} value={d}>{d} days untouched{d === value.defaults.unfinishedAfterDays ? ' (default)' : ''}</option>)}
            </select>
          )}
        />
      </>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="p-4 rounded-lg bg-subtle">
        <label className="block text-sm font-medium text-default mb-2" htmlFor="finished-percent">Counts as finished at</label>
        <select
          id="finished-percent"
          value={value.finishedPercent}
          onChange={(e) => save({ finishedPercent: Number(e.target.value) })}
          className="input-base w-full px-3 py-2 text-sm"
        >
          {finished.map((p) => (
            <option key={p} value={p}>{p}% watched{p === value.defaults.finishedPercent ? ' (default)' : ''}</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-2">
          How far into a movie or episode it counts as watched rather than stopped part-way. Lower it if the shows you watch have long end credits.
        </p>
      </div>
      <div className="p-4 rounded-lg bg-subtle">
        <label className="block text-sm font-medium text-default mb-2" htmlFor="unfinished-days">Unfinished shelf after</label>
        <select
          id="unfinished-days"
          value={value.unfinishedAfterDays}
          onChange={(e) => save({ unfinishedAfterDays: Number(e.target.value) })}
          className="input-base w-full px-3 py-2 text-sm"
        >
          {unfinished.map((d) => (
            <option key={d} value={d}>{d} days untouched{d === value.defaults.unfinishedAfterDays ? ' (default)' : ''}</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-2">
          How long a started show can go untouched before Activity &rarr; Graveyard offers it on the Unfinished shelf.
        </p>
      </div>
    </div>
  );
}
