'use client';

// Metrics in the v2 page design: each tab as plain sections (a strip of
// numbers, then boxes and rows) with one status in words wherever a thing can
// be well or not. The Users, Content and Admin tabs keep their sections
// arrangeable (same page ids and keys as Classic); Health is one page of
// parts, each saying whether it works, with the ignore buttons kept on the
// part they belong to.

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { Badge, UserAvatar, YearInReviewCard } from '@/components/ui';
import { ScrollRow } from '@/components/ui/ScrollRow';
import { ArrangeGrid, ArrangePanel, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { AtRiskUser, HealthStatus, MetricsData, TasteOverlapPair, TasteProfile } from '@/lib/api';
import {
  AddonPerformanceCard,
  BingeWatchesSection,
  HourlyHeatmap,
  ServerHealthDashboard,
  TopItemsSection,
  UserLifecycleCard,
} from '@/components/admin';
import { V2Box, V2Numbers, V2Tiles, v2HiddenNumbers, type V2NumberItem } from './V2Detail';
import { V2Button, V2Status, type V2Tone } from './V2Bits';

/** Minutes the way v2 words them: "42 min", "6 h 05 min". */
export function metricsWatched(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

const TRAY_LABELS: Record<string, string> = {
  hero: 'Watch time',
  members: 'Members',
  recap: 'Recap',
  taste: 'Taste profiles',
  overlap: 'Taste overlap',
  numbers: 'Numbers',
  top: 'Top titles',
  engagement: 'When people watch',
  joins: 'Joined over time',
  lifecycle: 'Who might drift away',
  health: 'Server health',
  addons: 'Addons',
};
const labelOf = (id: string) => TRAY_LABELS[id] || id;

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted py-6 text-center">{children}</p>;
}

/** A plain heading for a part of a page that isn't arranged. */
function Heading({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0 mb-3">
      <div className="min-w-0 flex items-baseline gap-2.5 flex-wrap">
        <h2 className="text-lg font-semibold truncate">{title}</h2>
        {meta && <span className="text-muted text-[13px]">{meta}</span>}
      </div>
      <span className="flex-1" />
      {actions}
    </div>
  );
}

/* ---------------------------------------------------------------- Users */

export type MetricsMember = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
  useGravatar?: boolean;
  /** Minutes watched in the period. */
  watchTime: number;
  movies: number;
  series: number;
  streak: number;
};

type UsersProps = {
  arrange: PageArrange;
  isLoading: boolean;
  /** "last 30 days", "all time". */
  periodMeta: string;
  /** "Watched in 30 days", "Watched, all time". */
  periodLabel: string;
  totalMinutes: number;
  trend?: { direction: 'up' | 'down'; percentage: number };
  watchingNow: number;
  avgMinutes: number;
  bestStreak: number;
  members: MetricsMember[];
  /** The watch-time chart, already holding its own loading and empty words. */
  chart: ReactNode;
  tasteProfiles: TasteProfile[];
  tasteOverlap: TasteOverlapPair[];
};

export function MetricsUsersV2({ arrange, isLoading, periodMeta, periodLabel, totalMinutes, trend, watchingNow, avgMinutes, bestStreak, members, chart, tasteProfiles, tasteOverlap }: UsersProps) {
  const top = Math.max(1, ...members.map((m) => m.watchTime));
  const avatar = (u: { id: string; username: string; email?: string; avatarUrl?: string | null; useGravatar?: boolean }, size: 'xs' | 'sm' | 'md' = 'sm') => (
    <UserAvatar userId={u.id} name={u.username} email={u.email} src={u.useGravatar ? undefined : (u.avatarUrl ?? undefined)} useGravatar={u.useGravatar} size={size} className="shrink-0" />
  );
  const numberItems: V2NumberItem[] = [
                  {
                    label: periodLabel,
                    value: isLoading ? '…' : metricsWatched(totalMinutes),
                    sub: trend && trend.percentage > 0 ? `${trend.direction === 'up' ? '+' : '-'}${trend.percentage}% on the time before` : undefined,
                  },
                  { label: 'Watching now', value: isLoading ? '…' : String(watchingNow) },
                  { label: 'Each, on average', value: isLoading ? '…' : metricsWatched(avgMinutes) },
                  { label: 'Best streak', value: isLoading ? '…' : `${bestStreak} ${bestStreak === 1 ? 'day' : 'days'}` },
                ];
  const hiddenNumbers = v2HiddenNumbers(arrange, numberItems, 'hero');
  return (
    <ArrangeGrid>
      {arrange.shown.map((id) => {
        switch (id) {
          case 'hero':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Watch time" meta={periodMeta}>
                <V2Numbers arrange={arrange} scope="hero" items={numberItems} />
                <V2Box className="mt-3">
                  <div className="h-40 md:h-56">{chart}</div>
                </V2Box>
              </ArrangeSection>
            );
          case 'members':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Members" meta={String(members.length)}>
                <V2Box>
                  {isLoading ? <Empty>Loading…</Empty> : members.length === 0 ? <Empty>No watch activity in this period.</Empty> : (
                    <div>
                      {members.map((m) => (
                        <div key={m.id} className="flex items-center gap-3 py-2" title={`${m.movies} movies · ${m.series} shows`}>
                          {avatar({ id: m.id, username: m.name, email: m.email, avatarUrl: m.avatarUrl, useGravatar: m.useGravatar })}
                          <b className="w-[84px] sm:w-[110px] truncate text-[14px]">{m.name}</b>
                          <div className="flex-1 min-w-0 h-2.5 rounded-full bg-surface-hover">
                            <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.round((m.watchTime / top) * 100))}%`, background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }} />
                          </div>
                          <span className="text-muted text-[13px] text-right shrink-0 sm:w-[170px]">
                            {metricsWatched(m.watchTime)}
                            <span className="max-sm:hidden">{m.streak > 0 ? ` · ${m.streak}-day streak` : ''}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </V2Box>
              </ArrangeSection>
            );
          case 'recap':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Recap" meta="the year in one card">
                <YearInReviewCard />
              </ArrangeSection>
            );
          case 'taste':
            if (tasteProfiles.length === 0) return null;
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Taste" meta="what each person leans to" cards>
                <V2Tiles wide={2} stretch={{ arrange: arrange, id: id }}>
                  {tasteProfiles.map((p) => {
                    const mins = Math.round(p.totalSeconds / 60);
                    return (
                      <V2Box key={p.user.id} className="flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                          {avatar(p.user, 'md')}
                          <div className="min-w-0">
                            <p className="font-semibold text-default truncate">{p.user.username}</p>
                            <p className="text-xs text-muted">{metricsWatched(mins)} · {p.movieCount} movies · {p.seriesCount} shows</p>
                          </div>
                        </div>
                        {p.topGenres.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {p.topGenres.map((g) => (
                              <span key={g.genre} className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-primary-muted text-primary">{g.genre}</span>
                            ))}
                          </div>
                        )}
                        {p.topTitles.length > 0 && (
                          <ScrollRow className="flex gap-2 pb-1">
                            {p.topTitles.map((t) => (
                              <div key={t.key} title={t.name} className="w-14 shrink-0">
                                <div className="w-14 h-20 rounded-lg overflow-hidden bg-surface-hover border border-default">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  {t.poster && <img src={t.poster} alt={t.name} className="w-full h-full object-cover" />}
                                </div>
                                <p className="text-[10px] text-muted mt-1 truncate">{t.name}</p>
                              </div>
                            ))}
                          </ScrollRow>
                        )}
                        {p.tasteTwin && (
                          <div className="flex items-center gap-2 pt-2 border-t border-default mt-auto">
                            <span className="text-xs text-muted">Closest match</span>
                            {avatar(p.tasteTwin.user, 'xs')}
                            <span className="text-xs font-medium text-default truncate">{p.tasteTwin.user.username}</span>
                            <Badge variant="primary" size="sm">{p.tasteTwin.similarity}%</Badge>
                          </div>
                        )}
                      </V2Box>
                    );
                  })}
                </V2Tiles>
              </ArrangeSection>
            );
          case 'overlap':
            if (tasteOverlap.length === 0) return null;
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Taste overlap" meta="shared watch time between members">
                <div className="space-y-3">
                  {tasteOverlap.map((pair) => (
                    <V2Box key={`${pair.userA.id}-${pair.userB.id}`}>
                      <div className="flex items-center gap-3 mb-3 flex-wrap">
                        {avatar(pair.userA)}
                        <span className="text-sm font-medium text-default truncate">{pair.userA.username}</span>
                        <Badge variant="primary">{pair.similarity}% overlap</Badge>
                        <span className="text-sm font-medium text-default truncate">{pair.userB.username}</span>
                        {avatar(pair.userB)}
                      </div>
                      <ScrollRow className="flex gap-2 pb-1">
                        {pair.shared.map((item) => (
                          <div key={item.key} title={item.name || undefined} className="w-16 shrink-0">
                            <div className="w-16 h-24 rounded-lg overflow-hidden bg-surface-hover border border-default">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {item.poster && <img src={item.poster} alt={item.name || ''} className="w-full h-full object-cover" />}
                            </div>
                            <p className="text-xs text-muted mt-1 truncate">{item.name}</p>
                          </div>
                        ))}
                      </ScrollRow>
                    </V2Box>
                  ))}
                </div>
              </ArrangeSection>
            );
          default:
            return null;
        }
      })}
      <HiddenTray arrange={arrange} labelOf={labelOf} extra={hiddenNumbers} />
    </ArrangeGrid>
  );
}

/* -------------------------------------------------------------- Content */

export function MetricsContentV2({ arrange, isLoading, error, periodKey, data, contentChart }: {
  arrange: PageArrange;
  isLoading: boolean;
  error: boolean;
  /** Resets the lists inside when the period changes. */
  periodKey: string;
  data: MetricsData | null;
  /** The movies-and-shows chart, already holding its own loading and empty words. */
  contentChart: ReactNode;
}) {
  const admin = data?.admin;
  const movies = data?.summary?.totalMovies || 0;
  const shows = data?.summary?.totalShows || 0;
  const share = movies + shows > 0 ? Math.round((movies / (movies + shows)) * 100) : 0;
  const mostWatched = admin?.topItems?.series?.[0]?.name;
  const numberItems: V2NumberItem[] = [
                  { label: 'Movies watched', value: isLoading ? '…' : String(movies) },
                  { label: 'Shows watched', value: isLoading ? '…' : String(shows) },
                  { label: 'Most watched', value: isLoading ? '…' : (mostWatched || 'N/A') },
                  { label: 'Binge sessions', value: isLoading ? '…' : String(admin?.interestingMetrics?.totalBingeSessions || 0) },
                ];
  const hiddenNumbers = v2HiddenNumbers(arrange, numberItems, 'numbers');
  return (
    <ArrangeGrid>
      {arrange.shown.map((id) => {
        switch (id) {
          case 'numbers':
            return (
              <ArrangePanel key={id} arrange={arrange} id={id} label="Numbers" ownHeading={false}>
                <V2Numbers arrange={arrange} scope="numbers" items={numberItems} />
              </ArrangePanel>
            );
          case 'top':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Top titles" meta="most watched, and the binges">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <V2Box>
                    <b className="block mb-3">Most watched</b>
                    {admin?.topItems ? (
                      <TopItemsSection key={periodKey} movies={admin.topItems.movies} series={admin.topItems.series} />
                    ) : <Empty>No top items data available</Empty>}
                  </V2Box>
                  <V2Box>
                    <b className="block mb-3">Binges</b>
                    {admin?.watchVelocity ? (
                      <BingeWatchesSection key={periodKey} items={admin.watchVelocity} />
                    ) : <Empty>No binge watch data available</Empty>}
                  </V2Box>
                </div>
              </ArrangeSection>
            );
          case 'engagement':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="When people watch" meta="by hour, and movies against shows">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <V2Box>
                    <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
                      <b>By hour</b>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">Average session {admin?.engagement?.averageSessionMinutes || 0} min</Badge>
                        <Badge variant="secondary">Binges {admin?.engagement?.bingeSessions || 0}</Badge>
                      </div>
                    </div>
                    {admin?.engagement && (
                      <HourlyHeatmap hourlyActivity={admin.engagement.hourlyActivity} peakHour={admin.engagement.peakHour} />
                    )}
                  </V2Box>
                  <V2Box>
                    <b className="block mb-3">Movies and shows</b>
                    <div className="flex h-3.5 rounded-full overflow-hidden" style={{ background: 'var(--color-chart-2)' }}>
                      <span style={{ width: `${share}%`, background: 'var(--color-chart-1)' }} />
                    </div>
                    <div className="text-muted text-[13px] mt-2 mb-4">Movies {share}% · Shows {movies + shows > 0 ? 100 - share : 0}%</div>
                    <div className="h-40 md:h-52">
                      {error ? <div className="flex items-center justify-center h-full text-sm text-muted">Failed to load data</div> : contentChart}
                    </div>
                  </V2Box>
                </div>
              </ArrangeSection>
            );
          default:
            return null;
        }
      })}
      <HiddenTray arrange={arrange} labelOf={labelOf} extra={hiddenNumbers} />
    </ArrangeGrid>
  );
}

/* ---------------------------------------------------------------- Admin */

export function MetricsAdminV2({ arrange, isLoading, data, joinsChart, joinsTotal }: {
  arrange: PageArrange;
  isLoading: boolean;
  data: MetricsData | null;
  /** The joins chart, drawn only when there are joins. */
  joinsChart: ReactNode;
  joinsTotal: number;
}) {
  const router = useRouter();
  const admin = data?.admin;
  const im = admin?.interestingMetrics;
  const drifting: AtRiskUser[] = admin?.userLifecycle ? [...admin.userLifecycle.criticalRisk, ...admin.userLifecycle.atRisk] : [];
  const driftWords = (u: AtRiskUser): { tone: V2Tone; words: string } => (
    u.neverWatched ? { tone: 'bad', words: 'Never watched' }
      : { tone: u.daysInactive >= 60 ? 'bad' : 'warn', words: `Quiet ${u.daysInactive} days` }
  );
  const health = admin?.serverHealth;
  const healthTone: V2Tone = health?.status === 'healthy' ? 'ok' : health?.status === 'warning' ? 'warn' : health?.status ? 'bad' : 'off';
  const healthWords = health?.status === 'healthy' ? 'Healthy' : health?.status === 'warning' ? 'Needs a look' : health?.status ? 'Needs a fix' : 'Unknown';
  const numberItems: V2NumberItem[] = [
                  { label: 'Busiest hour', value: isLoading ? '…' : `${im?.mostActiveHour || 0}:00` },
                  { label: 'Watched at weekends', value: isLoading ? '…' : `${(im?.weekendWatchPercentage || 0).toFixed(1)}%` },
                  { label: 'Finished what they started', value: isLoading ? '…' : `${(im?.completionRate || 0).toFixed(1)}%` },
                  { label: 'Average session', value: isLoading ? '…' : metricsWatched(Math.round(im?.avgSessionDuration || 0)) },
                ];
  const hiddenNumbers = v2HiddenNumbers(arrange, numberItems, 'numbers');
  return (
    <ArrangeGrid>
      {arrange.shown.map((id) => {
        switch (id) {
          case 'numbers':
            return (
              <ArrangePanel key={id} arrange={arrange} id={id} label="Numbers" ownHeading={false}>
                <V2Numbers arrange={arrange} scope="numbers" items={numberItems} />
              </ArrangePanel>
            );
          case 'joins':
            if (!data?.userJoins?.byDay || data.userJoins.byDay.length === 0) return null;
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Joined over time" meta={`${joinsTotal} new in total`}>
                <V2Box>
                  <div className="h-40 md:h-56">{joinsChart}</div>
                </V2Box>
              </ArrangeSection>
            );
          case 'lifecycle':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Who might drift away" meta={String(drifting.length)}>
                <div className="v2-list">
                  {drifting.length === 0 ? <Empty>No one is drifting away. Everyone is active.</Empty> : drifting.map((u) => {
                    const st = driftWords(u);
                    return (
                      <div key={u.id} className="v2-row">
                        <UserAvatar userId={u.id} name={u.username} email={u.email} size="md" />
                        <div className="flex-1 min-w-0">
                          <b className="text-default truncate block">{u.username}</b>
                          <div className="text-muted text-[12.5px] sm:truncate">{u.lastActivity ? `last watched ${new Date(u.lastActivity).toLocaleDateString()}` : u.email}</div>
                          {/* On a phone the status sits under the name, so the date isn't cut off. */}
                          <div className="sm:hidden mt-1"><V2Status tone={st.tone}>{st.words}</V2Status></div>
                        </div>
                        <span className="max-sm:hidden"><V2Status tone={st.tone}>{st.words}</V2Status></span>
                        <V2Button onClick={() => router.push(`/users/${u.id}`)}>Open</V2Button>
                      </div>
                    );
                  })}
                </div>
                {admin?.userLifecycle && (
                  <V2Box className="mt-4">
                    <b className="block mb-3">Keeping people</b>
                    <UserLifecycleCard lifecycle={admin.userLifecycle} userJoins={data?.userJoins?.byDay || []} />
                  </V2Box>
                )}
              </ArrangeSection>
            );
          case 'health':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Server health" actions={<V2Status tone={healthTone}>{healthWords}</V2Status>}>
                <V2Box>
                  {health ? <ServerHealthDashboard status={health.status} checks={health.checks} metrics={health.metrics} /> : <Empty>Nothing to show yet.</Empty>}
                </V2Box>
              </ArrangeSection>
            );
          case 'addons':
            return (
              <ArrangeSection key={id} arrange={arrange} id={id} title="Addons" meta={`${admin?.addonAnalytics?.totalAddons || 0} in all`}>
                <V2Box>
                  {admin?.addonAnalytics ? (
                    <AddonPerformanceCard
                      totalAddons={admin.addonAnalytics.totalAddons}
                      activeAddons={admin.addonAnalytics.activeAddons}
                      topAddons={admin.addonAnalytics.topAddons}
                      byResource={admin.addonAnalytics.byResource}
                    />
                  ) : <Empty>Nothing to show yet.</Empty>}
                </V2Box>
              </ArrangeSection>
            );
          default:
            return null;
        }
      })}
      <HiddenTray arrange={arrange} labelOf={labelOf} extra={hiddenNumbers} />
    </ArrangeGrid>
  );
}

/* --------------------------------------------------------------- Health */

export type MetricsHealthPart = {
  key: string;
  title: string;
  tone: V2Tone;
  words: string;
  line: string;
  /** What to do or see about it (issues with their ignore buttons, ignored items); drawn under the part when present. */
  body?: ReactNode;
};

export function MetricsHealthV2({ health, parts, refreshing, onRefresh, timeAgo, extra }: {
  health: HealthStatus;
  parts: MetricsHealthPart[];
  refreshing: boolean;
  onRefresh: () => void;
  timeAgo: (iso: string | null) => string;
  /** Under everything else (the database size). */
  extra?: ReactNode;
}) {
  const well = health.overall === 'healthy';
  return (
    <div className="space-y-6">
      <V2Box className="flex items-center gap-4 flex-wrap">
        <span className="shrink-0 rounded-full" style={{ width: 14, height: 14, background: well ? 'var(--color-success, #22c55e)' : 'var(--color-warning, #f59e0b)', boxShadow: `0 0 0 6px color-mix(in srgb, ${well ? 'var(--color-success, #22c55e)' : 'var(--color-warning, #f59e0b)'} 20%, transparent)` }} />
        <div className="flex-1 min-w-[180px]">
          <div className="text-[20px] font-bold">{well ? 'Everything is working' : 'Something needs a look'}</div>
          <div className="text-muted text-[13px]">Checked {timeAgo(health.checkedAt)}{well ? '' : ' · the parts below show what to fix'}</div>
        </div>
        <V2Button onClick={onRefresh} disabled={refreshing} icon={<ArrowPathIcon className={`w-4 h-4${refreshing ? ' animate-spin' : ''}`} />}>
          {refreshing ? 'Checking' : 'Check now'}
        </V2Button>
      </V2Box>

      <section aria-label="Parts">
        <Heading title="Parts" meta={String(parts.length)} />
        <div className="v2-list">
          {parts.map((p) => (
            <div key={p.key} className="border-t border-default first:border-t-0">
              <div className="v2-row" style={{ borderTop: 0 }}>
                <div className="flex-1 min-w-0">
                  <b className="text-default block">{p.title}</b>
                  <div className="text-muted text-[12.5px] break-words">{p.line}</div>
                </div>
                <V2Status tone={p.tone}>{p.words}</V2Status>
              </div>
              {p.body && <div className="px-4 pb-3">{p.body}</div>}
            </div>
          ))}
        </div>
      </section>

      {health.timeline.length > 0 && (
        <section aria-label="Incidents">
          <Heading title="Incidents" meta="most recent first" />
          <div className="v2-list max-h-80 overflow-y-auto">
            {health.timeline.map((e) => (
              <div key={e.id} className="v2-row">
                <V2Status tone={e.status === 'up' ? 'ok' : 'bad'}>{e.status === 'up' ? 'Fixed' : 'Down'}</V2Status>
                <div className="flex-1 min-w-0">
                  <b className="text-default block truncate">{e.title}</b>
                  {e.detail && <div className="text-muted text-[12.5px] break-words">{e.detail}</div>}
                </div>
                <span className="text-muted text-[12.5px] shrink-0 capitalize">{e.source}</span>
                <span className="text-muted text-[12.5px] shrink-0" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {health.mismatchCount > 0 && (
        <V2Box>
          <V2Status tone="warn">{health.mismatchCount} title{health.mismatchCount !== 1 ? 's' : ''} streamed but not recorded</V2Status>
          <div className="text-muted text-[13px] mt-1">No connected account recorded {health.mismatchCount === 1 ? 'it' : 'them'}. The notification bell has the details.</div>
        </V2Box>
      )}

      {extra}
    </div>
  );
}
