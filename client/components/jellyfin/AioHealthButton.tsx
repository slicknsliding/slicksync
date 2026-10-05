'use client';

// "AIOStreams health": what AIOStreams itself says about this person's
// configuration - which addons it sees failing, coming back empty, slow or
// redundant (its own words), and which apps use it - plus a one-off "test
// this title" search (server/utils/aioHealth.js). Same anchored popup as
// Devices and Age limit beside it. Read-only.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HeartIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type AioHealth, type AioTestSearch } from '@/lib/api';

export function AioHealthButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [state, setState] = useState<AioHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testId, setTestId] = useState('');
  const [testType, setTestType] = useState<'movie' | 'series'>('movie');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ label: string; data: AioTestSearch } | null>(null);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    const width = Math.min(380, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
    return { top: r.bottom + 8, left, width };
  };
  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };

  // Read when opened (and when the range changes) - it asks AIOStreams.
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getAioHealth(userId, range).then(setState).catch((e: any) => setError(e?.message || 'Could not read AIOStreams'));
  }, [open, range, userId]);

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

  const runTest = async (type: 'movie' | 'series', id: string, label: string) => {
    setTesting(true);
    setResult(null);
    try {
      setResult({ label, data: await api.runAioTestSearch(userId, type, id) });
    } catch (e: any) {
      toast.error(e?.message || 'Could not run the search');
    } finally {
      setTesting(false);
    }
  };

  const a = state?.analytics;

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs text-subtle hover:text-default hover:bg-surface-hover transition-colors"
      >
        <HeartIcon className="w-3.5 h-3.5" />
        AIOStreams health
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            role="dialog"
            aria-label={`AIOStreams health for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3 max-h-[75vh] overflow-y-auto"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">AIOStreams health for {name}</p>
              <p className="text-xs text-muted mt-0.5">What AIOStreams itself reports about their configuration.</p>
            </div>

            {error ? (
              <p className="text-xs text-error">{error}</p>
            ) : !state ? (
              <div className="h-24 rounded-xl bg-surface-hover animate-pulse" />
            ) : !state.canRead ? (
              <p className="text-xs text-default">{state.reason}</p>
            ) : (
              <>
                {/* Addons, as AIOStreams sees them. */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-default">Addons</p>
                    {state.analyticsEnabled && (
                      <div className="flex gap-1">
                        {(['24h', '7d'] as const).map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() => setRange(r)}
                            aria-pressed={range === r}
                            className={`px-2 py-0.5 rounded-md border text-[11px] ${range === r ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover'}`}
                          >
                            {r === '24h' ? 'Last day' : 'Last week'}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {!state.analyticsEnabled ? (
                    <p className="text-xs text-subtle">This AIOStreams doesn’t share per-addon stats - its owner has user analytics turned off. A test search below still shows what each addon finds.</p>
                  ) : state.analyticsError ? (
                    <p className="text-xs text-error">{state.analyticsError}</p>
                  ) : !a || a.addons.length === 0 ? (
                    <p className="text-xs text-subtle">Nothing searched through it in this time yet.</p>
                  ) : (
                    <>
                      <p className="text-xs text-subtle">{a.requests} search{a.requests === 1 ? '' : 'es'} · {a.errorRate}% failed</p>
                      <div className="space-y-1.5">
                        {a.addons.map((x) => (
                          <div key={`${x.name}-${x.preset}`} className="flex items-start justify-between gap-2 text-xs">
                            <div className="min-w-0">
                              <p className="text-default truncate">{x.name}</p>
                              <p className="text-subtle">
                                {x.requests} searches · {x.errorRate}% errors · {x.emptyRate}% empty{x.avgLatencyMs != null ? ` · ${(x.avgLatencyMs / 1000).toFixed(1)}s` : ''}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end flex-shrink-0">
                              {x.errorRate >= 20 && <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-error/15 text-error">Failing</span>}
                              {x.slow && <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-warning/15 text-warning" title="AIOStreams’ own label: cut off for taking too long on many searches">Slow</span>}
                              {x.redundant && <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-surface-hover text-subtle" title="AIOStreams’ own label: its results are almost always cut or duplicated by other addons">Redundant</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-subtle">Slow and Redundant are AIOStreams’ own labels.</p>
                    </>
                  )}
                </div>

                {(state.apps?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-default mb-1">Apps using it</p>
                    <p className="text-xs text-subtle">{state.apps!.map((x) => x.name).join(' · ')}</p>
                  </div>
                )}

                {/* A real search through every addon and debrid service. */}
                {state.searchAvailable !== false && (
                  <div className="space-y-2 pt-2 border-t border-default">
                    <p className="text-xs font-semibold text-default">Test a title</p>
                    <p className="text-[11px] text-subtle">Searches every addon and debrid service the way playing would - one at a time.</p>
                    {(state.recent?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {state.recent!.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            disabled={testing}
                            onClick={() => runTest(t.type, t.id, t.name)}
                            className="px-2.5 py-1 rounded-lg border border-default text-xs text-subtle hover:bg-surface-hover hover:text-default disabled:opacity-50"
                          >
                            {t.name}
                          </button>
                        ))}
                      </div>
                    )}
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => { e.preventDefault(); if (testId.trim()) runTest(testType, testId.trim(), testId.trim()); }}
                    >
                      <select
                        value={testType}
                        onChange={(e) => setTestType(e.target.value === 'series' ? 'series' : 'movie')}
                        className="px-2 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                      >
                        <option value="movie">Film</option>
                        <option value="series">Episode</option>
                      </select>
                      <input
                        value={testId}
                        onChange={(e) => setTestId(e.target.value)}
                        placeholder={testType === 'series' ? 'tt0903747:1:1' : 'tt0133093'}
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                      />
                      <button type="submit" disabled={testing || !testId.trim()} className="px-2.5 py-1.5 rounded-lg text-xs border border-default text-default hover:bg-surface-hover disabled:opacity-50">
                        {testing ? 'Searching…' : 'Test'}
                      </button>
                    </form>
                    {testing && <div className="h-10 rounded-xl bg-surface-hover animate-pulse" />}
                    {result && (
                      <div className="space-y-1 text-xs">
                        <p className="text-default">
                          {result.label}: {result.data.streams === 0 ? 'nothing found' : `${result.data.streams} stream${result.data.streams === 1 ? '' : 's'}`}
                          {result.data.streams > 0 ? ` · ${result.data.cached} cached` : ''}
                          {result.data.usenet > 0 ? ` · ${result.data.usenet} usenet` : ''}
                          <span className="text-subtle"> · {(result.data.tookMs / 1000).toFixed(1)}s</span>
                        </p>
                        {result.data.addons.map((x) => (
                          <p key={x.name} className="text-subtle">{x.name}: {x.streams}{x.cached ? ` (${x.cached} cached)` : ''}</p>
                        ))}
                        {result.data.errors.map((e, i) => (
                          <p key={i} className="text-error">{e.title}{e.description ? ` - ${e.description}` : ''}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
