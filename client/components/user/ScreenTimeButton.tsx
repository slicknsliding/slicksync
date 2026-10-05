'use client';

// "Daily limit": a screen-time budget for one person - so many minutes a
// day, on the days chosen - with a bell and push alert when they reach it
// (server/utils/screenTime.js). Counted across every app, like Watch Time.
// Alert only. Same anchored popup as Devices and Age limit.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClockIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type ScreenTimeView } from '@/lib/api';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MINUTE_PRESETS = [30, 60, 90, 120, 180];
const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: 'Every day', days: [] },
  { label: 'School days', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] },
];

function describe(limit: { minutes: number; days: number[] }): string {
  const preset = DAY_PRESETS.find((p) => p.days.join() === limit.days.join());
  const days = preset ? preset.label.toLowerCase() : limit.days.map((d) => WEEKDAY_LABELS[d]).join(', ');
  return `${limit.minutes} min · ${days}`;
}

export function ScreenTimeButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const [state, setState] = useState<ScreenTimeView | null>(null);
  const [minutes, setMinutes] = useState<number>(90);
  const [days, setDays] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  // Read once up front so the pill can show the limit.
  useEffect(() => {
    api.getScreenTime(userId).then((s) => {
      setState(s);
      if (s.limit) { setMinutes(s.limit.minutes); setDays(s.limit.days); }
    }).catch(() => {});
  }, [userId]);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    const width = Math.min(340, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
    return { top: r.bottom + 8, left, width };
  };
  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onMove = () => { const at = place(); if (at) setAnchor(at); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const save = async (limit: { minutes: number; days: number[] } | null) => {
    setSaving(true);
    try {
      const next = await api.setScreenTime(userId, limit);
      setState(next);
      toast.success(limit ? `${name}: ${describe(limit)}` : `${name} has no daily limit`);
      if (!limit) close();
    } catch (e: any) {
      toast.error(e?.message || 'Could not set the daily limit');
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs text-subtle hover:text-default hover:bg-surface-hover transition-colors"
      >
        <ClockIcon className="w-3.5 h-3.5" />
        {state?.limit ? describe(state.limit) : 'Daily limit'}
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            role="dialog"
            aria-label={`Daily limit for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Daily limit for {name}</p>
              <p className="text-xs text-muted mt-0.5">
                You get a notification when they reach it, in any app.
                {state ? ` Watched today: ${state.todayMinutes} min.` : ''}
              </p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted mb-1.5">Minutes a day</p>
              <div className="flex flex-wrap gap-1.5 items-center">
                {MINUTE_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMinutes(m)}
                    aria-pressed={minutes === m}
                    className={`px-2.5 py-1 rounded-lg border text-xs ${minutes === m ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover'}`}
                  >
                    {m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
                  className="w-20 px-2 py-1 rounded-lg text-xs border border-default bg-surface-hover text-default"
                  aria-label="Minutes a day"
                />
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted mb-1.5">On</p>
              <div className="flex flex-wrap gap-1.5">
                {DAY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setDays(p.days)}
                    aria-pressed={days.join() === p.days.join()}
                    className={`px-2.5 py-1 rounded-lg border text-xs ${days.join() === p.days.join() ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {WEEKDAY_LABELS.map((label, d) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleDay(d)}
                    aria-pressed={days.includes(d)}
                    className={`px-2 py-0.5 rounded-md border text-[11px] ${days.includes(d) ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-subtle">
              Counted like Watch Time. Stremio and Nuvio only report at pause or stop, so the alert can come a little late - never early. It doesn’t stop anything playing.
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => save({ minutes, days })}
                className="px-3 py-1.5 rounded-lg text-xs border border-primary bg-primary/10 text-default disabled:opacity-50"
              >
                {state?.limit ? 'Update' : 'Set limit'}
              </button>
              {state?.limit && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save(null)}
                  className="px-3 py-1.5 rounded-lg text-xs border border-default text-subtle hover:bg-surface-hover disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
