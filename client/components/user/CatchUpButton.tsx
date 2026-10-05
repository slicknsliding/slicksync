'use client';

// "Caught up to…": mark an episode and every aired one before it watched for
// one person - in SlickSync's History (never as watch time) and on their
// Jellyfin or AIOStreams server (server/utils/catchUp.js). Same anchored
// popup as Daily limit beside it; long runs report progress as they go.
//
// Three steps in one popup: pick the show (poster tiles of what they watch,
// or a title search), tap the last episode they have seen in a grid that
// shades everything that will be marked, then watch it run. A run can be
// undone afterwards, and tapping a ticked episode offers to un-tick it.
// Every opening starts again from the show picker.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircleIcon, ChevronLeftIcon, MagnifyingGlassIcon, CheckIcon, TvIcon, ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type CatchUpEpisodes, type CatchUpJob, type CatchUpShow } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';
import { posterUrl } from '@/lib/posterUrl';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { ActionPill } from '@/components/user/ActionPill';

type Picked = { id: string; name: string | null; poster: string | null };
type Episode = CatchUpEpisodes['episodes'][number];

const SEARCH_DELAY_MS = 350;
// A finished run's card clears itself after this long unless Done or Undo
// is pressed first (hovering it holds the count).
const CLEAR_AFTER_SECONDS = 5;

const upTo = (season: number, episode: number) => (e: { season: number; episode: number }) =>
  e.season < season || (e.season === season && e.episode <= episode);
const isAired = (e: Episode, now: number) => !e.released || Number.isNaN(Date.parse(e.released)) || Date.parse(e.released) <= now;

function Poster({ item, className }: { item: { id: string; poster: string | null }; className: string }) {
  const { rpdbEnabled } = usePersonalFeatures();
  const src = posterUrl(item, rpdbEnabled);
  const [failed, setFailed] = useState(false);
  return (
    <div className={`overflow-hidden bg-surface-hover border border-default flex items-center justify-center ${className}`}>
      {src && !failed
        ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" onError={() => setFailed(true)} />
        : <TvIcon className="w-1/3 h-1/3 text-subtle" />}
    </div>
  );
}

export function CatchUpButton({ userId, name, hasServer }: { userId: string; name: string; hasServer: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [shows, setShows] = useState<CatchUpShow[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Picked[] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [list, setList] = useState<CatchUpEpisodes | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [target, setTarget] = useState<{ season: number; episode: number } | null>(null);
  const [job, setJob] = useState<CatchUpJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [holding, setHolding] = useState(false);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 360, panel.current?.scrollHeight);
  };
  // Back to the show picker, as on a first opening.
  const reset = () => {
    setQuery('');
    setResults(null);
    setPicked(null);
    setList(null);
    setListError(null);
    setSeason(null);
    setTarget(null);
  };
  const toggle = () => {
    if (open) { close(); return; }
    reset();
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  useEffect(() => {
    if (!open) return;
    // Re-read each time: a run since the last opening changes what they're on.
    api.getCatchUpShows(userId).then((r) => setShows(r.shows)).catch(() => setShows((s) => s || []));
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

  // Title search (Cinemeta, the same search as Discover), after a pause in typing.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.discoverSearch('series', q).then((items) => {
        if (live) setResults(items.slice(0, 8).map((i) => ({ id: i.id, name: i.name, poster: i.poster })));
      });
    }, SEARCH_DELAY_MS);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  // Progress while a run (or its undo) is going.
  useEffect(() => {
    if (job?.state !== 'running' && job?.state !== 'undoing') return;
    const t = setInterval(() => {
      api.getCatchUpStatus(userId).then((r) => {
        setJob(r.job);
        if (r.job && r.job.state !== 'running' && r.job.state !== 'undoing') {
          if (r.job.state === 'failed') toast.error(r.job.error || 'Could not finish');
          else if (r.job.state === 'undone') toast.success(`Undone - ${r.job.show} is back how it was for ${name}`);
          else toast.success(`${name} is caught up on ${r.job.show} to ${r.job.upTo}`);
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [job?.state, userId, name]);

  // Done, or the countdown reaching 0: the card goes, here and on the
  // server, so it doesn't come back at the next opening.
  const dismissJob = () => {
    setJob(null);
    setSecondsLeft(null);
    api.dismissCatchUp(userId).catch(() => {});
  };

  // Count down while a finished run's card is on screen; a fresh count for
  // each finish (a run, then its undo).
  const finished = !!job && (job.state === 'done' || job.state === 'undone');
  useEffect(() => {
    setSecondsLeft(open && finished ? CLEAR_AFTER_SECONDS : null);
  }, [open, finished, job?.state, job?.startedAt]);
  useEffect(() => {
    if (secondsLeft == null || holding || busy) return;
    // "0s" shows for a beat before the card goes, so the count visibly ends.
    const t = secondsLeft <= 0
      ? setTimeout(dismissJob, 400)
      : setTimeout(() => setSecondsLeft((n) => (n == null ? n : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft, holding, busy]);

  const pick = async (show: Picked) => {
    setPicked(show);
    setList(null);
    setListError(null);
    setTarget(null);
    setSeason(null);
    try {
      const l = await api.getCatchUpEpisodes(userId, show.id);
      setList(l);
      // Open on the season of the first episode they haven't watched.
      const now = Date.now();
      const next = l.episodes.find((e) => !e.watched && isAired(e, now)) || l.episodes[l.episodes.length - 1];
      setSeason(next?.season ?? null);
    } catch (e) {
      setListError((e as Error)?.message || 'Could not find that show’s episodes');
    }
  };

  const now = Date.now();
  const seasons = useMemo(() => [...new Set((list?.episodes || []).map((e) => e.season))], [list]);
  const inSeason = useMemo(() => (list?.episodes || []).filter((e) => e.season === season), [list, season]);
  const watchedCount = useMemo(() => (list?.episodes || []).filter((e) => e.watched).length, [list]);
  const seasonDone = (s: number) => (list?.episodes || []).filter((e) => e.season === s && isAired(e, now)).every((e) => e.watched);
  const toMark = useMemo(
    () => (list && target ? list.episodes.filter(upTo(target.season, target.episode)).filter((e) => !e.watched && isAired(e, Date.now())) : []),
    [list, target],
  );
  const targetEpisode = target ? list?.episodes.find((e) => e.season === target.season && e.episode === target.episode) : null;

  const startRun = async () => {
    if (!list || !target) return;
    setBusy(true);
    try {
      setJob(await api.startCatchUp(userId, list.showId, target.season, target.episode));
      reset();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not mark them caught up');
    } finally {
      setBusy(false);
    }
  };

  const undoRun = async () => {
    setBusy(true);
    try {
      const r = await api.undoCatchUp(userId);
      setJob(r.job);
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not undo that');
    } finally {
      setBusy(false);
    }
  };

  const unmarkTarget = async () => {
    if (!list || !targetEpisode) return;
    const { season: s, episode: ep } = targetEpisode;
    setBusy(true);
    try {
      const r = await api.unmarkEpisode(userId, list.showId, s, ep);
      setList({ ...list, episodes: list.episodes.map((e) => (e.season === s && e.episode === ep ? { ...e, watched: false } : e)) });
      toast.success(`S${s}E${ep} is no longer watched${r.server === 'done' ? ' here or on their server' : ''}`);
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not mark it not watched');
    } finally {
      setBusy(false);
    }
  };

  const working = job?.state === 'running' || job?.state === 'undoing';
  const jobDone = job ? job.recorded + job.alreadyWatched : 0;

  const episodeStyle = (e: Episode) => {
    const isTarget = target && e.season === target.season && e.episode === target.episode;
    const willMark = target && !e.watched && isAired(e, now) && upTo(target.season, target.episode)(e);
    if (isTarget) return e.watched ? 'bg-success/25 border-success text-success ring-2 ring-success/40' : 'bg-primary border-primary text-white font-semibold';
    if (willMark) return 'bg-primary/20 border-primary/40 text-default';
    if (e.watched) return 'bg-success/15 border-transparent text-success hover:border-success/50';
    return 'border-default text-muted hover:bg-surface-hover hover:text-default';
  };

  const jobLabel = !job ? '' : job.state === 'running' ? 'Marking…'
    : job.state === 'undoing' ? 'Undoing…'
    : job.state === 'undone' ? 'Undone'
    : job.state === 'failed' ? 'Stopped' : 'Marked';

  return (
    <>
      <ActionPill ref={button} icon={CheckCircleIcon} open={open} onClick={toggle} tone={working ? 'on' : 'neutral'}>
        {job?.state === 'running' ? 'Marking…' : job?.state === 'undoing' ? 'Undoing…' : 'Caught up to…'}
      </ActionPill>
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
            {/* The last or current run, with Undo while it can be taken back. */}
            {job && !picked && (
              <div
                className="rounded-xl px-3 py-2.5 space-y-1.5"
                style={{ background: 'var(--color-surface-hover)' }}
                onMouseEnter={() => setHolding(true)}
                onMouseLeave={() => setHolding(false)}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-default font-medium truncate">{job.show} · up to {job.upTo}</span>
                  <span className={`shrink-0 ${job.state === 'failed' ? 'text-error' : job.state === 'done' ? 'text-success' : 'text-muted'}`}>
                    {jobLabel}
                  </span>
                </div>
                {job.state !== 'undone' && (
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-subtle)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${job.total ? Math.max((jobDone / job.total) * 100, 2) : 100}%`, background: job.state === 'failed' ? 'var(--color-error)' : 'var(--color-primary)' }} />
                  </div>
                )}
                <div className="flex items-end justify-between gap-2">
                  <p className="text-[11px] text-subtle">
                    {job.state === 'undone'
                      ? 'What it marked is back to not watched.'
                      : <>
                          {jobDone} of {job.total} in History{job.alreadyWatched ? ` (${job.alreadyWatched} already there)` : ''}
                          {job.server && (
                            <> · their server: {job.server.state === 'not-there' ? 'show isn’t on it'
                              : job.server.state === 'failed' ? (job.server.error || 'failed')
                              : job.server.how === 'played-up-to' ? `${job.server.marked} marked`
                              : job.server.total == null ? 'waiting…'
                              : `${job.server.marked} of ${job.server.total}`}</>
                          )}
                        </>}
                  </p>
                  {!working && (
                    <div className="shrink-0 flex items-center gap-1.5">
                      {job.canUndo && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={undoRun}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-default text-[11px] text-default hover:bg-surface disabled:opacity-50"
                        >
                          <ArrowUturnLeftIcon className="w-3 h-3" />
                          Undo
                        </button>
                      )}
                      {/* Clears the card now; on its own it goes when the
                          count inside reaches 0. */}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={dismissJob}
                        aria-label={secondsLeft != null ? `Done - clears in ${secondsLeft} seconds` : 'Done'}
                        className="inline-flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full border border-success/40 bg-success/10 text-[11px] font-medium text-success hover:bg-success/20 disabled:opacity-50 transition-colors"
                      >
                        <CheckIcon className="w-3 h-3" />
                        Done
                        {secondsLeft != null && (
                          <span className="ml-0.5 min-w-[1.25rem] text-right font-normal tabular-nums text-subtle">{secondsLeft}s</span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
                {job.error && <p className="text-[11px] text-error">{job.error}</p>}
              </div>
            )}

            {!working && !picked && (
              <>
                <div>
                  <p className="text-sm font-semibold text-default">Caught up to…</p>
                  <p className="text-xs text-muted mt-0.5">Pick a show, then the last episode {name} has seen.</p>
                </div>
                <div className="relative">
                  <MagnifyingGlassIcon className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search for a show"
                    className="w-full pl-8 pr-2.5 py-2 rounded-xl text-xs border border-default bg-surface-hover text-default"
                    aria-label="Search for a show"
                  />
                </div>

                {query.trim().length >= 2 ? (
                  <div className="max-h-[300px] overflow-y-auto -mx-1 px-1 space-y-1">
                    {results === null ? (
                      [0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-surface-hover animate-pulse" />)
                    ) : results.length === 0 ? (
                      <p className="text-xs text-muted py-3 text-center">No shows match that.</p>
                    ) : results.map((r) => (
                      <button key={r.id} type="button" onClick={() => pick(r)} className="w-full flex items-center gap-3 p-1.5 rounded-xl text-left hover:bg-surface-hover transition-colors">
                        <Poster item={r} className="w-9 h-[54px] rounded-md shrink-0" />
                        <span className="text-xs text-default line-clamp-2">{r.name}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div>
                    <p className="text-xs font-medium text-muted mb-1.5">{name} is watching</p>
                    {shows === null ? (
                      <div className="grid grid-cols-4 gap-2">
                        {[0, 1, 2, 3].map((i) => <div key={i} className="aspect-[2/3] rounded-lg bg-surface-hover animate-pulse" />)}
                      </div>
                    ) : shows.length === 0 ? (
                      <p className="text-xs text-muted py-2">No shows in their History yet - search for one above.</p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto -mx-1 px-1 pb-1">
                        {shows.map((s) => (
                          <button key={s.id} type="button" onClick={() => pick(s)} className="text-left group" title={s.name || s.id}>
                            <Poster item={s} className="aspect-[2/3] rounded-lg group-hover:border-primary transition-colors" />
                            <p className="mt-1 text-[11px] text-default leading-tight line-clamp-1">{s.name || s.id}</p>
                            {s.last && <p className="text-[10px] text-subtle">Last S{s.last.season}E{s.last.episode}</p>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {!working && picked && (
              <>
                <div className="flex items-center gap-2.5">
                  <button type="button" onClick={reset} aria-label="Back to shows" className="p-1 -ml-1 rounded-lg text-subtle hover:text-default hover:bg-surface-hover">
                    <ChevronLeftIcon className="w-4 h-4" />
                  </button>
                  <Poster item={{ id: picked.id, poster: list?.poster || picked.poster }} className="w-8 h-12 rounded-md shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-default truncate">{list?.name || picked.name || picked.id}</p>
                    {list && <p className="text-[11px] text-subtle">{watchedCount} of {list.episodes.length} episodes watched</p>}
                  </div>
                </div>

                {listError ? (
                  <p className="text-xs text-muted rounded-xl px-3 py-3" style={{ background: 'var(--color-surface-hover)' }}>{listError}</p>
                ) : !list ? (
                  <div className="space-y-2">
                    <div className="h-7 rounded-lg bg-surface-hover animate-pulse" />
                    <div className="h-24 rounded-xl bg-surface-hover animate-pulse" />
                  </div>
                ) : (
                  <>
                    {/* Wraps onto more lines rather than scrolling sideways:
                        a long show's later seasons were cut off past the
                        popup's edge with no way to reach them. */}
                    {seasons.length > 1 && (
                      <div>
                        <p className="text-xs font-medium text-muted mb-1.5">Season</p>
                        <div className="flex flex-wrap gap-1.5">
                          {seasons.map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => setSeason(s)}
                              aria-pressed={season === s}
                              aria-label={`Season ${s}${seasonDone(s) ? ', all watched' : ''}`}
                              className={`relative min-w-[34px] h-7 px-2 rounded-full border text-xs tabular-nums transition-colors ${season === s ? 'border-primary bg-primary/15 text-default font-medium' : 'border-default text-subtle hover:text-default hover:bg-surface-hover'}`}
                            >
                              {s}
                              {seasonDone(s) && <CheckIcon className="absolute -top-1 -right-1 w-3.5 h-3.5 p-0.5 rounded-full bg-success text-black" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-8 gap-1 max-h-[200px] overflow-y-auto">
                      {inSeason.map((e) => {
                        const aired = isAired(e, now);
                        return (
                          <button
                            key={e.episode}
                            type="button"
                            disabled={!aired}
                            onClick={() => setTarget({ season: e.season, episode: e.episode })}
                            title={`E${e.episode}${e.title ? ` · ${e.title}` : ''}${!aired ? ' - not out yet' : e.watched ? ' - watched' : ''}`}
                            aria-label={`Episode ${e.episode}${e.watched ? ', watched' : ''}${!aired ? ', not out yet' : ''}`}
                            className={`relative aspect-square rounded-lg border text-xs tabular-nums transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${episodeStyle(e)}`}
                          >
                            {e.watched ? <CheckIcon className="w-3.5 h-3.5 mx-auto" /> : e.episode}
                          </button>
                        );
                      })}
                    </div>

                    <p className="text-[11px] text-subtle min-h-[16px]">
                      {targetEpisode
                        ? <>S{targetEpisode.season}E{targetEpisode.episode}{targetEpisode.title ? <span className="text-default"> · {targetEpisode.title}</span> : null}</>
                        : 'Tap the last episode they’ve seen. Tap a ticked one to un-tick it.'}
                    </p>

                    {toMark.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={startRun}
                        className="w-full px-3 py-2 rounded-xl text-xs font-medium bg-primary text-white disabled:opacity-40 transition-opacity"
                      >
                        Mark {toMark.length} episode{toMark.length === 1 ? '' : 's'} watched, up to here
                      </button>
                    )}
                    {targetEpisode?.watched && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={unmarkTarget}
                        className="w-full px-3 py-2 rounded-xl text-xs font-medium border border-default text-default hover:bg-surface-hover disabled:opacity-40 transition-colors"
                      >
                        Mark S{targetEpisode.season}E{targetEpisode.episode} not watched
                      </button>
                    )}
                    {!target && (
                      <div className="w-full px-3 py-2 rounded-xl text-xs text-center text-subtle border border-dashed border-default">Pick an episode</div>
                    )}
                    <p className="text-[11px] text-subtle -mt-1">
                      Added to their History{hasServer ? ' and their server' : ''}. Not counted as watch time. A run can be undone.
                    </p>
                  </>
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
