'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from './Card';
import { Button } from './Button';
import { MediaDetailModal } from './MediaDetailModal';
import { HoverTrailerPreview } from './HoverTrailerPreview';
import { SparklesIcon, FilmIcon, TvIcon, TrophyIcon, ArrowPathIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { api, YearInReview, YearInReviewTitle } from '@/lib/api';
import { renderWrappedCard, downloadBlob } from '@/lib/wrappedCard';
import { toast } from '@/components/ui/Toast';

// Year in Review (roadmap #8): a "Wrapped"-style yearly summary card for the
// Metrics page. Read-only - it just visualizes what the metrics tables already
// hold. Self-fetching so the Metrics page only drops <YearInReviewCard/> in.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDuration(sec: number): string {
  if (!sec || sec < 60) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center px-3 py-2 rounded-lg bg-surface-hover">
      <p className="text-lg font-semibold text-default tabular-nums">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}

function TitleStrip({ titles, onOpen, badge }: {
  titles: YearInReviewTitle[];
  onOpen: (t: YearInReviewTitle) => void;
  badge: (t: YearInReviewTitle) => string;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {titles.map((t) => (
        <button key={t.id} type="button" onClick={() => onOpen(t)} className="flex-shrink-0 w-16 text-left">
          <div className="w-16 h-24 rounded-md overflow-hidden bg-surface-hover flex items-center justify-center">
            {t.poster ? (
              <HoverTrailerPreview itemId={t.id} itemType={t.type} className="w-full h-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.poster} alt="" className="w-full h-full object-cover" />
              </HoverTrailerPreview>
            ) : (
              t.type === 'series' ? <TvIcon className="w-5 h-5 text-subtle" /> : <FilmIcon className="w-5 h-5 text-subtle" />
            )}
          </div>
          <p className="text-[10px] text-muted truncate mt-0.5">{badge(t)}</p>
        </button>
      ))}
    </div>
  );
}

export function YearInReviewCard() {
  const now = new Date();
  const thisYear = now.getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<YearInReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<YearInReviewTitle | null>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!data || !data.hasData) return;
    setDownloading(true);
    try {
      const blob = await renderWrappedCard(data);
      downloadBlob(blob, `slicksync-wrapped-${data.year}.png`);
    } catch {
      toast.error('Failed to generate image');
    } finally {
      setDownloading(false);
    }
  };

  const load = useCallback((y: number) => {
    setLoading(true);
    api.getYearInReview(y)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(year); }, [year, load]);

  const years = [thisYear, thisYear - 1, thisYear - 2];
  const maxMonth = data ? Math.max(1, ...data.byMonth) : 1;

  return (
    <Card padding="lg" className="mb-6">
      <div className="flex items-center gap-2 mb-4">
        <SparklesIcon className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold font-display text-default">Year in Review</h3>
        {data && data.hasData && (
          <Button variant="ghost" size="sm" leftIcon={<ArrowDownTrayIcon className="w-4 h-4" />} onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Generating…' : 'Share'}
          </Button>
        )}
        <div className="ml-auto flex gap-1">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => setYear(y)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                y === year ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:text-default'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-40 rounded-lg bg-surface-hover animate-pulse" />
      ) : !data || !data.hasData ? (
        <p className="text-sm text-muted py-8 text-center">No watch activity recorded for {year} yet.</p>
      ) : (
        <div className="space-y-5">
          {/* Headline: total watch time + split */}
          <div>
            <p className="text-3xl font-bold text-default tabular-nums">{fmtDuration(data.totalWatchTimeSeconds)}</p>
            <p className="text-xs text-muted">
              watched in {year} · {fmtDuration(data.movieWatchTimeSeconds)} movies · {fmtDuration(data.seriesWatchTimeSeconds)} series
            </p>
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Movies" value={data.moviesWatched} />
            <Stat label="Finished" value={data.completedMovies} />
            <Stat label="Episodes" value={data.episodesWatched} />
            <Stat label="Shows" value={data.showsWatched} />
          </div>

          {/* Monthly bars. Each bar's height is a % of its immediate parent -
              that only resolves to something visible if the parent has a
              DEFINITE height (CSS spec: a percentage height inside a parent
              with no explicit height computes to nothing). The per-month
              column below used to be a bare flex-col with no height of its
              own, so every bar silently rendered at 0px regardless of the
              real value - h-full (inheriting the row's own h-20) plus
              justify-end anchors [bar, month-letter] as a group to the
              bottom, which is what actually makes the % height resolve. */}
          <div>
            <p className="text-xs font-medium text-muted mb-1.5">By month</p>
            <div className="flex items-end gap-1 h-20">
              {data.byMonth.map((s, i) => (
                <div key={i} className="flex-1 h-full flex flex-col items-center justify-end gap-1" title={`${MONTHS[i]}: ${fmtDuration(s)}`}>
                  <div
                    className={`w-full rounded-t ${i === data.busiestMonth ? 'bg-primary' : 'bg-primary/30'}`}
                    style={{ height: `${Math.max(4, (s / maxMonth) * 100)}%` }}
                  />
                  <span className="text-[9px] text-subtle">{MONTHS[i][0]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Top shows */}
          {data.topShows.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-1.5 flex items-center gap-1">
                <TrophyIcon className="w-3.5 h-3.5" /> Top shows
              </p>
              <TitleStrip titles={data.topShows} onOpen={setDetail} badge={(t) => `${t.episodeCount} ep`} />
            </div>
          )}

          {/* Most rewatched */}
          {data.mostRewatched.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-1.5 flex items-center gap-1">
                <ArrowPathIcon className="w-3.5 h-3.5" /> Most rewatched
              </p>
              <TitleStrip titles={data.mostRewatched} onOpen={setDetail} badge={(t) => `${(t.rewatchCount || 0) + 1}×`} />
            </div>
          )}

          {/* Household leaderboard (only if more than one watcher) */}
          {data.perUser.length > 1 && (
            <div>
              <p className="text-xs font-medium text-muted mb-1.5">Who watched most</p>
              <div className="space-y-1.5">
                {data.perUser.slice(0, 6).map((u, i) => (
                  <div key={u.userId} className="flex items-center gap-2">
                    <span className="text-xs text-subtle w-4 tabular-nums">{i + 1}</span>
                    <span className="text-sm text-default flex-1 min-w-0 truncate">{u.username}</span>
                    <div className="flex-1 h-2 rounded-full bg-surface-hover overflow-hidden max-w-[40%]">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${(u.seconds / (data.perUser[0].seconds || 1)) * 100}%` }} />
                    </div>
                    <span className="text-xs text-muted tabular-nums w-16 text-right">{fmtDuration(u.seconds)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster || undefined}
        />
      )}
    </Card>
  );
}
