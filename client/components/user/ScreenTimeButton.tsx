'use client';

// "Daily limit": a screen-time budget for one person - so many minutes a
// day, on the days chosen - with a bell and push alert when they reach it
// (server/utils/screenTime.js). Counted across every app, like Watch Time.
// At the limit it either just alerts, or - chosen per person - also pauses
// their streaming until midnight. Same anchored popup as Devices and Age limit.
//
// The switch at the top is the whole state: on means a limit is saved and
// being watched, off means none is. Every change saves as it is made, so
// there is no separate "Set" step to forget, and the pill on the page says
// which it is at a glance.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ClockIcon, MinusIcon, PlusIcon, BellAlertIcon, PauseCircleIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type ScreenTimeView, type ScreenTimeLimit } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';
import { ActionPill } from '@/components/user/ActionPill';

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MINUTE_PRESETS = [30, 60, 90, 120, 180];
const STEP = 15;
const MAX_MINUTES = 24 * 60;
const DEFAULT_LIMIT = { minutes: 90, days: [] as number[] };
const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: 'Every day', days: [] },
  { label: 'School days', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] },
];
// Long enough that tapping + four times saves once, not four times.
const SAVE_DELAY_MS = 500;

type Limit = ScreenTimeLimit;

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function describeDays(days: number[]): string {
  const preset = DAY_PRESETS.find((p) => p.days.join() === days.join());
  if (preset) return preset.label.toLowerCase();
  return days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(', ');
}

// When a pause ends: quick picks, plus any time.
const BACK_ON_PRESETS = ['00:00', '06:00', '07:00', '08:00'];

/** "midnight" or "7:00 AM" for an "HH:MM". */
function backOnLabel(resumeAt?: string): string {
  if (!resumeAt || resumeAt === '00:00') return 'midnight';
  const [h, m] = resumeAt.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// All seven picked is stored as "every day" - one meaning, one shape.
const normaliseDays = (days: number[]) => (days.length === 7 ? [] : [...days].sort());

export function ScreenTimeButton({ userId, name, onPickGroup }: { userId: string; name: string; onPickGroup?: () => void }) {
  const router = useRouter();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [state, setState] = useState<ScreenTimeView | null>(null);
  // What the controls show. Kept while the limit is off, so switching it
  // back on restores the last settings rather than starting over; the
  // controls themselves only show while it is on.
  const [draft, setDraft] = useState<Limit>(DEFAULT_LIMIT);
  const [saving, setSaving] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read once up front so the pill can show the limit.
  useEffect(() => {
    api.getScreenTime(userId).then((s) => {
      setState(s);
      if (s.limit) setDraft(s.limit);
    }).catch(() => {});
  }, [userId]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 340, panel.current?.scrollHeight);
  };
  const toggleOpen = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  useEffect(() => {
    if (!open) return;
    // Today's minutes move while the popup is closed; re-read on open.
    api.getScreenTime(userId).then(setState).catch(() => {});
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

  const save = async (limit: Limit | null) => {
    setSaving(true);
    try {
      setState(await api.setScreenTime(userId, limit));
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not save the daily limit');
      api.getScreenTime(userId).then(setState).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  const on = !!state?.limit;

  const turn = (next: boolean) => {
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    // Shown straight away; the save confirms it.
    setState((s) => (s ? { ...s, limit: next ? draft : null, appliesToday: next ? s.appliesToday : false } : s));
    save(next ? draft : null);
  };

  // Changes save after a short pause.
  const change = (next: Limit) => {
    setDraft(next);
    if (!on) return;
    setState((s) => (s ? { ...s, limit: next } : s));
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { pending.current = null; save(next); }, SAVE_DELAY_MS);
  };

  const setMinutes = (m: number) => change({ ...draft, minutes: Math.max(STEP, Math.min(MAX_MINUTES, m)) });
  const pickedDays = draft.days.length ? draft.days : ALL_DAYS;
  const toggleDay = (d: number) => {
    const next = pickedDays.includes(d) ? pickedDays.filter((x) => x !== d) : [...pickedDays, d];
    if (!next.length) return; // at least one day; "none" is the switch's job
    change({ ...draft, days: normaliseDays(next) });
  };

  const today = state?.todayMinutes ?? 0;
  const limit = state?.limit;
  const reached = !!limit && state!.appliesToday && today >= limit.minutes;
  const share = limit ? Math.min(1, today / limit.minutes) : 0;

  const paused = !!state?.paused;
  const pausing = limit?.onReach === 'pause';
  const pillLabel = !state ? 'Daily limit' : !limit ? 'Daily limit: off' : paused ? `Paused until ${backOnLabel(limit?.resumeAt)}` : reached ? 'Limit reached today' : `${formatMinutes(limit.minutes)} a day`;

  // Why "Pause streaming" can't be picked for them, as the tile shows it.
  const locked = state?.canPause && !state.canPause.ok
    ? state.canPause.code === 'no-group'
      ? { badge: 'Needs a group', hint: 'Put them in a group first', action: onPickGroup ? 'group' as const : null }
      : state.canPause.code === 'needs-admin'
        ? { badge: 'Needs admin sign-in', hint: 'Add their server’s admin here', action: 'guide' as const }
        : { badge: 'Alert only', hint: 'AIOStreams can’t pause one person', action: null }
    : null;
  const unlock = () => {
    if (locked?.action === 'group' && onPickGroup) { close(); onPickGroup(); }
    if (locked?.action === 'guide') { close(); router.push('/guides/add-jellyfin-account'); }
  };

  const resumeNow = async () => {
    setSaving(true);
    try {
      setState(await api.resumeScreenTime(userId));
      toast.success(`${name} can stream again today`);
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not resume them');
    } finally {
      setSaving(false);
    }
  };

  const chip = (active: boolean) =>
    `px-2.5 py-1 rounded-full border text-xs transition-colors ${active ? 'border-primary bg-primary/15 text-default' : 'border-default text-subtle hover:text-default hover:bg-surface-hover'}`;

  return (
    <>
      <ActionPill ref={button} icon={ClockIcon} open={open} onClick={toggleOpen} tone={!limit ? 'neutral' : reached || paused ? 'warn' : 'on'}>
        {pillLabel}
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`Daily limit for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-4"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-default">Daily limit</p>
                <p className="text-xs text-muted mt-0.5">
                  {limit
                    ? <>On - {pausing ? 'pauses streaming' : 'alerts you'} when {name} passes {formatMinutes(limit.minutes)} {limit.days.length ? `on ${describeDays(limit.days)}` : 'on any day'}.</>
                    : <>Off - {name} has no limit.</>}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={on ? 'Turn the daily limit off' : 'Turn the daily limit on'}
                disabled={!state}
                onClick={() => turn(!on)}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-surface-hover border border-default'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>

            {/* Paused right now - with the way back. */}
            {paused && (
              <div className="rounded-xl px-3 py-2.5 flex items-center justify-between gap-3 border border-warning/40" style={{ background: 'var(--color-warning-muted)' }}>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-warning">Paused until {backOnLabel(limit?.resumeAt)}</p>
                  <p className="text-[11px] text-muted mt-0.5">Nothing new will play for {name} until then.</p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={resumeNow}
                  className="shrink-0 px-2.5 py-1 rounded-full border border-default bg-surface text-[11px] font-medium text-default hover:bg-surface-hover disabled:opacity-50"
                >
                  Resume now
                </button>
              </div>
            )}

            {/* Today, as a bar against the limit when one applies today. */}
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--color-surface-hover)' }}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted">Watched today</span>
                <span className={reached ? 'text-warning font-medium' : 'text-default font-medium'}>
                  {formatMinutes(today)}
                  {limit && state?.appliesToday ? <span className="text-subtle font-normal"> of {formatMinutes(limit.minutes)}</span> : null}
                </span>
              </div>
              {limit && state?.appliesToday && (
                <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-subtle)' }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(share * 100, 2)}%`, background: reached ? 'var(--color-warning)' : 'var(--color-primary)' }}
                  />
                </div>
              )}
              {limit && state && !state.appliesToday && (
                <p className="text-[11px] text-subtle mt-1">No limit today.</p>
              )}
            </div>

            {on && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-muted mb-1.5">When they reach it</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={!pausing}
                    onClick={() => change({ ...draft, onReach: undefined })}
                    className={`flex flex-col items-start gap-1 p-2.5 rounded-xl border text-left transition-colors ${!pausing ? 'border-primary bg-primary/15' : 'border-default hover:bg-surface-hover'}`}
                  >
                    <BellAlertIcon className={`w-4 h-4 ${!pausing ? 'text-primary' : 'text-subtle'}`} />
                    <span className="text-xs font-medium text-default">Tell me</span>
                    <span className="text-[10px] text-subtle leading-tight">Bell and push alert</span>
                  </button>
                  {locked ? (
                    // Can't be chosen for them yet: says why on the tile itself,
                    // and tapping it goes to the fix where there is one.
                    <button
                      type="button"
                      onClick={unlock}
                      aria-label={`Pause streaming - ${locked.badge}. ${state?.canPause.reason || ''}`}
                      className={`flex flex-col items-start gap-1 p-2.5 rounded-xl border border-dashed border-warning/60 text-left transition-colors ${locked.action ? 'hover:bg-warning/10' : 'cursor-default'}`}
                    >
                      <span className="flex w-full items-center justify-between gap-1">
                        <PauseCircleIcon className="w-4 h-4 text-subtle shrink-0" />
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] leading-none text-warning whitespace-nowrap">
                          <LockClosedIcon className="w-2.5 h-2.5" />
                          {locked.badge}
                        </span>
                      </span>
                      <span className="text-xs font-medium text-muted">Pause streaming</span>
                      <span className="text-[10px] text-warning leading-tight">
                        {locked.hint}{locked.action ? ' →' : ''}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-pressed={pausing}
                      onClick={() => change({ ...draft, onReach: 'pause' })}
                      className={`flex flex-col items-start gap-1 p-2.5 rounded-xl border text-left transition-colors ${pausing ? 'border-primary bg-primary/15' : 'border-default hover:bg-surface-hover'}`}
                    >
                      <PauseCircleIcon className={`w-4 h-4 ${pausing ? 'text-primary' : 'text-subtle'}`} />
                      <span className="text-xs font-medium text-default">Pause streaming</span>
                      <span className="text-[10px] text-subtle leading-tight">Until {backOnLabel(draft.resumeAt)}, and tell me</span>
                    </button>
                  )}
                </div>
              </div>

              {/* When a pause ends - midnight unless they'd rather it stayed off
                  until the morning (or came back sooner). */}
              {pausing && (
                <div>
                  <p className="text-xs font-medium text-muted mb-1.5">Back on at</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BACK_ON_PRESETS.map((t) => (
                      <button key={t} type="button" onClick={() => change({ ...draft, resumeAt: t })} aria-pressed={(draft.resumeAt || '00:00') === t} className={chip((draft.resumeAt || '00:00') === t)}>
                        {t === '00:00' ? 'Midnight' : backOnLabel(t).replace(':00', '')}
                      </button>
                    ))}
                    <label className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs cursor-pointer ${BACK_ON_PRESETS.includes(draft.resumeAt || '00:00') ? 'border-default text-subtle' : 'border-primary bg-primary/15 text-default'}`}>
                      <span className="sr-only">Another time</span>
                      <input
                        type="time"
                        value={draft.resumeAt || '00:00'}
                        onChange={(e) => { if (e.target.value) change({ ...draft, resumeAt: e.target.value }); }}
                        className="bg-transparent text-xs text-inherit outline-none cursor-pointer"
                        aria-label="Back on at another time"
                      />
                    </label>
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-muted mb-1.5">How long</p>
                <div className="flex flex-wrap gap-1.5">
                  {MINUTE_PRESETS.map((m) => (
                    <button key={m} type="button" onClick={() => setMinutes(m)} aria-pressed={draft.minutes === m} className={chip(draft.minutes === m)}>
                      {formatMinutes(m)}
                    </button>
                  ))}
                </div>
                <div className="mt-2 inline-flex items-center rounded-full border border-default">
                  <button type="button" onClick={() => setMinutes(draft.minutes - STEP)} aria-label={`${STEP} minutes less`} className="p-1.5 rounded-l-full text-subtle hover:text-default hover:bg-surface-hover">
                    <MinusIcon className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-3 text-xs font-medium text-default tabular-nums min-w-[64px] text-center">{formatMinutes(draft.minutes)}</span>
                  <button type="button" onClick={() => setMinutes(draft.minutes + STEP)} aria-label={`${STEP} minutes more`} className="p-1.5 rounded-r-full text-subtle hover:text-default hover:bg-surface-hover">
                    <PlusIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-muted mb-1.5">Which days</p>
                <div className="flex justify-between gap-1">
                  {WEEKDAY_LETTERS.map((letter, d) => {
                    const picked = pickedDays.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDay(d)}
                        aria-pressed={picked}
                        aria-label={WEEKDAY_NAMES[d]}
                        title={WEEKDAY_NAMES[d]}
                        className={`w-9 h-9 rounded-full border text-xs font-medium transition-colors ${picked ? 'border-primary bg-primary/15 text-default' : 'border-default text-subtle hover:bg-surface-hover'}`}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {DAY_PRESETS.map((p) => (
                    <button key={p.label} type="button" onClick={() => change({ ...draft, days: p.days })} aria-pressed={draft.days.join() === p.days.join()} className={chip(draft.days.join() === p.days.join())}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            )}

            <p className="text-[11px] text-subtle">
              {saving ? 'Saving…'
                : !on ? 'Turn it on to hear when they pass a set time each day - or to pause their streaming then.'
                : pausing ? `Counted in every app. At the limit, what plays streams is switched off until ${backOnLabel(draft.resumeAt)}; what’s already playing carries on. Changes save as you make them.`
                : 'Bell and push alert when they reach it, in any app. Nothing is stopped. Changes save as you make them.'}
            </p>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
