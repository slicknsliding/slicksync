'use client';

// "Caught up to…": mark an episode and every aired one before it watched for
// one person - in SlickSync's History (never as watch time) and on their
// Jellyfin or AIOStreams server (server/utils/catchUp.js). Same anchored
// popup as Daily limit beside it; long runs report progress as they go.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type CatchUpEpisodes, type CatchUpJob } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

export function CatchUpButton({ userId, name, hasServer }: { userId: string; name: string; hasServer: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [shows, setShows] = useState<{ id: string; name: string }[] | null>(null);
  const [showId, setShowId] = useState('');
  const [typedId, setTypedId] = useState('');
  const [list, setList] = useState<CatchUpEpisodes | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [season, setSeason] = useState<number | null>(null);
  const [episode, setEpisode] = useState<number | null>(null);
  const [job, setJob] = useState<CatchUpJob | null>(null);
  const [starting, setStarting] = useState(false);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 360, panel.current?.scrollHeight);
  };
  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  useEffect(() => {
    if (!open) return;
    if (!shows) api.getCatchUpShows(userId).then((r) => setShows(r.shows)).catch(() => setShows([]));
    api.getCatchUpStatus(userId).then((r) => setJob(r.job)).catch(() => {});
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

  // Progress while a run is going.
  useEffect(() => {
    if (job?.state !== 'running') return;
    const t = setInterval(() => {
      api.getCatchUpStatus(userId).then((r) => {
        setJob(r.job);
        if (r.job && r.job.state !== 'running') {
          if (r.job.state === 'failed') toast.error(r.job.error || 'Could not finish');
          else toast.success(`${name} is caught up on ${r.job.show} to ${r.job.upTo}`);
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [job?.state, userId, name]);

  const loadEpisodes = async (id: string) => {
    if (!id) return;
    setShowId(id);
    setList(null);
    setSeason(null);
    setEpisode(null);
    setLoadingList(true);
    try {
      const l = await api.getCatchUpEpisodes(userId, id);
      setList(l);
      // Start from the first episode they haven't watched.
      const next = l.episodes.find((e) => !e.watched) || l.episodes[l.episodes.length - 1];
      if (next) { setSeason(next.season); setEpisode(next.episode); }
    } catch (e: any) {
      toast.error(e?.message || 'Could not find that show');
    } finally {
      setLoadingList(false);
    }
  };

  const seasons = useMemo(() => [...new Set((list?.episodes || []).map((e) => e.season))], [list]);
  const inSeason = useMemo(() => (list?.episodes || []).filter((e) => e.season === season), [list, season]);

  const startRun = async () => {
    if (!list || season == null || episode == null) return;
    setStarting(true);
    try {
      setJob(await api.startCatchUp(userId, list.showId, season, episode));
    } catch (e: any) {
      toast.error(e?.message || 'Could not mark them caught up');
    } finally {
      setStarting(false);
    }
  };

  const running = job?.state === 'running';

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs text-subtle hover:text-default hover:bg-surface-hover transition-colors"
      >
        <CheckCircleIcon className="w-3.5 h-3.5" />
        Caught up to…
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`Mark ${name} caught up`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Caught up to…</p>
              <p className="text-xs text-muted mt-0.5">
                Marks an episode and every aired one before it as watched for {name}{hasServer ? ', here and on their server' : ''}. It isn’t counted as watch time.
              </p>
            </div>

            {job && (
              <div className="rounded-xl px-3 py-2 text-xs space-y-0.5" style={{ background: 'var(--color-surface-hover)' }}>
                <p className="text-default">{job.show} to {job.upTo}{job.state === 'running' ? ' - marking…' : job.state === 'failed' ? ' - stopped' : ' - done'}</p>
                <p className="text-subtle">Here: {job.recorded + job.alreadyWatched} of {job.total}{job.alreadyWatched ? ` (${job.alreadyWatched} were already watched)` : ''}</p>
                {job.server && (
                  <p className="text-subtle">
                    On their server: {job.server.state === 'not-there' ? 'the show isn’t on it'
                      : job.server.state === 'failed' ? (job.server.error || 'failed')
                      : job.server.how === 'played-up-to' ? `${job.server.marked} marked in one go`
                      : job.server.total == null ? 'waiting…'
                      : `${job.server.marked} of ${job.server.total}`}
                  </p>
                )}
                {job.error && <p className="text-error">{job.error}</p>}
              </div>
            )}

            {!running && (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted">Show</p>
                  {shows === null ? (
                    <div className="h-8 rounded-lg bg-surface-hover animate-pulse" />
                  ) : (
                    <select
                      value={showId}
                      onChange={(e) => loadEpisodes(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                    >
                      <option value="">{shows.length ? 'Pick one they watch' : 'Nothing watched yet - type an IMDb id below'}</option>
                      {shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                  <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (typedId.trim()) loadEpisodes(typedId.trim()); }}>
                    <input
                      value={typedId}
                      onChange={(e) => setTypedId(e.target.value)}
                      placeholder="or an IMDb id - tt0903747"
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                    />
                    <button type="submit" className="px-2.5 py-1.5 rounded-lg text-xs border border-default text-default hover:bg-surface-hover">Find</button>
                  </form>
                </div>

                {loadingList && <div className="h-16 rounded-xl bg-surface-hover animate-pulse" />}

                {list && (
                  <div className="space-y-2">
                    <p className="text-xs text-default font-medium">{list.name || list.showId}</p>
                    <div className="flex gap-1.5">
                      <select
                        value={season ?? ''}
                        onChange={(e) => { const s = Number(e.target.value); setSeason(s); setEpisode(list.episodes.find((x) => x.season === s)?.episode ?? null); }}
                        className="px-2 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                        aria-label="Season"
                      >
                        {seasons.map((s) => <option key={s} value={s}>Season {s}</option>)}
                      </select>
                      <select
                        value={episode ?? ''}
                        onChange={(e) => setEpisode(Number(e.target.value))}
                        className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-xs border border-default bg-surface-hover text-default"
                        aria-label="Episode"
                      >
                        {inSeason.map((e) => (
                          <option key={e.episode} value={e.episode}>
                            {e.episode}. {e.title || `Episode ${e.episode}`}{e.watched ? ' ✓' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      disabled={starting || season == null || episode == null}
                      onClick={startRun}
                      className="px-3 py-1.5 rounded-lg text-xs border border-primary bg-primary/10 text-default disabled:opacity-50"
                    >
                      Mark caught up to S{season}E{episode}
                    </button>
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
