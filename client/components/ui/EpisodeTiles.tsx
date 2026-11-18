'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, PlayIcon } from '@heroicons/react/24/solid';
import { CalendarDaysIcon, FilmIcon } from '@heroicons/react/24/outline';
import { api, type SeriesSeason, type EpisodeResume } from '@/lib/api';
import { buildStremioAppUrl, buildNuvioAppUrl } from '@/lib/appLinks';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { TVFocusable } from '@/components/tv/TVFocusable';

type App = 'stremio' | 'nuvio';
const APP_NAME: Record<App, string> = { stremio: 'Stremio', nuvio: 'Nuvio' };

// Seasons longer than this show their first tiles, then "Show all".
const FIRST_TILES = 12;

// Air dates are days, stored as UTC midnight: read them as UTC so a day never
// shifts by a timezone.
const day = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const dateLong = (iso: string) => day(iso, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// This year: "Thu, Nov 19"; another year: "Jan 7, 2027".
const dateShort = (iso: string, today: string) => (iso.slice(0, 4) === today.slice(0, 4)
  ? day(iso, { weekday: 'short', month: 'short', day: 'numeric' })
  : day(iso, { month: 'short', day: 'numeric', year: 'numeric' }));

/**
 * One season of a show as tiles: each episode's picture, number, title,
 * length, air date and the start of its summary, with what's watched, what's
 * part-watched (and how much is left), what's next and what's still to come.
 * A tile opens to the whole summary and the apps to open that episode in.
 */
export function EpisodeTiles({ imdbId, season, episodes, runtime, resume, started, apps, isTV, aboveFocusKey }: {
  imdbId: string;
  season: number;
  episodes: SeriesSeason['episodes'];
  /** The show's usual length in minutes, when known. */
  runtime: number | null;
  /** Where someone here stopped partway through an episode of this show. */
  resume: EpisodeResume | null;
  /** Anyone here has watched some of this show (so "Up next" means something). */
  started: boolean;
  /** The apps an opened tile offers, first one leading. */
  apps: App[];
  isTV: boolean;
  /**
   * TV: where Up from the first tile goes (the season's pill). The remote
   * scores by centers, so on its own it skips the pills on the left for the
   * full-width header straight above.
   */
  aboveFocusKey?: string;
}) {
  const upTo = (direction: string) => {
    if (direction !== 'up' || !aboveFocusKey) return true;
    try { setFocus(aboveFocusKey); } catch {}
    return false;
  };
  const [open, setOpen] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [noPicture, setNoPicture] = useState<Record<number, true>>({});
  const [lengths, setLengths] = useState<Record<string, number>>({});
  const today = todayKey();

  // The parent keys this by season, so a new season starts closed, with its
  // first tiles and no lengths. Each episode's own length, when the account
  // has a TMDb key (else {}):
  useEffect(() => {
    let live = true;
    api.getEpisodeLengths(imdbId, season).then((r) => { if (live) setLengths(r.lengths || {}); }).catch(() => {});
    return () => { live = false; };
  }, [imdbId, season]);

  const view = useMemo(() => {
    const aired = (e: SeriesSeason['episodes'][number]) => !!e.released && e.released.slice(0, 10) <= today;
    const resumeHere = resume && resume.season === season ? resume.episode : null;
    const soon = episodes.filter((e) => !aired(e));
    const upNext = resumeHere == null && started ? episodes.find((e) => aired(e) && !e.watched)?.episode ?? null : null;
    const doneN = episodes.filter((e) => e.watched).length;
    return { aired, resumeHere, soon, upNext, doneN };
  }, [episodes, resume, season, started, today]);

  const shown = showAll || episodes.length <= FIRST_TILES ? episodes : episodes.slice(0, FIRST_TILES);
  const next = view.soon[0];

  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted mx-0.5 mb-2.5">
        <span><b className="text-default font-semibold">Season {season}</b> · {episodes.length} episode{episodes.length === 1 ? '' : 's'}</span>
        {runtime ? <span>about {runtime} min each</span> : null}
        {view.doneN > 0 && <span>{view.doneN} of {episodes.length - view.soon.length} watched</span>}
        {next && <span className="text-primary">E{next.episode} {next.released ? `airs ${dateShort(next.released, today)}` : 'is coming'}</span>}
      </p>
      <ul className="flex flex-col gap-1">
        {shown.map((e, i) => {
          const soon = !view.aired(e);
          const isOpen = open === e.episode;
          const resumeHere = view.resumeHere === e.episode && resume ? resume : null;
          const length = lengths[String(e.episode)] || runtime;
          const tag = soon
            ? <Tag soon>{e.released ? dateShort(e.released, today) : 'Coming'}</Tag>
            : resumeHere ? <Tag>Resume</Tag> : view.upNext === e.episode ? <Tag>Up next</Tag> : null;
          const toggle = () => setOpen(isOpen ? null : e.episode);

          const tile = (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={isOpen}
              className={`relative w-full grid text-left rounded-[14px] ${isTV ? 'grid-cols-[236px_1fr] gap-4 p-2' : 'grid-cols-[120px_1fr] gap-3 p-1.5 sm:grid-cols-[172px_1fr] sm:gap-4 sm:p-2'} ${isOpen ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}
            >
              <span className="relative block aspect-video rounded-[10px] overflow-hidden self-start" style={{ background: 'color-mix(in srgb, var(--color-text) 6%, var(--color-surface))' }}>
                {/* The icon only stands in for a missing picture: a dimmed
                    upcoming picture would let it show through. */}
                {(!e.thumbnail || noPicture[e.episode]) && (
                  <span className="absolute inset-0 grid place-items-center text-muted opacity-70">
                    {soon ? <CalendarDaysIcon className="w-[22px] h-[22px]" /> : <FilmIcon className="w-[22px] h-[22px]" />}
                  </span>
                )}
                {e.thumbnail && !noPicture[e.episode] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={e.thumbnail}
                    alt=""
                    loading="lazy"
                    onError={() => setNoPicture((m) => ({ ...m, [e.episode]: true }))}
                    className={`absolute inset-0 w-full h-full object-cover ${soon ? 'opacity-40 grayscale-[40%]' :e.watched ? 'opacity-[.72]' : ''}`}
                  />
                )}
                <span className="absolute left-1.5 bottom-1.5 text-[11px] font-bold text-white bg-black/60 px-[7px] py-px rounded-full">E{e.episode}</span>
                {e.watched && (
                  <span className="absolute right-1.5 top-1.5 w-5 h-5 rounded-full grid place-items-center shadow" style={{ background: 'var(--color-success)' }}>
                    <CheckIcon className="w-3 h-3 text-white" />
                  </span>
                )}
                {resumeHere && (
                  <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/20">
                    <span className="block h-full" style={{ width: `${resumeHere.progressPercent}%`, background: 'var(--color-primary)' }} />
                  </span>
                )}
              </span>
              <span className="block min-w-0">
                <span className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-0.5 min-w-0">
                  <span className={`font-semibold text-default min-w-0 line-clamp-2 sm:line-clamp-1 ${isTV ? 'text-[17px]' : 'text-sm'}`}>{e.title || `Episode ${e.episode}`}</span>
                  {tag}
                </span>
                <span className={`block text-muted mt-0.5 ${isTV ? 'text-sm' : 'text-xs'}`}>
                  {soon
                    ? <>Airs {e.released ? dateLong(e.released) : 'later'}</>
                    : <>
                      {length ? `${length} min` : null}
                      {resumeHere && <>{length ? ' · ' : ''}<span className="text-primary">{resumeHere.remainingMinutes} min left</span></>}
                      {e.released && <>{length || resumeHere ? ' · ' : ''}{isTV ? dateLong(e.released) : <><span className="sm:hidden">{dateShort(e.released, today)}</span><span className="hidden sm:inline">{dateLong(e.released)}</span></>}</>}
                    </>}
                </span>
                {/* line-clamp brings its own display; a "block" beside it wins and nothing is cut. */}
                {(e.overview || soon) && (
                  <span className={`text-muted mt-1 leading-[1.45] ${isTV ? 'text-[15px]' : 'text-[13px]'} ${isOpen ? 'block' : 'line-clamp-2'}`}>
                    {e.overview || 'No summary yet.'}
                  </span>
                )}
              </span>
            </button>
          );

          return (
            <li key={`${season}-${e.episode}`}>
              {isTV ? <TVFocusable ringInside onEnterPress={toggle} onArrowPress={i === 0 ? upTo : undefined}>{tile}</TVFocusable> : tile}
              {isOpen && !soon && (
                <div className={`flex flex-wrap gap-2 pt-1 pb-2 pr-2 ${isTV ? 'pl-[260px]' : 'pl-[138px] sm:pl-[196px]'}`}>
                  {apps.map((a, i) => {
                    // Nuvio's link opens the show, not one episode (its app takes no episode).
                    const href = a === 'stremio' ? buildStremioAppUrl(imdbId, 'series', season, e.episode) : buildNuvioAppUrl(imdbId, 'series');
                    const link = (
                      <a
                        href={href}
                        tabIndex={isTV ? -1 : undefined}
                        className={`inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-[10px] ${i === 0 ? 'text-white bg-primary-solid' : 'text-default'}`}
                        style={i === 0 ? undefined : { background: 'color-mix(in srgb, var(--color-text) 10%, transparent)' }}
                      >
                        <PlayIcon className="w-3.5 h-3.5" />
                        {/* One piece, so the link's gap doesn't land between its words. */}
                        <span>
                          {a === 'stremio'
                            ? <>Open <span className={isTV ? '' : 'hidden sm:inline'}>S{season} E{e.episode} </span>in Stremio</>
                            : <>Open in {APP_NAME[a]}</>}
                        </span>
                      </a>
                    );
                    return isTV
                      ? <TVFocusable key={a} onEnterPress={() => { window.location.href = href; }}>{link}</TVFocusable>
                      : <span key={a}>{link}</span>;
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {shown.length < episodes.length && (
        isTV
          ? <TVFocusable onEnterPress={() => setShowAll(true)} className="inline-block mt-1.5"><MoreButton n={episodes.length} onClick={() => setShowAll(true)} /></TVFocusable>
          : <MoreButton n={episodes.length} onClick={() => setShowAll(true)} />
      )}
    </div>
  );
}

function Tag({ soon = false, children }: { soon?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`shrink-0 text-[11px] font-bold px-2 py-px rounded-full ${soon ? 'text-muted' : 'text-primary'}`}
      style={{ background: soon ? 'color-mix(in srgb, var(--color-text) 8%, transparent)' : 'color-mix(in srgb, var(--color-primary) 16%, transparent)' }}
    >
      {children}
    </span>
  );
}

function MoreButton({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-1.5 mx-0.5 px-1 py-1.5 text-[13px] font-semibold text-primary">
      Show all {n} episodes
    </button>
  );
}
