'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/relativeTime';

type Job = { name: string; label: string; ok: boolean; lastRunAt: string; message: string | null };

/** Maintenance -> Background jobs: what SlickSync runs by itself, when each
 *  last ran and whether it went well. Folded every visit; the whole strip is
 *  the button. Not shown where the jobs belong to the whole instance (the
 *  public one). */
export function BackgroundJobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.getBackgroundJobs()
      .then((r) => setJobs(r.available ? r.jobs : null))
      .catch(() => setJobs(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (jobs === null) return null;
  const needLook = jobs.filter((j) => !j.ok).length;
  const summary = jobs.length === 0
    ? 'Nothing has run yet since SlickSync started'
    : needLook > 0
      ? `${needLook} need${needLook === 1 ? 's' : ''} a look`
      : `${jobs.length} running \u00b7 all fine`;

  return (
    <Card padding="none">
      <button
        type="button"
        className="w-full flex items-center gap-3 p-4 md:p-5 text-left"
        aria-expanded={open}
        onClick={() => { if (!open) load(); setOpen((v) => !v); }}
      >
        <span className="job-dot" aria-hidden="true" style={{ background: needLook > 0 ? 'var(--color-warning)' : 'var(--color-success)' }} />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-default">Background jobs</span>
          <span className="block text-xs text-muted mt-0.5">{summary}</span>
        </span>
        <ChevronDownIcon className={`w-5 h-5 text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && jobs.length > 0 && (
        <ul className="border-t border-default">
          {jobs.map((j) => (
            <li key={j.name} className="flex items-center gap-3 px-4 md:px-5 py-3 border-t border-default first:border-t-0">
              <span className="job-dot" aria-hidden="true" style={{ background: j.ok ? 'var(--color-success)' : 'var(--color-warning)' }} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-default">{j.label}</span>
                {!j.ok && j.message && <span className="block text-xs text-muted mt-0.5 break-words">{j.message}</span>}
              </span>
              <span className="text-xs text-muted shrink-0">{formatRelativeTime(j.lastRunAt) ?? 'Not yet'}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
